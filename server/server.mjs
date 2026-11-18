#!/usr/bin/env node
/*
 * SURE Walk Texts — the texting server on this computer.
 *
 *   Excel rides sheet ──(Excel panel posts rides/changes)──▶ GroupMe sync chat ──▶ this server ──▶ BlueFerry ──▶ UT iPhone
 *                     ◀──(panel writes Call Time, cancels…)── GroupMe sync chat ◀──
 *
 * It runs the SURE Walk Texts code (texting/apps-script/*.gs, unchanged) with local stand-ins for Google's services
 * (gas.js). The dashboard is http://127.0.0.1:8787 ; the bridge (surewalk_bridge) posts to /bridge.
 * Texts in and out, the log and the settings stay on this computer: the chat only ever gets sheet values.
 *
 *   node server/server.mjs [--open]       run (and open the dashboard in the browser)
 *   node server/server.mjs link-bridge    point the phone bridge at this server (keeps a copy of its old config)
 * Env: PORT (8787), SUREWALK_GS (the .gs folder), SUREWALK_STATE (~/.local/state/surewalk-texts; Windows: %LOCALAPPDATA%\surewalk-texts).
 */
process.env.TZ = 'America/Chicago';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWP = require('../protocol.js');
const gasLib = require('./gas.js');

const PORT = Number(process.env.PORT || 8787);
const HOME = os.homedir();
const GS = process.env.SUREWALK_GS || path.join(HOME, 'Documents/surewalk/texting/apps-script');
const WIN = process.platform === 'win32'; // Windows: everything under %LOCALAPPDATA% (no admin, per user)
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const STATE = process.env.SUREWALK_STATE || (WIN ? path.join(LOCAL, 'surewalk-texts') : path.join(process.env.XDG_STATE_HOME || path.join(HOME, '.local/state'), 'surewalk-texts'));
const CONF_FILE = WIN ? path.join(LOCAL, 'surewalk-texts', 'config.json') : path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'surewalk-texts', 'config.json');
const GM_API = process.env.GROUPME_API || 'https://api.groupme.com/v3';
const POLL_MS = Number(process.env.SW_POLL_MS || 3000), POST_GAP_MS = Number(process.env.SW_POST_GAP_MS || 1200);
const log = (...a) => console.log(new Date().toLocaleTimeString('en-US', { hour12: false }), ...a);

