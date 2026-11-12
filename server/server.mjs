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
 * Env: PORT (8787), SUREWALK_GS (the .gs folder), SUREWALK_STATE (~/.local/state/surewalk-texts).
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
const STATE = process.env.SUREWALK_STATE || path.join(process.env.XDG_STATE_HOME || path.join(HOME, '.local/state'), 'surewalk-texts');
const CONF_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'surewalk-texts', 'config.json');
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

/* ---------------- running the texting code ---------------- */
function run(fn) { // every entry into the .gs code: then ship its sheet edits and save
  try { return fn(); } finally { try { shipChanges(); } finally { gas.flush(); } }
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
    rides: Object.values(store.rides).filter(r => SWP.nightOf(r.f.ts) === SWP.nightOf(SWP.austin())).length, port: PORT };
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
    if (req.method === 'POST') {
      if (req.headers['x-sw-token'] !== TOKEN) return send(res, 403, { ok: false, error: 'Reload the page.' });
      const body = JSON.parse((await readBody(req)) || '{}');
      if (p === '/rpc') {
        try { return send(res, 200, { ok: true, result: rpc(body.fn, body.args) }); }
        catch (e) { return send(res, 200, { ok: false, error: String((e && e.message) || e) }); }
      }
      if (p === '/api/status') return send(res, 200, status());
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
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'surewalk-bridge'), file = path.join(dir, 'config.json');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) {
    const old = fs.readFileSync(file, 'utf8');
    if (!old.includes('127.0.0.1')) fs.writeFileSync(path.join(dir, 'config.google.json'), old, { mode: 0o600 });
  }
  fs.writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${PORT}/bridge`, key }, null, 2), { mode: 0o600 });
  console.log(`The phone bridge now talks to http://127.0.0.1:${PORT}/bridge (old config kept as config.google.json).\nRestart it: systemctl --user restart surewalk-bridge`);
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
  if (process.argv.includes('--open')) spawn('xdg-open', [`http://127.0.0.1:${PORT}/`], { stdio: 'ignore', detached: true }).unref();
});
loop();
setInterval(loop, POLL_MS);
process.on('SIGTERM', () => { gas.flush(); process.exit(0); });
process.on('SIGINT', () => { gas.flush(); process.exit(0); });
