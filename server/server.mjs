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

/* ---------------- this laptop as the sync chat (no GroupMe) ---------------- */
// The Excel panel on this laptop can call this server directly (Edge and Chrome let https pages reach 127.0.0.1 when
// the server allows it), so the server can BE the sync chat: the same 'sw1' lines in a GroupMe-shaped API under /v3,
// one laptop key instead of a GroupMe token, and ride data never leaves this laptop. It's the default unless a
// GroupMe chat was set up here before (conf.mode 'groupme').
const LOCAL_GROUP = 'local', LOCAL_NAME = 'This laptop';
const chatFile = path.join(STATE, 'chat.jsonl');
const chat = { msgs: [], seq: 0, loaded: false };
const isLocal = () => conf.mode === 'local' || (conf.mode !== 'groupme' && !conf.groupId);
const syncActive = () => isLocal() || !!(conf.token && conf.groupId);
function localKey() {
  if (!/^[a-f0-9]{32}$/.test(conf.localKey || '')) { conf = Object.assign({}, conf, { localKey: crypto.randomBytes(16).toString('hex') }); saveConf(conf); }
  return conf.localKey;
}
function chatLoad() { // the last 24 h (rewrites the file without older lines)
  const cutoff = Date.now() / 1000 - 24 * 3600;
  try { chat.msgs = fs.readFileSync(chatFile, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(m => m && m.created_at >= cutoff); }
  catch (e) { chat.msgs = []; }
  chat.seq = chat.msgs.reduce((x, m) => Math.max(x, Number(m.id) || 0), 0);
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(chatFile, chat.msgs.map(m => JSON.stringify(m) + '\n').join(''), { mode: 0o600 });
  chat.loaded = true;
}
function chatAdd(text, name) {
  const id = Math.max(chat.seq + 1, Date.now() * 1000); chat.seq = id;
  const m = { id: String(id), created_at: Math.floor(Date.now() / 1000), text, name };
  chat.msgs.push(m);
  fs.appendFileSync(chatFile, JSON.stringify(m) + '\n', { mode: 0o600 });
  if (chat.msgs.length > 50000) chat.msgs.splice(0, chat.msgs.length - 50000);
  return m;
}
// Who may call /v3 from a browser: the Script Lab panel, the add-in (GitHub Pages), Excel itself, and pages on this laptop.
const PANEL_ORIGIN = /^(https:\/\/(script-lab\.public\.cdn\.office\.net|leeisaac991\.github\.io|[a-z0-9-]+\.officeapps\.live\.com|excel\.cloud\.microsoft)|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/;
const sameKey = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
async function localApi(req, res, url) {
  const origin = req.headers.origin;
  if (origin && !PANEL_ORIGIN.test(origin)) return send(res, 403, { meta: { errors: ['origin not allowed'] } });
  const cors = origin ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Token', 'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Allow-Local-Network': 'true', 'Access-Control-Max-Age': '600' } : {};
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const out = (code, body) => send(res, code, body, 'application/json; charset=utf-8', cors);
  if (!sameKey(req.headers['x-access-token'], localKey())) return out(401, { meta: { errors: ['wrong laptop key'] } });
  if (!isLocal()) return out(409, { meta: { errors: ['this laptop syncs through GroupMe right now (dashboard ▸ sync settings)'] } });
  const p = url.pathname;
  if (p === '/v3/users/me') return out(200, { response: { id: LOCAL_GROUP, user_id: LOCAL_GROUP, name: '' } });
  if (p === '/v3/groups') return out(200, { response: [{ id: LOCAL_GROUP, name: LOCAL_NAME }] });
  if (p !== `/v3/groups/${LOCAL_GROUP}/messages`) return out(404, { meta: { errors: ['not found'] } });
  if (!chat.loaded) chatLoad();
  if (req.method === 'POST') {
    let text = '';
    try { text = String(JSON.parse(await readBody(req)).message.text || ''); } catch (e) { return out(400, { meta: { errors: ['bad message'] } }); }
    if (!text || text.length > 1000) return out(400, { meta: { errors: ['message empty or too long'] } });
    const m = chatAdd(text, 'Excel panel');
    if (sync.ready) take([m]);
    return out(201, { response: { message: m } });
  }
  const q = Object.fromEntries(url.searchParams), lim = Math.min(100, Math.max(1, Number(q.limit) || 20));
  const list = q.after_id ? chat.msgs.filter(m => Number(m.id) > Number(q.after_id)).slice(0, lim)                                  // oldest first
    : chat.msgs.filter(m => !q.before_id || Number(m.id) < Number(q.before_id)).slice().reverse().slice(0, lim);                 // newest first
  if (!list.length) { res.writeHead(304, cors); return res.end(); }
  return out(200, { response: { count: chat.msgs.length, messages: list } });
}
function localTick() { // the server's side of the laptop chat: read it once, then post what's waiting
  if (!sync.ready) {
    chatLoad();
    sync.seen.clear(); store.rides = {}; sync.lastId = '';
    const cutoff = Date.now() / 1000 - 20 * 3600;
    const n = take(chat.msgs.filter(m => m.created_at >= cutoff));
    sync.ready = true;
    log(`laptop sync: ${chat.msgs.length} messages, ${n} ride events, ${Object.keys(store.rides).length} rides`);
  }
  while (outLines.length) {
    const text = SWP.pack(outLines.slice(0, 40))[0], used = text.split('\n').length;
    take([chatAdd(text, 'texting server')]);
    outLines.splice(0, used); saveOut(); sync.posted++;
  }
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
  if (!syncActive() || !sync.ready) return { ok: false, error: "Sync with the Excel panel isn't running, so the panel can't get the ride. Set it up first (Sync pill)." };
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
    if (isLocal()) { localTick(); sync.lastPollAt = Date.now(); sync.lastError = ''; return; }
    if (!conf.token || !conf.groupId) { sync.ready = false; return; }
    if (!sync.ready) { await backfill(); sync.ready = true; }
    else await poll();
    if (Date.now() >= nextPostAt && outLines.length) { await postPending(); nextPostAt = Date.now() + POST_GAP_MS; }
    sync.lastPollAt = Date.now(); sync.lastError = '';
  } catch (e) {
    sync.lastError = String(e.message || e);
    log(isLocal() ? 'laptop sync:' : 'GroupMe:', sync.lastError);
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
  syncGroups(tx, byRow);
}
// 👥 Riders the texting code grouped (they named each other by text, Texts.gs groupReply_): give the group a letter
// (one a member already has in the sheet, else the first one free tonight) and write "Group X" into each rider's
// Confirmed cell ONCE — after that the sheet wins, so a dispatcher can move or remove them in the calling panel.
function syncGroups(tx, byRow) {
  const groups = (tx.groups || []).filter(g => g.rides.length > 1);
  if (!groups.length) return;
  const rideOf = id => { const rec = tx.rides[id]; return rec && (byRow[rec.row] || []).find(x => String(x.f.phone || '').replace(/\D/g, '').slice(-10) === rec.phone10); };
  const used = new Set();
  Object.values(tx.rides).forEach(rec => (byRow[rec.row] || []).forEach(x => { const L = cfGroup(x.f.txs); if (L) used.add(L); }));
  groups.forEach(g => { if (g.letter) used.add(g.letter); });
  let changed = false;
  groups.forEach(g => {
    g.wrote = g.wrote || {};
    if (!g.letter) {
      const have = g.rides.map(id => { const r = rideOf(id); return r && cfGroup(r.f.txs); }).find(Boolean);
      g.letter = have || 'ABCDEFGH'.split('').find(L => !used.has(L)) || '';
      if (!g.letter) return log('groups: no free letter (A–H all used tonight)');
      used.add(g.letter); changed = true;
    }
    g.rides.forEach(id => {
      if (g.wrote[id]) return;
      const r = rideOf(id);
      if (!r) return;
      if (!cfGroup(r.f.txs)) gas.setField(r.id, 'txs', cfJoin(cfTime(r.f.txs), g.letter));
      g.wrote[id] = true; changed = true; // (already in a group in the sheet: the dispatcher's choice stands)
    });
  });
  if (changed && typeof globalThis.saveTx_ === 'function') globalThis.saveTx_(tx);
}
const cfTime = s => (/^\s*(\d{1,2}:\d{2})/.exec(String(s || '')) || [])[1] || '';

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

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#bf5700"/><path d="M7 9.5C7 8.12 8.12 7 9.5 7h13c1.38 0 2.5 1.12 2.5 2.5v9c0 1.38-1.12 2.5-2.5 2.5H13l-4.5 3.5v-3.5H9.5C8.12 21 7 19.88 7 18.5v-9z" fill="#ffffff"/><circle cx="11.5" cy="14" r="1.5" fill="#bf5700"/><circle cx="16" cy="14" r="1.5" fill="#bf5700"/><circle cx="20.5" cy="14" r="1.5" fill="#bf5700"/></svg>`;

function dashboardHtml() {
  const shim = fs.readFileSync(path.join(HERE, 'shim.js'), 'utf8').replace('__TOKEN__', TOKEN).replace("'__LEGACY__'", WIN ? 'false' : 'true');
  return fs.readFileSync(path.join(GS, 'Dashboard.html'), 'utf8')
    .replace(/<base[^>]*>/i, '')
    .replace(/https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec/g, '/')
    .replace(/<head>/i, '<head><script>' + shim + '</script>');
}
const csvCell = v => { const s = v && typeof v === 'object' && 'd' in v ? new Date(v.d).toLocaleString('en-US') : String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

function status() {
  const local = isLocal();
  return { ready: sync.ready, configured: syncActive(), mode: local ? 'local' : 'groupme', localKey: localKey(),
    group: local ? LOCAL_NAME : conf.groupName || '', groupId: local ? LOCAL_GROUP : conf.groupId || '', groupmeChat: conf.groupName || '',
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
    if (p.startsWith('/v3/')) return await localApi(req, res, url); // the Excel panel on this laptop (laptop key)
    if (req.method === 'POST' && p === '/bridge') { // the phone bridge (checks its key itself)
      const body = await readBody(req);
      if (syncActive() && !sync.ready) return send(res, 503, { error: 'still reading the sync chat' });
      const out = run(() => doPost({ postData: { contents: body } }));
      return send(res, 200, out.getContent());
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, dashboardHtml(), 'text/html; charset=utf-8');
    if (req.method === 'GET' && (p === '/favicon.ico' || p === '/favicon.svg')) return send(res, 200, FAVICON_SVG, 'image/svg+xml; charset=utf-8');
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
          const [me, gs] = await Promise.all([
            gm('/users/me', { token }).catch(() => null),
            gm('/groups', { token, query: { per_page: 100, omit: 'memberships' } })
          ]);
          return send(res, 200, { ok: true, name: (me && me.name) || '', groups: (gs || []).map(g => ({ id: g.id, name: g.name })) });
        } catch (e) { return send(res, 200, { ok: false, error: String(e.message || e) }); }
      }
      if (p === '/api/config') {
        const token = cleanTok(body.token || conf.token || '');
        const keep = { localKey: conf.localKey };
        if (body.mode === 'local') { conf = Object.assign({}, conf, { mode: 'local' }); saveConf(conf); sync.ready = false; store.rides = {}; store.ver++; gas.clearCache(); loop(); return send(res, 200, status()); }
        if (body.newKey) { conf = Object.assign({}, conf, { localKey: '' }); localKey(); return send(res, 200, status()); }
        if (body.off) { conf = Object.assign({ mode: 'local' }, keep); saveConf(conf); sync.ready = false; store.rides = {}; store.ver++; gas.clearCache(); loop(); return send(res, 200, status()); }
        if (!token || !body.groupId) return send(res, 200, { ok: false, error: 'Pick a chat.' });
        conf = Object.assign(keep, { mode: 'groupme', token, groupId: String(body.groupId), groupName: String(body.groupName || '') });
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
  if (!WIN) log('⚠ DEPRECATED: the Linux texting computer is a backup only. SURE Walk Texts is developed for Windows now (windows/ — START-TEXTING.cmd on the laptop); no new features land here first.');
  if (isLocal()) log('Sync: the Excel panel on this laptop (no GroupMe). Its laptop key is on the dashboard ▸ Sync.');
  else if (!conf.groupId) log('GroupMe sync chat not set yet: open the dashboard ▸ Sync.');
  if (process.argv.includes('--open')) spawn(WIN ? 'explorer.exe' : 'xdg-open', [`http://127.0.0.1:${PORT}/`], { stdio: 'ignore', detached: true }).unref();
});
loop();
setInterval(loop, POLL_MS);
process.on('SIGTERM', () => { gas.flush(); process.exit(0); });
process.on('SIGINT', () => { gas.flush(); process.exit(0); });
process.on('SIGHUP', () => { gas.flush(); process.exit(0); }); // Windows: the server's console window was closed