/* ---------------- config (GroupMe token + chat) ---------------- */
function loadConf() { try { return JSON.parse(fs.readFileSync(CONF_FILE, 'utf8')); } catch (e) { return {}; } }
function saveConf(c) {
  fs.mkdirSync(path.dirname(CONF_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONF_FILE + '.tmp', JSON.stringify(c, null, 2), { mode: 0o600 });
  fs.renameSync(CONF_FILE + '.tmp', CONF_FILE);
}
let conf = loadConf();

/* ---------------- the texting code ---------------- */
const store = { rides: {}, ver: 0 };
const gas = gasLib.install(STATE, store);
function loadCode() {
  const files = ['Build.gs', 'Places.gs', 'Rides.gs', 'Texts.gs', 'Bridge.gs', 'Code.gs'].filter(f => fs.existsSync(path.join(GS, f)));
  if (!files.includes('Code.gs')) throw new Error(`The SURE Walk Texts code isn't in ${GS} (set SUREWALK_GS).`);
  // Tests only: SW_SEND_GAP_MS=0 turns off the texting code's send pacing (one text every 6 s in real use).
  if (process.env.SW_SEND_GAP_MS != null) globalThis.SW_SEND_GAP_MS = Number(process.env.SW_SEND_GAP_MS);
  vm.runInThisContext(files.map(f => `;/* ${f} */\n` + fs.readFileSync(path.join(GS, f), 'utf8')).join('\n'), { filename: 'surewalk-texts.gs' });
  log('loaded', files.join(' '), 'from', GS);
}

/** First run: the log, the bridge key, Texting on / Auto-text off (setupTexts). */
function ensureSetup() {
  const P = PropertiesService.getScriptProperties();
  if (P.getProperty('TEXTS_SHEET_ID') !== gas.LOG_ID) P.deleteProperty('TEXTS_SHEET_ID'); // a Google log from before
  if (!P.getProperty('TX_KEY') || !P.getProperty('TEXTS_SHEET_ID')) { globalThis.setupTexts(); log('set up: local log + bridge key'); }
  gas.flush();
}

/* ---------------- GroupMe sync ---------------- */
const sync = { ready: false, lastId: '', lastPollAt: 0, lastError: '', lastExcelAt: 0, posted: 0, seen: new Set() };
const outFile = path.join(STATE, 'outbox.json');
let outLines = []; // lines waiting to be posted (survive a restart)
try { outLines = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (e) { /* none */ }
const saveOut = () => { fs.writeFileSync(outFile, JSON.stringify(outLines), { mode: 0o600 }); };

const cleanTok = s => String(s || '').trim()
  .replace(/^.*(?:x-access-token|access_token|token|bearer)[:=\s]+/i, '')
  .replace(/^["']|["'];?$/g, '')
  .trim();

async function gm(pathname, opts = {}) {
  const token = opts.token || conf.token;
  if (!token) throw new Error('No GroupMe token yet — open Settings ▸ GroupMe sync.');
  const url = new URL(GM_API + pathname);
  Object.entries(opts.query || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { method: opts.method || 'GET', headers: { 'X-Access-Token': token, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined, signal: AbortSignal.timeout(20000) });
  if (res.status === 304) return null;
  if (res.status === 401) throw new Error('GroupMe refused the token (signed out? paste a new one).');
  if (!res.ok) throw new Error(`GroupMe answered ${res.status}`);
  const j = await res.json().catch(() => ({}));
  return j.response;
}

function take(messages) { // chat messages (any order) -> fold their events into the rides
  let n = 0;
  messages.slice().sort((a, b) => a.created_at - b.created_at || (BigInt(a.id) < BigInt(b.id) ? -1 : 1)).forEach(m => {
    if (sync.seen.has(m.id)) return;
    sync.seen.add(m.id);
    if (!sync.lastId || BigInt(m.id) > BigInt(sync.lastId)) sync.lastId = m.id;
    SWP.parse(m.text).forEach(ev => {
      SWP.fold(store, ev, m.created_at * 1000);
      if (ev.src !== 's') sync.lastExcelAt = Math.max(sync.lastExcelAt, m.created_at * 1000);
      n++;
    });
  });
  if (n) { store.ver++; gas.clearCache(); }
  return n;
}

async function backfill() { // tonight's chat history, newest page first
  const cutoff = Date.now() / 1000 - 20 * 3600, all = [];
  let before = '';
  for (let page = 0; page < 40; page++) {
    const r = await gm(`/groups/${conf.groupId}/messages`, { query: before ? { limit: 100, before_id: before } : { limit: 100 } });
    const ms = (r && r.messages) || [];
    all.push(...ms);
    if (ms.length < 100 || ms[ms.length - 1].created_at < cutoff) break;
    before = ms[ms.length - 1].id;
  }
  sync.seen.clear(); store.rides = {}; sync.lastId = '';
  const n = take(all.filter(m => m.created_at >= cutoff));
  if (!sync.lastId && all.length) sync.lastId = all[0].id;
  log(`GroupMe: read ${all.length} messages, ${n} ride events, ${Object.keys(store.rides).length} rides`);
}

async function poll() {
  for (let page = 0; page < 10; page++) {
    const r = await gm(`/groups/${conf.groupId}/messages`, { query: { after_id: sync.lastId, limit: 100 } });
    const ms = (r && r.messages) || [];
    if (!ms.length) break;
    take(ms);
    if (ms.length < 100) break;
  }
}

async function postPending() {
  if (!outLines.length) return;
  const msgs = SWP.pack(outLines.slice(0, 40));
  const text = msgs[0], used = text.split('\n').length;
  await gm(`/groups/${conf.groupId}/messages`, { method: 'POST', body: { message: { source_guid: crypto.randomUUID(), text } } });
  outLines.splice(0, used);
  saveOut();
  sync.posted++;
}

/** The sheet edits the texting code just made -> 'upd' events for the Excel panel. */
function shipChanges() {
  const ch = gas.takeChanges();
  if (!ch.length) return;
  const by = {};
  ch.forEach(c => { const e = by[c.id] || (by[c.id] = { e: 'upd', id: c.id, src: 's', f: {}, was: {} }); e.f[c.k] = c.now; e.was[c.k] = c.was; });
  Object.values(by).forEach(ev => {
    const r = store.rides[ev.id];
    ev.f.row = r && r.f.row; // helps the panel find it quickly (it checks the id too)
    outLines.push(SWP.line(ev, r && r.f));
    log('→ sheet', ev.id, JSON.stringify(ev.f));
  });
  saveOut();
}

/*
 * ＋ Ride from the dashboard: this server can't write the Excel sheet, so it asks the Excel panel (sync on) to add the
 * row ('add' event). The ride then comes back as a normal ride (texted like any other unless it was marked called).
 * adds = what we asked for, until the ride shows up (same phone, submitted since) or 30 min pass.
 */
const ADD_WAIT_MS = 30 * 60e3, adds = [];
const digits = s => String(s || '').replace(/\D/g, '');
const tonight = () => Object.values(store.rides).filter(r => SWP.nightOf(r.f.ts) === SWP.nightOf(SWP.austin()));
const isOpen = r => !(r.f.rsn && r.f.rsn !== '0') && !/^#(000000|ff0000)$/i.test(r.f.bg || '');
function addState(a) {
  const back = tonight().find(r => digits(r.f.phone).slice(-10) === a.phone10 && r.f.ts >= a.ts.slice(0, 16));
  if (back) return { state: 'added', row: back.f.row };
  return { state: Date.now() - a.at > ADD_WAIT_MS ? 'lost' : 'waiting' };
}
function requestAdd(b) {
  const t = k => String(b[k] == null ? '' : b[k]).replace(/^[=+@-]+/, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 150); // never a formula
  let phone = digits(b.phone);
  if (phone.length === 11 && phone.charAt(0) === '1') phone = phone.slice(1);
  const f = { first: t('first'), last: t('last'), phone, eid: t('eid'), email: t('email'), pu: t('pu'), do: t('do'), ada: /^y/i.test(b.ada) ? 'Yes' : 'No', notes: t('notes') };
  const miss = [['first', 'first name'], ['pu', 'pick-up'], ['do', 'drop-off']].filter(([k]) => !f[k]).map(x => x[1]);
  if (miss.length) return { ok: false, error: 'Fill in the ' + miss.join(', ') + '.' };
  if (phone.length !== 10) return { ok: false, error: 'The phone number needs 10 digits.' };
  if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) return { ok: false, error: "That email doesn't look right." };
  if (!conf.groupId || !sync.ready) return { ok: false, error: "GroupMe sync isn't running, so the Excel panel can't get the ride. Set it up first (GroupMe pill)." };
  if (!b.force) {
    const same = tonight().find(r => isOpen(r) && digits(r.f.phone).slice(-10) === phone);
    if (same) return { ok: false, dup: `${same.f.first || 'Someone'}${same.f.last ? ' ' + same.f.last : ''} already has an open ride tonight with that phone (row ${same.f.row}).` };
    const asked = adds.find(a => a.phone10 === phone && addState(a).state === 'waiting');
    if (asked) return { ok: false, dup: `You already asked to add a ride for that phone ${Math.round((Date.now() - asked.at) / 60e3)} min ago — it's still waiting for the Excel panel.` };
  }
  const ts = SWP.austin();
  if (b.called) { const w = new Date(); f.call = `${w.getHours()}:${String(w.getMinutes()).padStart(2, '0')}`; } // TZ is Austin
  const ev = { e: 'add', id: 'a' + crypto.randomBytes(4).toString('hex'), src: 's', f: Object.assign({ ts }, f) };
  outLines.push(SWP.line(ev)); saveOut();
  adds.push({ id: ev.id, first: f.first, phone10: phone, ts, at: Date.now(), f: ev.f }); // f: kept in memory only (the phone lookup's EID / email)
  if (adds.length > 50) adds.shift();
  log('→ add ride', ev.id, f.first, f.pu, '→', f.do);
  return { ok: true, id: ev.id };
}

let loopBusy = false, nextPostAt = 0;
async function loop() {
  if (loopBusy) return;
  loopBusy = true;
  try {
    if (!conf.token || !conf.groupId) { sync.ready = false; return; }
    if (!sync.ready) { await backfill(); sync.ready = true; }
    else await poll();
    if (Date.now() >= nextPostAt && outLines.length) { await postPending(); nextPostAt = Date.now() + POST_GAP_MS; }
    sync.lastPollAt = Date.now(); sync.lastError = '';
  } catch (e) {
    sync.lastError = String(e.message || e);
    log('GroupMe:', sync.lastError);
  } finally { loopBusy = false; }
}

/* ---------------- the "Confirmed" column: when each rider said YES to our text, for dispatchers ---------------- */
// H:MM of the rider's YES (the texting code's confirmedAt). Only the time: never what anyone wrote.
const hm = ms => { const d = new Date(ms); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; }; // TZ is Austin
const confirmTime = rec => (rec && (rec.confirmedAt || rec.state === 'confirmed') ? hm(rec.confirmedAt || rec.lastInAt || Date.now()) : '');
// The cell also holds the calling panel's "traveling together" group ("9:40 · Group A"): only the time is ours to set.
const cfGroup = s => (/\bGroup ([A-H])\b/.exec(String(s || '')) || [])[1] || '';
const cfJoin = (t, g) => [t, g ? 'Group ' + g : ''].filter(Boolean).join(' · ');
function syncTextStatus() {
  if (typeof globalThis.loadTx_ !== 'function') return;
  const tx = globalThis.loadTx_();
  const byRow = {};
  Object.values(store.rides).forEach(r => { const n = parseInt(r.f.row, 10); if (n) (byRow[n] = byRow[n] || []).push(r); });
  Object.values(tx.rides || {}).forEach(rec => {
    const t = confirmTime(rec);
    if (!t) return;
    const r = (byRow[rec.row] || []).find(x => String(x.f.phone || '').replace(/\D/g, '').slice(-10) === rec.phone10);
    if (!r) return;
    const want = cfJoin(t, cfGroup(r.f.txs));
    if (!SWP.same('txs', r.f.txs, want)) gas.setField(r.id, 'txs', want);
  });
}

/* ---------------- running the texting code ---------------- */
function run(fn) { // every entry into the .gs code: then the Confirmed times, ship its sheet edits and save
  try { return fn(); } finally { try { try { syncTextStatus(); } catch (e) { log('confirmed column:', e.message); } shipChanges(); } finally { gas.flush(); } }
}
const NOT_CALLABLE = new Set(['doGet', 'doPost', 'setupTexts']);
function rpc(name, args) {
  if (typeof name !== 'string' || !/^[a-zA-Z]\w*$/.test(name) || name.endsWith('_') || NOT_CALLABLE.has(name) || typeof globalThis[name] !== 'function' || !Object.hasOwn(globalThis, name)) {
    throw new Error('Unknown action: ' + name);
  }
  if (!sync.ready && name === 'getState' && conf.groupId) { /* still reading the chat: show what we have */ }
  const out = run(() => globalThis[name](...(Array.isArray(args) ? args : [])));
  if (out && typeof out === 'object') {
    if ('sheetUrl' in out) out.sheetUrl = '/log.csv';
    if ('pollUrl' in out) out.pollUrl = '/poll.csv';
    if (out.etaUrl) out.etaUrl = '/eta.csv';
  }
  return out;
}

/* ---------------- web ---------------- */
const TOKEN = crypto.randomBytes(24).toString('hex'); // pages from this server only (blocks other sites' requests)
const okHost = h => new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${PORT}$`).test(String(h || ''));
const readBody = req => new Promise((res, rej) => { let s = ''; req.setEncoding('utf8'); req.on('data', d => { s += d; if (s.length > 2e6) req.destroy(); }); req.on('end', () => res(s)); req.on('error', rej); });
const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(code, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }, extra));
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

function dashboardHtml() {
  const shim = fs.readFileSync(path.join(HERE, 'shim.js'), 'utf8').replace('__TOKEN__', TOKEN);
  return fs.readFileSync(path.join(GS, 'Dashboard.html'), 'utf8')
    .replace(/<base[^>]*>/i, '')
    .replace(/https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec/g, '/')
    .replace(/<head>/i, '<head><script>' + shim + '</script>');
}
const csvCell = v => { const s = v && typeof v === 'object' && 'd' in v ? new Date(v.d).toLocaleString('en-US') : String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

function status() {
  return { ready: sync.ready, configured: !!(conf.token && conf.groupId), group: conf.groupName || '', groupId: conf.groupId || '',
    lastPollAt: sync.lastPollAt, lastError: sync.lastError, lastExcelAt: sync.lastExcelAt, waiting: outLines.length, posted: sync.posted,
    rides: tonight().length, port: PORT,
    adds: adds.filter(a => Date.now() - a.at < 2 * ADD_WAIT_MS).map(a => Object.assign({ id: a.id, first: a.first, at: a.at }, addState(a))) };
}

// ＋ Ride phone lookup: every past ride this server knows for a phone (rides from the sync chat + the texting log),
// summed up so the dispatcher can ask "Is this Maliha?". Read only: never writes, never logs the phone or the results.
// The phone → rides index is built once and rebuilt only when the rides or the log change (or after a minute).
let lookupIdx = null;
const digits10 = v => { let d = String(v || '').replace(/\D/g, ''); if (d.length === 11 && d[0] === '1') d = d.slice(1); return d.length === 10 ? d : ''; };
function lookupIndex() {
  const logs = (() => { try { return gas.logRows() || []; } catch (e) { return []; } })();
  if (lookupIdx && lookupIdx.ver === store.ver && lookupIdx.logs === logs.length && lookupIdx.adds === adds.length && Date.now() - lookupIdx.at < 60e3) return lookupIdx.by;
  const by = new Map(), seen = new Set();
  const add = (p, ride) => { if (!p) return; (by.get(p) || by.set(p, []).get(p)).push(ride); };
  Object.values(store.rides || {}).forEach(r => {
    const f = r.f || {}, p = digits10(f.phone);
    if (!p) return;
    seen.add(r.id);
    const bg = String(f.bg || '').toLowerCase(), rsn = String(f.rsn || '');
    add(p, { id: r.id, ts: String(f.ts || ''), first: String(f.first || '').trim(), last: String(f.last || '').trim(), eid: String(f.eid || '').trim(),
      email: String(f.email || '').trim(), ada: /^y/i.test(String(f.ada || '')), pu: String(f.pu || '').trim(), do: String(f.do || '').trim(),
      cancelled: !!rsn || bg === '#000000', dup: bg === '#ff0000', noShow: /no.?show/i.test(rsn), off: /off.?campus|invalid/i.test(rsn),
      add: r.id.charAt(0) === 'a' }); // typed in on ＋ Ride: not a ride of its own (the sheet's copy is), but it has the EID / email
  });
  // ＋ Ride requests made here (memory only): the EID / email the dispatcher typed. Not rides of their own.
  adds.forEach(a => { const f = a.f || {}; add(a.phone10, { id: a.id, ts: String(f.ts || ''), first: String(f.first || '').trim(), last: String(f.last || '').trim(),
    eid: String(f.eid || '').trim(), email: String(f.email || '').trim(), ada: /^y/i.test(String(f.ada || '')), pu: '', do: '', cancelled: false, dup: false, noShow: false, off: false, add: true }); });
  // The texting log: older riders the sync chat no longer has (one ride per ride id; name only).
  logs.forEach(r => {
    const id = String(r[4] || ''), p = digits10(r[3]), name = String(r[6] || '').trim();
    if (!id || !p || !name || seen.has(id) || /^(rider|unknown)$/i.test(name)) return;
    seen.add(id);
    const ts = r[0] && typeof r[0] === 'object' && 'd' in r[0] ? new Date(r[0].d).toISOString() : String(r[0] || '');
    const parts = name.split(/\s+/);
    add(p, { id, ts, first: parts[0], last: parts.slice(1).join(' '), eid: '', email: '', ada: false, pu: '', do: '', cancelled: false, dup: false, noShow: false, off: false });
  });
  lookupIdx = { by, ver: store.ver, logs: logs.length, adds: adds.length, at: Date.now() };
  return by;
}
function lookupRider(body) {
  const phone = digits10(body.phone);
  if (!phone) return { ok: true, rides: 0 };
  const all = (lookupIndex().get(phone) || []).slice().sort((a, b) => (a.ts < b.ts ? 1 : -1)); // newest first
  const rides = all.filter(r => !r.add);
  if (!rides.length) return { ok: true, rides: 0 };
  const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const day = ts => String(ts).slice(0, 10);
  const names = new Map();
  rides.forEach(r => { const k = norm(r.first + ' ' + r.last); if (!k) return;
    const n = names.get(k) || names.set(k, { first: r.first, last: r.last, count: 0, lastDate: day(r.ts), eid: '', email: '', ada: false }).get(k);
    n.count++; if (r.ada) n.ada = true; });
  all.forEach(r => { const n = names.get(norm(r.first + ' ' + r.last)); if (n) { if (!n.eid && r.eid) n.eid = r.eid; if (!n.email && r.email) n.email = r.email; } });
  const top = (key, n) => { const m = new Map(); rides.forEach(r => { const k = key(r); if (k) m.set(k, (m.get(k) || 0) + 1); });
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => ({ k, count: c })); };
  const eids = [...new Set(all.map(r => r.eid.toLowerCase()).filter(e => e && !/^n\/?a$/i.test(e)))];
  const optOut = (() => { try { return JSON.parse(gas.props.script.TX_OPTOUT || '[]').includes(phone); } catch (e) { return false; } })();
  return { ok: true, rides: rides.length, lastDate: day(rides[0].ts),
    names: [...names.values()], // newest first (rides are sorted that way)
    eid: (all.find(r => r.eid) || {}).eid || '', eids: eids.length,
    email: (all.find(r => r.email) || {}).email || '', emails: new Set(all.map(r => r.email.toLowerCase()).filter(Boolean)).size,
    ada: rides.some(r => r.ada),
    pickups: top(r => r.pu, 3), dropoffs: top(r => r.do, 3),
    routes: top(r => (r.pu && r.do ? r.pu + '→' + r.do : ''), 3).map(x => Object.assign(x, { pu: x.k.split('→')[0], do: x.k.split('→')[1] })),
    cancels: rides.filter(r => r.cancelled && !r.noShow).length, noShows: rides.filter(r => r.noShow).length, dups: rides.filter(r => r.dup).length,
    optOut, wasOff: rides.some(r => r.off) };
}

const server = http.createServer(async (req, res) => {
  try {
    if (!okHost(req.headers.host)) return send(res, 403, 'Forbidden', 'text/plain');
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const p = url.pathname;
    if (req.method === 'POST' && p === '/bridge') { // the phone bridge (checks its key itself)
      const body = await readBody(req);
      if (conf.groupId && !sync.ready) return send(res, 503, { error: 'still reading the GroupMe chat' });
      const out = run(() => doPost({ postData: { contents: body } }));
      return send(res, 200, out.getContent());
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, dashboardHtml(), 'text/html; charset=utf-8');
    if (req.method === 'GET' && p === '/setup') return send(res, 200, fs.readFileSync(path.join(HERE, 'setup.html'), 'utf8').replace('__TOKEN__', TOKEN), 'text/html; charset=utf-8');
    if (req.method === 'GET' && p === '/log.csv') {
      const head = 'Time,Night,Direction,Phone,Ride ID,Row,Name,Text,Status,Intent,Note\n';
      return send(res, 200, head + gas.logRows().map(r => r.map(csvCell).join(',')).join('\n'), 'text/csv; charset=utf-8',
        { 'Content-Disposition': 'attachment; filename="SURE Walk Texts log.csv"' });
    }
    if (req.method === 'GET' && p === '/poll.csv') { // the poll answers (night + answers, no names or numbers)
      return send(res, 200, gas.pollRows().map(r => (r || []).map(csvCell).join(',')).join('\n'), 'text/csv; charset=utf-8',
        { 'Content-Disposition': 'attachment; filename="SURE Walk Poll.csv"' });
    }
    if (req.method === 'GET' && p === '/eta.csv') { // predicted vs. real waits (no names or numbers) — to refit the ETA
      return send(res, 200, gas.etaRows().map(r => (r || []).map(csvCell).join(',')).join('\n'), 'text/csv; charset=utf-8',
        { 'Content-Disposition': 'attachment; filename="SURE Walk ETA.csv"' });
    }
    if (req.method === 'POST') {
      if (req.headers['x-sw-token'] !== TOKEN) return send(res, 403, { ok: false, error: 'Reload the page.' });
      const body = JSON.parse((await readBody(req)) || '{}');
      if (p === '/rpc') {
        try { return send(res, 200, { ok: true, result: rpc(body.fn, body.args) }); }
        catch (e) { return send(res, 200, { ok: false, error: String((e && e.message) || e) }); }
      }
      if (p === '/api/status') return send(res, 200, status());
      if (p === '/api/lookupRider') return send(res, 200, lookupRider(body || {}));
      if (p === '/api/addRide') return send(res, 200, requestAdd(body || {}));
      if (p === '/api/groups') { // check a token and list its chats
        const token = cleanTok(body.token || conf.token || '');
        if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return send(res, 200, { ok: false, error: "That doesn't look like a GroupMe token." });
        try {
          const gs = await gm('/groups', { token, query: { per_page: 100, omit: 'memberships' } });
          return send(res, 200, { ok: true, groups: (gs || []).map(g => ({ id: g.id, name: g.name })) });
        } catch (e) { return send(res, 200, { ok: false, error: String(e.message || e) }); }
      }
      if (p === '/api/config') {
        const token = cleanTok(body.token || conf.token || '');
        if (body.off) { conf = {}; saveConf(conf); sync.ready = false; store.rides = {}; store.ver++; gas.clearCache(); return send(res, 200, status()); }
        if (!token || !body.groupId) return send(res, 200, { ok: false, error: 'Pick a chat.' });
        conf = { token, groupId: String(body.groupId), groupName: String(body.groupName || '') };
        saveConf(conf); sync.ready = false;
        loop();
        return send(res, 200, status());
      }
    }
    send(res, 404, 'Not found', 'text/plain');
  } catch (e) {
    log('error', req.method, req.url, e && e.stack);
    send(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

/* ---------------- commands ---------------- */
function linkBridge() {
  const key = PropertiesService.getScriptProperties().getProperty('TX_KEY');
  const dir = WIN ? path.join(LOCAL, 'surewalk-bridge') : path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'surewalk-bridge'), file = path.join(dir, 'config.json');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) {
    const old = fs.readFileSync(file, 'utf8');
    if (!old.includes('127.0.0.1')) fs.writeFileSync(path.join(dir, 'config.google.json'), old, { mode: 0o600 });
  }
  fs.writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${PORT}/bridge`, key }, null, 2), { mode: 0o600 });
  console.log(`The phone bridge now talks to http://127.0.0.1:${PORT}/bridge (old config kept as config.google.json).\nRestart it: ` + (WIN ? 'STOP-TEXTING.cmd, then START-TEXTING.cmd' : 'systemctl --user restart surewalk-bridge'));
}

loadCode();
ensureSetup();
const cmd = process.argv[2];
if (cmd === 'link-bridge') { linkBridge(); process.exit(0); }
if (cmd === 'test-poll') {
  const num = process.argv[3];
  if (!num) { console.error('Usage: node server/server.mjs test-poll <phone-number>'); process.exit(1); }
  try {
    run(() => globalThis.sendTestPoll(num));
    gas.flush();
    console.log(`✓ Test poll (1/3) queued to ${num}. Reply to test the conversation!`);
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}
if (cmd === 'test-text') {
  const num = process.argv[3], msg = process.argv.slice(4).join(' ') || 'SURE Walk Texts test ✔';
  if (!num) { console.error('Usage: node server/server.mjs test-text <phone-number> [message]'); process.exit(1); }
  try {
    run(() => globalThis.sendToNumber(num, msg));
    gas.flush();
    console.log(`✓ Test text queued to ${num}: "${msg}"`);
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}
server.listen(PORT, '127.0.0.1', () => {
  log(`SURE Walk Texts: http://127.0.0.1:${PORT}  (log + settings in ${STATE})`);
  if (!conf.groupId) log('GroupMe sync chat not set yet: open the dashboard ▸ GroupMe sync.');
  if (process.argv.includes('--open')) spawn(WIN ? 'explorer.exe' : 'xdg-open', [`http://127.0.0.1:${PORT}/`], { stdio: 'ignore', detached: true }).unref();
});
loop();
setInterval(loop, POLL_MS);
process.on('SIGTERM', () => { gas.flush(); process.exit(0); });
process.on('SIGINT', () => { gas.flush(); process.exit(0); });
process.on('SIGHUP', () => { gas.flush(); process.exit(0); }); // Windows: the server's console window was closed
