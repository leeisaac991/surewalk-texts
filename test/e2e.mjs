// End-to-end: fake GroupMe + the real texting server (running the real .gs code) + the real Excel panel on a fake
// Excel in headless Chromium + a pretend phone bridge. Run with test/run.sh.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.dirname(HERE);
const TMP = process.env.TMPDIR_E2E || fs.mkdtempSync('/tmp/swt-');
const PB = +process.env.E2E_PORT_BASE || 0; // another run on this PC at the same time? set E2E_PORT_BASE (e.g. 100)
const GPORT = 8791 + PB, SPORT = 8792 + PB, CPORT = 9339 + PB;
const NOW = Date.UTC(2026, 10, 12, 4, 0); // 10:00 PM in Austin, Wed Nov 11 2026
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, msg) => { if (c) { passes++; console.log('  ✓', msg); } else { fails++; console.log('  ✗', msg); } };
async function until(fn, msg, ms = 25000) {
  const t0 = Date.now();
  for (;;) { let v; try { v = await fn(); } catch (e) { v = false; } if (v) { ok(true, msg); return v; } if (Date.now() - t0 > ms) { ok(false, msg + ' (timed out)'); return null; } await sleep(300); }
}

/* ---------- fake GroupMe ---------- */
// SYNC=laptop: the panel syncs with the texting server itself (the laptop chat, no GroupMe); the fake GroupMe below then
// only serves the panel page (any message traffic to it is a failure).
const VIA_LAPTOP = process.env.SYNC === 'laptop';
const LKEY = 'abcdef0123456789abcdef0123456789';
const msgs = []; let seq = 1000, gmChatHits = 0;
const gm = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST' };
  const send = (code, body, type = 'application/json') => { res.writeHead(code, Object.assign({ 'Content-Type': type }, cors)); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  if (req.method === 'OPTIONS') return send(204, '');
  if (u.pathname === '/panel') return send(200, u.searchParams.get('remote') ? callingPage() : panelPage(u.searchParams.get('click')), 'text/html');
  if (u.pathname.startsWith('/files/')) return send(200, fs.readFileSync(path.join(ROOT, u.pathname.slice(7))), 'text/javascript');
  if (u.pathname === '/v3/users/me') return send(200, { response: { name: 'Test Dispatcher', user_id: '1' } });
  if (u.pathname === '/v3/groups') return send(200, { response: [{ id: 'g1', name: 'SURE Walk Texts sync' }] });
  const m = /^\/v3\/groups\/g1\/messages$/.exec(u.pathname);
  if (!m) return send(404, {});
  gmChatHits++;
  if (req.method === 'POST') {
    let s = ''; for await (const d of req) s += d;
    const text = JSON.parse(s).message.text;
    if (text.length > 1000) return send(400, { meta: { errors: ['too long'] } });
    msgs.push({ id: String(++seq), created_at: Math.floor(Date.now() / 1000), text, name: 'poster' });
    return send(201, { response: { message: msgs[msgs.length - 1] } });
  }
  const q = Object.fromEntries(u.searchParams), lim = Number(q.limit || 20);
  let out;
  if (q.after_id) out = msgs.filter(x => +x.id > +q.after_id).slice(0, lim);            // oldest first
  else out = msgs.filter(x => !q.before_id || +x.id < +q.before_id).slice().reverse().slice(0, lim); // newest first
  if (!out.length) { res.writeHead(304, cors); return res.end(); }
  send(200, { response: { count: msgs.length, messages: out } });
});

/* ---------- the Excel panel page on a fake sheet ---------- */
// LAYOUT=nov (default): the Nov 2026 rides tab (Date + Submitted Time, no combined timestamp); LAYOUT=old: Form Submitted.
const LAYOUT = process.env.LAYOUT || 'nov';
const COLS_OLD = ['Id', 'Start time', 'Form Submitted', 'Time Submitted', 'Dispatcher', 'Call Time', 'Arrival Time', 'Wait Time', 'UT EID', 'Last Name:', 'First Name:'];
const COLS_NOV = ['Id', 'Date', 'Submitted Time', 'Dispatcher', 'Call Time', 'Arrival Time', 'Wait Time', 'UT EID (if a visitor, use N/A) :', 'Last Name:', 'First Name:'];
const HEADER = (LAYOUT === 'old' ? COLS_OLD : COLS_NOV).concat(['Phone number. Only submit using numeric digits', 'Pick-up Location (UT PROPERTY ONLY) Non UT property will be cancelled automatically:', 'Drop-off Location Building or Apartment name:',
  'Do you require Americans with Disabilities Act assistance?', 'Location', 'Vehicle Type', 'Driver', 'Navigator', 'I have read the updated rules and guidelines for Sure Walk and understand the current situation that the program is experiencing.',
  'All pick up locations are only permitted on campus. Off campus locations will NOT be considered and declined.',
  'Rides requested to or from any food establishment (e.g. Insomnia Cookies, Chick-Fil-A, Canes, and food trucks) will NOT be considered and declined.', 'Email Address:', 'Reason for Cancellation', 'Notes'].concat(LAYOUT === 'old' ? [] : ['Confirmed'])); // old layout: no "Confirmed" column
const idx = re => HEADER.findIndex(h => re.test(h));
const L = n => String.fromCharCode(65 + n);
const C = { call: L(idx(/^Call Time/)), disp: L(idx(/^Dispatcher/)), rsn: L(idx(/^Reason/)), pu: L(idx(/^Pick-up/)), do: L(idx(/^Drop-off/)), first: L(idx(/^First Name/)), arr: L(idx(/^Arrival Time/)), txs: LAYOUT === 'old' ? '' : L(idx(/^Confirmed$/)) };
const wallParts = minAgo => { const d = new Date(NOW - 6 * 3600e3 - minAgo * 60e3); return [`${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`, `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`]; };
const wall = minAgo => wallParts(minAgo).join(' ');
const ride = (id, minAgo, first, last, phone, pu, dropoff, extra = {}) => {
  const r = Array(HEADER.length).fill(''), put = (re, v) => { r[idx(re)] = v; };
  put(/^Id$/, String(id));
  if (LAYOUT === 'old') { put(/^Start time/, wall(minAgo + 1)); put(/^Form Submitted/, wall(minAgo)); }
  else { const [d, t] = wallParts(minAgo); put(/^Date$/, d); put(/^Submitted Time/, t); }
  put(/^Last Name/, last); put(/^First Name/, first); put(/^Phone/, phone); put(/^Pick-up/, pu); put(/^Drop-off/, dropoff); put(/^Do you require/, 'No');
  if (extra.rsn) put(/^Reason/, extra.rsn);
  return r;
};
const SHEET = { rows: [HEADER,
  ride(1, 3, 'Ava', 'Stone', '5125550101', 'PCL', 'Jester West'),
  ride(2, 2, 'Ben', 'Ortiz', '5125550102', 'Kins', 'Duren'),
  ride(3, 10, 'Cara', 'Wu', '5125550103', 'Gregory Gym', 'Dobie', { rsn: 'Not Ready' }),
], paint: [[4, '#000000', '#FFFFFF']], table: !!process.env.TABLE }; // TABLE=1: the rides are an Excel table
// The Calling window (the add-in opens it with Excel's dialog API): the same files in "remote" mode, with a stand-in
// for Office's dialog messaging; the side panel's stand-in (installed by the test) loads this page in a frame.
function callingPage() {
  const html = fs.readFileSync(path.join(ROOT, 'excel/panel.html'), 'utf8');
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}
<script>window.FAKE_SHEET = { rows: [] }; window.__SWT_REMOTE = true; window.SWT_TEST = { tick: 1000 };</script>
<script src="/files/test/fake-excel.js"></script>
<script>Office.EventType = { DialogParentMessageReceived: 'p' };
Office.context = { ui: { addHandlerAsync(t, h, cb) { window.__fromParent = m => h({ message: m }); if (cb) cb({ status: 'succeeded' }); }, messageParent(m) { parent.__dlgMsg(m); } } };</script>
<script src="/files/protocol.js"></script><script src="/files/excel/panel.js"></script></body></html>`;
}
function panelPage(click) {
  const html = fs.readFileSync(path.join(ROOT, 'excel/panel.html'), 'utf8');
  const clock = `(() => { const R = Date, T0 = ${NOW}, R0 = R.now(); window.Date = class extends R { constructor(...a) { super(...(a.length ? a : [T0 + R.now() - R0])); } static now() { return T0 + R.now() - R0; } }; })();`;
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}
<script>${clock}
window.FAKE_SHEET = ${JSON.stringify(SHEET)};
window.SWT_TEST = { tick: 1000, gap: 300, gm: 'http://127.0.0.1:${GPORT}/v3', laptop: 'http://127.0.0.1:${SPORT}/v3' };
localStorage.setItem('swt.settings', JSON.stringify(${VIA_LAPTOP
    ? `{ name: 'T. Tester', dispName: true, via: 'laptop', token: '${LKEY}', groupId: 'local', groupName: 'This laptop', sync: true }`
    : `{ name: 'T. Tester', dispName: true, token: 'tok_${'a'.repeat(30)}', groupId: 'g1', groupName: 'SURE Walk Texts sync', sync: true }`}));
window.confirm = () => true;
${click ? `setTimeout(() => { SWT.openCalling(); __xl.click(${+click}); setTimeout(() => document.querySelector('#selRide [data-a=cancel]').click(), 400); }, 1500);` : ''}
</script>
<script src="/files/test/fake-excel.js"></script><script src="/files/protocol.js"></script><script src="/files/excel/panel.js"></script></body></html>`;
}

/* ---------- Chromium over the DevTools protocol ---------- */
async function browser() {
  const prof = path.join(TMP, 'chrome');
  const bin = ['chromium-browser', 'chromium', 'google-chrome'].map(b => '/usr/bin/' + b).find(b => fs.existsSync(b));
  const ch = spawn(bin, ['--headless=new', '--no-sandbox', '--password-store=basic', `--user-data-dir=${prof}`, `--remote-debugging-port=${CPORT}`, '--no-first-run', `http://127.0.0.1:${GPORT}/panel`], { stdio: 'ignore' });
  process.on('exit', () => { try { ch.kill('SIGKILL'); } catch (e) { /* gone */ } }); // never leave a browser behind (it would hold the debugging port)
  let ws;
  for (let i = 0; i < 50 && !ws; i++) {
    await sleep(200);
    try { const l = await (await fetch(`http://127.0.0.1:${CPORT}/json`)).json(); const p = l.find(x => x.type === 'page'); if (p) ws = p.webSocketDebuggerUrl; } catch (e) { /* starting */ }
  }
  const sock = new WebSocket(ws); await new Promise(r => sock.addEventListener('open', r));
  let id = 0; const wait = {};
  sock.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && wait[m.id]) { wait[m.id](m); delete wait[m.id]; } if (m.method === 'Runtime.exceptionThrown') console.log('  page error:', m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description); });
  const cmd = (method, params) => new Promise(r => { const i = ++id; wait[i] = r; sock.send(JSON.stringify({ id: i, method, params })); });
  await cmd('Runtime.enable');
  const js = async expr => { const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception || {}).description); return r.result.result.value; };
  return { js, close: () => { sock.close(); ch.kill(); } };
}

/* ---------- the texting server ---------- */
function server() {
  const cfg = path.join(TMP, 'cfg', 'surewalk-texts');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify(VIA_LAPTOP ? { localKey: LKEY } : { token: 'tok_' + 'b'.repeat(30), groupId: 'g1', groupName: 'SURE Walk Texts sync' }));
  const p = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(`const R=Date,T0=${NOW},R0=R.now();globalThis.Date=class extends R{constructor(...a){super(...(a.length?a:[T0+R.now()-R0]))}static now(){return T0+R.now()-R0}};`), path.join(ROOT, 'server/server.mjs')], {
    env: Object.assign({}, process.env, { PORT: SPORT, SUREWALK_STATE: path.join(TMP, 'state'), XDG_CONFIG_HOME: path.join(TMP, 'cfg'), GROUPME_API: `http://127.0.0.1:${GPORT}/v3`, SW_POLL_MS: 700, SW_POST_GAP_MS: 200, SW_SEND_GAP_MS: 0 }),
    stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  process.on('exit', () => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } });
  return { p, out: () => out };
}

gm.listen(GPORT, '127.0.0.1');
const S = server();
for (let t0 = Date.now(); Date.now() - t0 < 15000; await sleep(200)) { try { await fetch(`http://127.0.0.1:${SPORT}/`); break; } catch (e) { /* still starting */ } }
const page = await (await fetch(`http://127.0.0.1:${SPORT}/`)).text();
const TOKEN = /var TOKEN = '([a-f0-9]+)'/.exec(page)[1];
const rpc = async (fn, ...args) => { const r = await (await fetch(`http://127.0.0.1:${SPORT}/rpc`, { method: 'POST', headers: { 'X-SW-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ fn, args }) })).json(); if (!r.ok) throw new Error(r.error); return r.result; };
const KEY = JSON.parse(fs.readFileSync(path.join(TMP, 'state', 'props.json'), 'utf8')).script.TX_KEY;
const bridge = async (inbound = [], results = []) => (await fetch(`http://127.0.0.1:${SPORT}/bridge`, { method: 'POST', body: JSON.stringify({ key: KEY, op: 'sync', bridge: { connected: true, healthy: true, version: 'test' }, inbound, results }) })).json();
const rideOf = async id => (await rpc('getState')).rides.find(r => r.phone10 === id);

console.log('server + panel');
ok(page.includes('google.script.run') || page.includes('window.google'), 'dashboard served with the local google.script.run');
ok(page.includes("var LEGACY = true;") === (process.platform !== 'win32'), 'Linux: the dashboard is marked LINUX · DEPRECATED (Windows is the main program)');
await rpc('setToggle', 'TX_AUTOTEXT', true); // before any ride arrives (rides seen while it's off are never auto-texted)
const B = await browser();
const sees = async () => (await rpc('getState')).rides.length;
await until(async () => (await sees()) === 3, 'panel posted tonight\'s 3 rides; the texting server sees them');
ok(await B.js("!!document.getElementById('restartBtn')"), 'restart button present in the bar');
// The sync chat as both sides see it: the fake GroupMe's messages, or the texting server's own laptop chat.
const chatMsgs = () => VIA_LAPTOP ? (() => { try { return fs.readFileSync(path.join(TMP, 'state', 'chat.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { return []; } })() : msgs;
const lapi = (p, opts = {}) => fetch(`http://127.0.0.1:${SPORT}/v3${p}`, Object.assign({ headers: Object.assign({ 'X-Access-Token': LKEY, 'Content-Type': 'application/json' }, opts.headers || {}) }, opts.init || {}));
async function inject(text) { // a message from someone else in the chat
  if (VIA_LAPTOP) await lapi('/groups/local/messages', { init: { method: 'POST', body: JSON.stringify({ message: { text } }) } });
  else msgs.push({ id: String(++seq), created_at: Math.floor(Date.now() / 1000), text });
}
const evs = () => chatMsgs().map(m => m.text).join('\n');
if (VIA_LAPTOP) console.log('(sync: this laptop, no GroupMe)');
ok(/‹sw1›\{"e":"ride","id":"f1"/.test(evs()), 'rides are keyed by the form Id');

const groupsRes = await (await fetch(`http://127.0.0.1:${SPORT}/api/groups`, {
  method: 'POST',
  headers: { 'X-SW-Token': TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: '  Bearer "tok_' + 'c'.repeat(30) + '"  ' })
})).json();
ok(groupsRes.ok && groupsRes.groups && groupsRes.groups.length > 0 && groupsRes.name === 'Test Dispatcher', 'api/groups checks and cleans token and gets name from GroupMe');
await B.js("SWT.saveToken('tok_" + "d".repeat(30) + "')");
await until(() => B.js("SWT.set.name === 'T. Dispatcher'"), 'panel saveToken updates name from GroupMe');

console.log('auto-text -> Call Time back in the sheet');
const first = await until(async () => { const r = await bridge(); return r.outbox && r.outbox.length >= 2 && r.outbox; }, 'confirmations queued for Ava and Ben (Cara is cancelled)');
ok(first && !first.some(o => o.to.endsWith('5550103')), 'no text to the cancelled ride');
await bridge([], (first || []).map(o => ({ outId: o.outId, status: 'sent' })));
await until(() => B.js(`__xl.text(2,'${C.call}') === '22:00' && __xl.text(3,'${C.call}') === '22:00'`), 'Call Time 22:00 written into F2 and F3 by the panel');
if (C.txs) ok(await B.js(`__xl.text(2,'${C.txs}') === ''`), '"Confirmed" column stays blank while Ava has only been texted');

console.log('rider texts CANCEL -> row cancelled in the sheet');
let res = await bridge([{ id: 'in1', from: '+15125550102', text: 'cancel', ts: NOW + 5000 }]);
await until(() => B.js(`__xl.bg(3,'A') === '#000000' && __xl.text(3,'${C.rsn}') !== '' && __xl.text(3,'${C.call}') === ''`), 'row 3 black, reason in X, Call Time cleared');
if (C.txs) ok(await B.js(`__xl.text(3,'${C.txs}') === ''`), '"Confirmed" column blank for Ben (cancelled by text)');
ok(/cancel/i.test(JSON.stringify(res.outbox || [])) || (res.outbox || []).length > 0, 'rider gets the cancelled text');

console.log('panel actions -> texting server');
await B.js(`SWT.openCalling(), 1`); // the Calling view (over the side panel here: no Excel dialog in this test)
await B.js(`__xl.click(2)`);
await until(() => B.js(`!!document.querySelector('#selRide [data-a=route]') && document.getElementById('cName').textContent.includes('Ava')`), 'clicking row 2 shows Ava in Calling');
await B.js(`document.querySelector('#selRide [data-a=route][data-which=pu]').click()`);
ok(await B.js(`document.activeElement && document.activeElement.id === 'cPu' && !!document.getElementById('cDo')`), 'clicking the pick-up card edits it in place');
await B.js(`document.getElementById('cPu').value = 'Welch Hall'; document.querySelector('#selRide [data-a=routeSave]').click()`);
await until(() => B.js(`__xl.text(2,'${C.pu}') === 'Welch Hall'`), 'pick-up changed in the sheet');
await until(async () => (await rideOf('5125550101')).pickup === 'Welch Hall', 'texting server got the new pick-up');
await B.js(`document.getElementById('toastUndo').click()`);
await until(async () => (await rideOf('5125550101')).pickup === 'PCL', 'undo restored PCL in the sheet and the server');

console.log('a new ride the dispatcher calls first is not texted');
await B.js(`__xl.row(5, ${JSON.stringify(ride(4, 0, 'Dee', 'Park', '5125550104', 'PCL', 'Kins'))})`);
await B.js(`__xl.click(5)`);
await until(() => B.js(`!!document.querySelector('#selRide [data-a=called]:not([disabled])') && document.getElementById('cName').textContent.includes('Dee')`), 'Dee selected');
await B.js(`document.querySelector('#selRide [data-a=called]').click()`);
await until(() => B.js(`__xl.text(5,'${C.call}') === '22:00' && __xl.text(5,'${C.disp}') === ''`), 'Mark called: F5 = now, Dispatcher left as it was');
await until(async () => { const r = await rideOf('5125550104'); return r && r.call === '22:00'; }, 'texting server sees Dee as called');
res = await bridge();
ok(!(res.outbox || []).some(o => o.to.endsWith('5550104')), 'Dee is not texted');

ok(await B.js(`SWT.cl.sel === null ? /No one to call/.test(document.getElementById('selRide').textContent) : !document.getElementById('cName').textContent.includes('Dee')`), 'after Mark called, Calling moves on (next rider to call, or "No one to call")');

console.log('cancel + duplicate from the panel');
await B.js(`__xl.click(5)`); await sleep(400); // back to Dee (clicking the row in the sheet)
await B.js(`document.querySelector('#selRide [data-a=dup]').click()`); await sleep(200);
await B.js(`document.querySelector('#selRide [data-a=dupGo]').click()`);
await until(() => B.js(`__xl.bg(5,'A') === '#FF0000'`), 'duplicate: row 5 red');
await until(async () => (await rideOf('5125550104')).sheetState === 'dup', 'texting server sees the duplicate');
await B.js(`__xl.click(2)`); await sleep(300);
await B.js(`document.querySelector('#selRide [data-a=cancel]').click()`); await sleep(200);
await B.js(`document.querySelector('#selRide [data-reason="No answer"]').click()`); await sleep(100);
await B.js(`document.querySelector('#selRide [data-a=cancelGo]').click()`);
await until(() => B.js(`__xl.bg(2,'A') === '#000000' && __xl.text(2,'${C.rsn}') === 'Not Answering' && __xl.text(2,'${C.call}') === ''`), 'cancel: row 2 black, reason, Call Time cleared');
await until(async () => (await rideOf('5125550101')).sheetState === 'cancelled', 'texting server sees the cancel');

console.log('a new response with the row above\'s copied highlight');
await B.js(`__xl.row(6, ${JSON.stringify(ride(5, 0, 'Eli', 'Ford', '5125550105', 'PCL', 'Kins'))}); __xl.paint(6, '#FF0000')`);
await until(() => B.js(`__xl.bg(6,'A') === '#FFFFFF'`), 'copied red cleared from the new ride (row 5 above is our duplicate, kept red)');
ok(await B.js(`__xl.bg(5,'A') === '#FF0000'`), 'our own duplicate stays red');
await until(async () => { const r = await bridge(); return (r.outbox || []).some(o => o.to.endsWith('5550105')); }, 'the new ride gets its confirmation text');

console.log('rides older than 1 hour are not synced');
await B.js(`__xl.row(7, ${JSON.stringify(ride(99, 90, 'Old', 'Rider', '5125550199', 'PCL', 'Dobie'))})`);
await sleep(2000);
ok(!evs().includes('Old') && !evs().includes('5125550199'), 'rides older than 1 hour are not posted to GroupMe');

console.log('a dispatcher edit wins over a stale server edit');
await B.js(`__xl.type(3,'${C.call}','21:58')`); await sleep(1500);
await inject(`💬 test ‹sw1›{"e":"upd","id":"f2","src":"s","f":{"call":"22:05"},"was":{"call":""}}`);
await sleep(2500);
ok(await B.js(`__xl.text(3,'${C.call}') === '21:58'`), 'the sheet keeps the dispatcher\'s 21:58');

console.log('dashboard ✎ Edit -> the sheet');
const eli = await rideOf('5125550105');
await rpc('editRide', eli.id, { dropoff: 'Jester West', first: 'Elias' });
await until(() => B.js(`__xl.text(6,'${C.do}') === 'Jester West' && __xl.text(6,'${C.first}') === 'Elias'`), 'editRide wrote the drop-off and first name into the sheet');

console.log('📋 test-rider poll -> its own local file');
// the tester's phone comes from Texts.gs at run time, so it never lands in this (public) repo
const gs = fs.readFileSync(path.join(process.env.SUREWALK_GS || path.join(process.env.HOME, 'Documents/surewalk/texting/apps-script'), 'Texts.gs'), 'utf8');
const tester = /POLL_TESTERS\s*=\s*\[\s*\{[^}]*first:\s*'([^']+)'[^}]*phone10:\s*'(\d{10})'/.exec(gs);
if (!tester) ok(true, 'no POLL_TESTERS in Texts.gs — poll test skipped');
else {
  const [, tf, tp] = tester, name = tf.charAt(0).toUpperCase() + tf.slice(1);
  // the rider poll is a setting, off by default: a confirmed rider gets no poll until it's turned on
  ok((await rpc('getState')).riderPoll === false, 'the rider poll setting is off by default');
  const op = '5125550177';
  await B.js(`__xl.row(8, ${JSON.stringify(ride(7, 0, 'Omar', 'Rider', op, 'PCL', 'Jester'))})`);
  const oc = await until(async () => { const r = await bridge(); return (r.outbox || []).find(o => o.to.endsWith(op)); }, 'a rider gets the confirmation');
  await bridge([], oc ? [{ outId: oc.outId, status: 'sent' }] : []);
  const oy = await bridge([{ id: 'o1', from: '+1' + op, text: 'yes', ts: NOW + 50e3 }]);
  const oout = (oy.outbox || []).filter(o => o.to.endsWith(op));
  await bridge([], oout.map(o => ({ outId: o.outId, status: 'sent' })));
  ok(oout.some(o => /confirm/i.test(o.body)) && !oout.some(o => /1\/3/.test(o.body)), 'poll off: YES confirms without poll question 1');
  await rpc('setToggle', 'TX_POLL', true);
  ok((await rpc('getState')).riderPoll === true, 'the rider poll setting turns on');
  await B.js(`__xl.row(7, ${JSON.stringify(ride(6, 0, name, 'Rider', tp, 'PCL', 'Kins'))})`);
  const conf = await until(async () => { const r = await bridge(); return (r.outbox || []).find(o => o.to.endsWith(tp)); }, 'the test rider gets the confirmation');
  await bridge([], conf ? [{ outId: conf.outId, status: 'sent' }] : []);
  let q = 0;
  const say = async (text, want, label, none) => {
    const r = await bridge([{ id: 'p' + (++q), from: '+1' + tp, text, ts: NOW + 60e3 + q * 1000 }]);
    const out = (r.outbox || []).filter(o => o.to.endsWith(tp));
    await bridge([], out.map(o => ({ outId: o.outId, status: 'sent' })));
    ok(none ? !out.some(o => want.test(o.body)) : out.some(o => want.test(o.body)), label);
  };
  await say('yes', /1\/3|1 for a text/i, 'YES -> confirmed + poll question 1');
  await say('1', /2\/3|yes, no, or maybe|\?/i, 'answer 1 -> question 2');
  await say('yes', /3\/3|\?/i, 'answer 2 -> question 3');
  await say('more vans please', /thank/i, 'answer 3 -> thanks');
  const poll = JSON.parse(fs.readFileSync(path.join(TMP, 'state', 'poll.json'), 'utf8'));
  const last = poll[poll.length - 1] || [];
  ok(/night/i.test(String((poll[0] || [])[0])) && last[1] === 'Text' && last[2] === 'Yes' && last[3] === 'more vans please' && last[4] === 'finished', 'answers saved in poll.json: ' + JSON.stringify(last));
  ok(!JSON.stringify(poll).includes(tp) && !JSON.stringify(poll).includes(name), 'poll.json has no name or phone');
  ok((fs.statSync(path.join(TMP, 'state', 'poll.json')).mode & 0o077) === 0, 'poll.json readable only by the user');
  ok(!fs.readFileSync(path.join(TMP, 'state', 'messages.jsonl'), 'utf8').includes('"Answers"'), 'poll did not go into the message log');
  ok(!evs().includes('more vans'), 'no poll answers in the GroupMe chat');
  const csv = await (await fetch(`http://127.0.0.1:${SPORT}/poll.csv`)).text();
  ok(csv.includes('more vans please'), '/poll.csv downloads the answers');

  // Verify rider is marked permanently in TX_POLLED so they are never polled again
  const props = JSON.parse(fs.readFileSync(path.join(TMP, 'state', 'props.json'), 'utf8'));
  const polledChunk = Object.keys((props && props.script) || {})
    .filter(k => k.startsWith('TX_POLLED#') && k !== 'TX_POLLED#n')
    .sort()
    .map(k => props.script[k])
    .join('');
  const polledList = JSON.parse(polledChunk || '[]');
  ok(polledList.includes(tp), 'tester phone marked permanently in TX_POLLED (never polled again)');
}

console.log('🧪 test poll & test text via RPC');
await rpc('sendToNumber', '5125558888', 'Hello tester!');
const testTxt = await until(async () => {
  const r = await bridge();
  return (r.outbox || []).find(o => o.to.endsWith('5558888'));
}, 'sendToNumber queued test text to 5125558888');
ok(testTxt && testTxt.body === 'Hello tester!', 'test text sent with correct body');
await bridge([], testTxt ? [{ outId: testTxt.outId, status: 'sent' }] : []);

await rpc('sendTestPoll', '5125559999');
const testPollMsg = await until(async () => {
  const r = await bridge();
  return (r.outbox || []).find(o => o.to.endsWith('5559999'));
}, 'sendTestPoll queued question 1 to 5125559999');
ok(testPollMsg && /1\/3/.test(testPollMsg.body), 'test poll message contains 1/3');
await bridge([], testPollMsg ? [{ outId: testPollMsg.outId, status: 'sent' }] : []);
const q1Reply = await bridge([{ id: 'tp1', from: '+15125559999', text: '1', ts: NOW + 120e3 }]);
ok((q1Reply.outbox || []).some(o => o.to.endsWith('5559999') && /2\/3/.test(o.body)), 'replying 1 to test poll gets question 2/3');

await rpc('sendTestPoll', '5125557777');
const testPoll2 = await until(async () => {
  const r = await bridge();
  return (r.outbox || []).find(o => o.to.endsWith('5557777'));
}, 'sendTestPoll queued to 5125557777');
await bridge([], testPoll2 ? [{ outId: testPoll2.outId, status: 'sent' }] : []);
const q1Custom = await bridge([{ id: 'tp2', from: '+15125557777', text: 'mobile app with live map', ts: NOW + 130e3 }]);
ok((q1Custom.outbox || []).some(o => o.to.endsWith('5557777') && /2\/3/.test(o.body)), 'replying custom idea to Q1 advances to question 2/3');

console.log('＋ Ride: a ride added by hand');
const addRide = async (f, called) => {
  await B.js(`document.getElementById('addBtn').click()`);
  await B.js(`(() => { const f = ${JSON.stringify(f)}; Object.keys(f).forEach(k => { document.getElementById(k).value = f[k]; }); document.getElementById('aCalled').checked = ${!!called}; document.getElementById('aSave').click(); })()`);
};
const lastRideRow = async () => B.js(`Math.max(...SWT.X.rides.map(r => r.row))`);
const before = await lastRideRow();
await addRide({ aFirst: '', aPhone: '5125550160', aPu: 'PCL', aDo: 'Kins' });
await sleep(300);
ok(await B.js(`/first name/.test(document.getElementById('aMsg').textContent) && !document.getElementById('addCard').hidden`), 'missing first name: form stays open with a message');
await B.js(`document.getElementById('aClose').click()`);
await addRide({ aFirst: 'Gus', aLast: 'Hand', aPhone: '(512) 555-0160', aEid: 'gh123', aEmail: 'bad-email', aPu: 'Jester West', aDo: 'Dobie', aAda: 'Yes', aNotes: 'called the line' });
await sleep(300);
ok(await B.js(`/email/.test(document.getElementById('aMsg').textContent) && !document.getElementById('addCard').hidden`), 'bad email: form stays open with a message');
await B.js(`document.getElementById('aEmail').value = 'gus.hand@utexas.edu'; document.getElementById('aSave').click()`);
const nr = before + 1;
await until(() => B.js(`__xl.text(${nr},'${C.first}') === 'Gus'`), `manual ride written to row ${nr}`);
ok(await B.js(`__xl.text(${nr},'A') === '' && /^Added in the Texts panel — called the line$/.test(__xl.text(${nr},'${L(idx(/^Notes/))}')) && __xl.text(${nr},'${L(idx(/^UT EID/))}') === 'gh123' && __xl.text(${nr},'${L(idx(/^Do you require/))}') === 'Yes'`), 'Id blank; EID, ADA and Notes (who added it) filled');
ok(await B.js(`__xl.text(${nr},'${L(idx(/^Email Address/))}') === 'gus.hand@utexas.edu'`), 'email filled');
ok(await B.js(`__xl.text(${nr},'${L(idx(/^I have read/))}') === 'I agree and adhere to the rules and guidelines laid out above.' && __xl.text(${nr},'${L(idx(/^All pick up/))}') === 'I understand and have verified my pick-up location.' && __xl.text(${nr},'${L(idx(/food establishment/))}') === 'I understand.'`), 'the three agreements filled like the form');
ok(await B.js(`(() => { const r = SWT.X.byRow.get(${nr}); return !!r && r.id.charAt(0) === 't' && r.f.ts.slice(0, 16) === SWP.austin().slice(0, 16) && r.f.phone === '5125550160'; })()`), 'the row reads back as tonight\'s ride, submitted now');
ok(await B.js(`document.getElementById('addCard').hidden && document.getElementById('cName').textContent.includes('Gus')`), 'form closes and the new ride is selected');
await B.js(`document.getElementById('addBtn').click()`);
ok(await B.js(`document.activeElement === document.getElementById('aPhone')`), 'phone gets focus when ＋ Ride opens');
await B.js(`document.getElementById('aPhone').value = '5125550160'; document.getElementById('aPhone').dispatchEvent(new Event('input'))`);
ok(await B.js(`!document.getElementById('aPrior').hidden && /Gus Hand/.test(document.getElementById('aPrior').textContent)`), 'entering known phone looks up prior rider name');
await B.js(`document.getElementById('aPriorFill').click()`);
ok(await B.js(`document.getElementById('aFirst').value === 'Gus' && document.getElementById('aLast').value === 'Hand' && document.getElementById('aEid').value === 'gh123' && document.getElementById('aEmail').value === 'gus.hand@utexas.edu' && document.getElementById('aAda').value === 'Yes'`), 'prefill populates prior name, eid, email, and ada');
ok(await B.js(`document.getElementById('aPu').value === '' && document.getElementById('aDo').value === ''`), 'pick-up and drop-off stay empty until trip chip clicked');
ok(await B.js(`document.querySelectorAll('.aprior-tag').length >= 4`), 'filled fields have "from past ride" tags');
await B.js(`(() => { const t = document.querySelector('.aprior-trip'); if (t) t.click(); })()`);
ok(await B.js(`document.getElementById('aPu').value === 'Jester West' && document.getElementById('aDo').value === 'Dobie'`), 'trip chip fills pick-up and drop-off');
await B.js(`document.getElementById('aPriorElse').click()`);
ok(await B.js(`document.getElementById('aFirst').value === '' && document.getElementById('aPhone').value === '5125550160' && document.getElementById('aPrior').hidden`), '"Someone else" clears fill and hides card while keeping phone');
await B.js(`document.getElementById('aClose').click()`);
if (process.env.TABLE) ok(await B.js(`__xl.writes.includes('table row added') && __xl.tableRows() === ${nr}`), 'rides in an Excel table: the row is added through the table');
const gus = await until(async () => { const r = await bridge(); return (r.outbox || []).find(o => o.to.endsWith('5550160')); }, 'texting server texts the manual ride');
await bridge([], gus ? [{ outId: gus.outId, status: 'sent' }] : []);
await B.js(`document.querySelector('#selRide [data-a=called]').click()`);
await until(() => B.js(`__xl.text(${nr},'${C.call}') === '22:00' || /^[0-9]+:[0-9][0-9]$/.test(__xl.text(${nr},'${C.call}'))`), 'panel actions work on a row without an Id (Mark called)');
await addRide({ aFirst: 'Hal', aLast: 'Phone', aPhone: '5125550161', aPu: 'PCL', aDo: 'Kins' }, true);
await until(() => B.js(`__xl.text(${nr + 1},'${C.first}') === 'Hal' && __xl.text(${nr + 1},'${C.disp}') === '' && /^[0-9]+:[0-9][0-9]$/.test(__xl.text(${nr + 1},'${C.call}'))`), '"mark called now": Call Time + Dispatcher filled');
await until(async () => { const r = await rideOf('5125550161'); return r && r.call; }, 'texting server sees Hal as called');
ok(!((await bridge()).outbox || []).some(o => o.to.endsWith('5550161')), 'Hal is not texted');
await B.js(`window.confirm = () => false`);
await addRide({ aFirst: 'Hal', aPhone: '5125550161', aPu: 'PCL', aDo: 'Kins' });
await sleep(800);
ok(await B.js(`__xl.text(${nr + 2},'${C.first}') === '' && !document.getElementById('addCard').hidden`), 'same phone already open tonight: asks first, adds nothing on No');
await B.js(`window.confirm = () => true; document.getElementById('aClose').click()`);
await B.js(`__xl.row(${nr + 2}, ['', '', 'DRIVER', 'NAV'])`); // something under the rides (an old-style roster)
await addRide({ aFirst: 'Ivy', aPhone: '5125550162', aPu: 'PCL', aDo: 'Kins' });
await until(() => B.js(`__xl.text(${nr + 2},'${C.first}') === 'Ivy' && __xl.text(${nr + 3},'C') === 'DRIVER' && __xl.writes.some(w => /inserted/.test(w))`), 'row under the rides not blank: a row is inserted, nothing overwritten');

console.log('＋ Ride on the texting computer\'s dashboard -> the Excel panel adds the row');
const addApi = async b => (await fetch(`http://127.0.0.1:${SPORT}/api/addRide`, { method: 'POST', headers: { 'X-SW-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
const sheetRowOf = phone => B.js(`(() => { const r = SWT.X.rides.find(x => x.f.phone === '${phone}'); return r ? r.row : 0; })()`);
ok(/first name/.test((await addApi({ first: '', phone: '5125550170', pu: 'PCL', do: 'Kins' })).error || ''), 'dashboard add: missing first name refused');
ok(/10 digits/.test((await addApi({ first: 'Jo', phone: '555', pu: 'PCL', do: 'Kins' })).error || ''), 'dashboard add: bad phone refused');
ok(/email/.test((await addApi({ first: 'Jo', phone: '5125550170', email: 'jo at utexas', pu: 'PCL', do: 'Kins' })).error || ''), 'dashboard add: bad email refused');
const ja = await addApi({ first: 'Jo', last: 'Desk', phone: '+1 512-555-0170', eid: 'jd1', email: 'jo.desk@utexas.edu', pu: '=Welch Hall', do: 'Dobie', ada: 'Yes', notes: 'walk-in' });
ok(ja.ok && /^a[0-9a-f]{8}$/.test(ja.id), 'dashboard add accepted: ' + JSON.stringify(ja));
const jrow = await until(() => sheetRowOf('5125550170'), 'the Excel panel wrote the dashboard\'s ride into the sheet');
if (jrow) {
  ok(await B.js(`__xl.text(${jrow},'${C.pu}') === 'Welch Hall' && __xl.text(${jrow},'${L(idx(/^Do you require/))}') === 'Yes' && __xl.text(${jrow},'${L(idx(/^UT EID/))}') === 'jd1' && __xl.text(${jrow},'A') === ''`), 'pick-up (formula sign stripped), ADA, EID filled; Id blank');
  ok(await B.js(`__xl.text(${jrow},'${L(idx(/^Notes/))}') === 'Added on the texting computer #${ja.id} — walk-in'`), 'Notes tag the request id');
  ok(await B.js(`__xl.text(${jrow},'${L(idx(/^Email Address/))}') === 'jo.desk@utexas.edu' && __xl.text(${jrow},'${L(idx(/^I have read/))}').startsWith('I agree and adhere') && __xl.text(${jrow},'${L(idx(/food establishment/))}') === 'I understand.'`), 'dashboard add: email and agreements filled');
  ok(await B.js(`!document.getElementById('cName') || !document.getElementById('cName').textContent.includes('Jo ')`), "the dispatcher's selection isn't changed");
}
await until(async () => { const s = await (await fetch(`http://127.0.0.1:${SPORT}/api/status`, { method: 'POST', headers: { 'X-SW-Token': TOKEN } })).json(); return (s.adds || []).some(a => a.id === ja.id && a.state === 'added' && +a.row === jrow); }, 'server status: the add shows as added, with its row');
console.log('＋ Ride phone lookup on the dashboard');
const lookupApi = async b => (await fetch(`http://127.0.0.1:${SPORT}/api/lookupRider`, { method: 'POST', headers: { 'X-SW-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
const lk = await until(async () => { const r = await lookupApi({ phone: '(512) 555-0170' }); return r.rides ? r : null; }, 'lookup finds Jo by a formatted phone');
ok(lk && lk.names.length === 1 && lk.names[0].first === 'Jo' && lk.names[0].last === 'Desk' && lk.names[0].count === 1, 'lookup: one name, Jo Desk, 1 ride');
ok(lk && lk.eid === 'jd1' && lk.email === 'jo.desk@utexas.edu' && lk.ada === true, 'lookup: EID, email and ADA from the ＋ Ride record ' + JSON.stringify(lk && [lk.eid, lk.email, lk.ada, lk.eids]));
ok(lk && lk.routes[0] && lk.routes[0].pu === 'Welch Hall' && lk.routes[0].do === 'Dobie', 'lookup: recent trip Welch Hall → Dobie');
ok(lk && !lk.optOut && !lk.noShows && lk.eids === 1, 'lookup: no warnings');
ok((await lookupApi({ phone: '15125550170' })).rides === lk.rides && (await lookupApi({ phone: '512555017' })).rides === 0 && (await lookupApi({ phone: '5125554321' })).rides === 0, 'lookup: leading 1 ok; 9 digits / unknown number -> nothing ' + JSON.stringify([(await lookupApi({ phone: '15125550170' })).rides, (await lookupApi({ phone: '512555017' })).rides, (await lookupApi({ phone: '5125554321' })).rides]));
const jt = await until(async () => { const r = await bridge(); return (r.outbox || []).find(o => o.to.endsWith('5550170')); }, 'the dashboard\'s ride gets its confirmation text');
await bridge([], jt ? [{ outId: jt.outId, status: 'sent' }] : []);
ok(/already has an open ride/.test((await addApi({ first: 'Jo', phone: '5125550170', pu: 'PCL', do: 'Kins' })).dup || ''), 'same phone open tonight: the dashboard is asked first');
const replay = chatMsgs().find(m => m.text.includes(`"id":"${ja.id}"`));
await inject(replay.text); // the request seen again (a panel reload re-reads the chat)
await sleep(2500);
ok(await B.js(`SWT.X.rides.filter(x => x.f.phone === '5125550170').length === 1`), 'a request seen twice adds the ride once');
const ka = await addApi({ first: 'Kim', phone: '5125550171', pu: 'PCL', do: 'Kins', called: true });
const krow = await until(() => sheetRowOf('5125550171'), '"already talked to them" ride added');
ok(ka.ok && krow && await B.js(`/^[0-9]+:[0-9][0-9]$/.test(__xl.text(${krow},'${C.call}'))`), 'its Call Time is filled');
await sleep(1500);
ok(!((await bridge()).outbox || []).some(o => o.to.endsWith('5550171')), 'and it is not texted');

console.log('⏱ ETA log: predicted vs. real wait');
const lrow = (await B.js(`Math.max(...SWT.X.rides.map(r => r.row))`)) + 1;
await B.js(`__xl.row(${lrow}, ${JSON.stringify(ride(30, 0, 'Lia', 'Eta', '5125550180', 'PCL', 'Kins'))})`);
const etaRows = () => { try { return JSON.parse(fs.readFileSync(path.join(TMP, 'state', 'eta.json'), 'utf8')); } catch (e) { return []; } };
const etaHead = () => etaRows()[0] || [], ec = n => etaHead().indexOf(n);
const lia = () => etaRows().find(r => +r[1] === lrow);
let liaText = null;
const grabLia = async () => { const r = await bridge(); const o = (r.outbox || []).find(x => x.to.endsWith('5550180')); if (o && !liaText) { liaText = o; await bridge([], [{ outId: o.outId, status: 'sent' }]); } };
await until(async () => { await grabLia(); return lia(); }, 'a new ride gets a row in the ETA log with the prediction');
ok(lia() && lia()[ec('Predicted min')] !== '' && typeof lia()[ec('Ahead')] === 'number' && /–/.test(lia()[ec('Shown')]), 'row has ahead, predicted minutes and the range shown: ' + JSON.stringify(lia()));
await until(async () => { await grabLia(); return liaText; }, 'Lia is texted');
await bridge([{ id: 'eta1', from: '+15125550180', text: 'yes', ts: NOW + 200e3 }]);
await B.js(`__xl.type(${lrow}, '${C.arr}', '22:12')`);
await until(async () => { await bridge(); const r = lia(); return r && r[ec('Outcome')] === 'arrived'; }, 'arrival fills in the real wait');
const lr = lia() || [];
ok(lr[ec('Arrival')] === '22:12' && lr[ec('Wait min')] === 12 && Math.abs(lr[ec('Error min')] - (12 - lr[ec('Predicted min')])) < 0.11, `wait 12 min, error = wait − predicted (${lr[ec('Error min')]})`);
if (C.txs) await until(() => B.js(`/^\\d{1,2}:\\d{2}$/.test(__xl.text(${lrow},'${C.txs}'))`), '"Confirmed" column: the time of Lia\'s YES');
else ok((evs().match(/"txs"/g) || []).length < 40, 'no "Text" column: the status isn\'t bounced back and forth in the chat');
ok(/^\d+–\d+ min$/.test(lr[ec('Quoted in text')] || ''), 'the range quoted in the text is logged: ' + lr[ec('Quoted in text')]);
ok(!JSON.stringify(etaRows()).match(/Lia|Eta"|5550180|Stone|5550101/), 'no names or phone numbers in the ETA log');
ok((fs.statSync(path.join(TMP, 'state', 'eta.json')).mode & 0o077) === 0, 'eta.json readable only by the user');
ok((await rpc('getState')).etaUrl === '/eta.csv', 'Settings links the ETA log');
ok((await (await fetch(`http://127.0.0.1:${SPORT}/eta.csv`)).text()).startsWith('Night,Row,Requested'), '/eta.csv downloads it');

console.log('👥 traveling together (group letter in the Confirmed column) + Mark not ADA');
const idOf = phone => B.js(`(SWT.X.rides.find(x => x.f.phone === '${phone}') || {}).id`);
const ivyId = await idOf('5125550162'), joId = await idOf('5125550170');
const ivyRow = await sheetRowOf('5125550162'), joRow = await sheetRowOf('5125550170');
const ADA = L(idx(/^Do you require/));
if (C.txs) {
  await B.js(`SWT.cl.filter = 'all'; SWT.choose(${JSON.stringify(ivyId)}, false); document.querySelector('#selRide [data-a=pick]').click(), 1`); await sleep(200);
  await B.js(`document.querySelector('#selRide [data-pick="${joId}"]').click(), 1`); await sleep(100);
  await B.js(`document.querySelector('#selRide [data-a=groupGo]').click(), 1`);
  const grp = await until(() => B.js(`(() => { const a = __xl.text(${ivyRow},'${C.txs}'), b = __xl.text(${joRow},'${C.txs}'); return /^Group [A-H]$/.test(a) && a === b.replace(/^.* · /, '') && a; })()`), 'Ivy + Jo grouped: same "Group X" in their Confirmed cells');
  ok(await B.js(`/👥 [A-H] · 2/.test(document.getElementById('list').textContent) && !!document.querySelector('#selRide .gcard')`), 'group badge in the list, group card on the ride');
  await sleep(2500); // the group reaches the texting computer through the chat
  const jy = await bridge([{ id: 'grp1', from: '+15125550170', text: 'yes', ts: NOW + 400e3 }]);
  await bridge([], (jy.outbox || []).map(o => ({ outId: o.outId, status: 'sent' })));
  await until(() => B.js(`/^\\d{1,2}:\\d{2} · ${grp}$/.test(__xl.text(${joRow},'${C.txs}'))`), `Jo says YES: the texting computer's time joins the group ("H:MM · ${grp}")`);
  await B.js(`SWT.choose(${JSON.stringify(ivyId)}, false); document.querySelector('#selRide [data-a=ungroup][data-id="${ivyId}"]').click(), 1`);
  await until(() => B.js(`__xl.text(${ivyRow},'${C.txs}') === '' && /^\\d{1,2}:\\d{2}$/.test(__xl.text(${joRow},'${C.txs}'))`), 'removing Ivy dissolves a group of 2: Ivy blank, Jo keeps only the time');
}
await B.js(`SWT.cl.filter = 'all'; SWT.choose(${JSON.stringify(joId)}, false), 1`); await sleep(200);
await B.js(`document.querySelector('#selRide [data-a=notAda]').click(), 1`);
await until(() => B.js(`__xl.text(${joRow},'${ADA}') === 'No'`), 'Mark not ADA: the ADA cell becomes No');

console.log('👥 group rides by text: same pickup soon after each other -> asked who they ride with');
{
  const P = { max: '5125550190', nia: '5125550191', oli: '5125550192' };
  const top = (await B.js(`Math.max(...SWT.X.rides.map(r => r.row))`)) + 1;
  await B.js(`__xl.row(${top}, ${JSON.stringify(ride(40, 0, 'Max', 'Grp', P.max, 'Gregory Gym', 'Kins'))})`);
  await B.js(`__xl.row(${top + 1}, ${JSON.stringify(ride(41, 0, 'Nia', 'Grp', P.nia, 'Gregory Gym', 'Kins'))})`);
  await B.js(`__xl.row(${top + 2}, ${JSON.stringify(ride(42, 0, 'Oli', 'Grp', P.oli, 'Gregory Gym', 'PCL'))})`);
  const got = {}; // phone -> [bodies] since the last take
  const pump = async (inbound = []) => { const r = await bridge(inbound); const out = r.outbox || []; out.forEach(o => { const k = o.to.slice(-10); (got[k] = got[k] || []).push(o.body); }); if (out.length) await bridge([], out.map(o => ({ outId: o.outId, status: 'sent' }))); return out; };
  const take = k => { const b = got[k] || []; got[k] = []; return b; };
  await until(async () => { await pump(); return Object.values(P).every(k => (got[k] || []).length); }, 'Max, Nia and Oli get their confirmation texts');
  Object.values(P).forEach(take);
  let ts = NOW + 600e3;
  const say = async (k, text) => { await pump([{ id: 'gr' + ts, from: '+1' + k, text, ts: ts += 1000 }]); await sleep(300); await pump(); return take(k); };
  const mx = await say(P.max, 'yes');
  ok(mx.length === 1 && /you're confirmed/i.test(mx[0]) && /Reply with their first names/.test(mx[0]), 'Max says YES: one text, "you\'re confirmed" + who are you riding with? (same route as Nia)');
  ok(!/Nia|Oli/.test(mx.join(' ')), 'the question names no other rider');
  const ol = await say(P.oli, 'yes');
  ok(ol.length === 1 && /Going with friends\?/.test(ol[0]) && !/Max|Nia/.test(ol[0]), 'Oli (same pickup, other drop-off) gets the softer hint');
  const mx2 = await say(P.max, 'nia');
  ok(mx2.length === 1 && /you and Nia/.test(mx2[0]), 'Max answers "nia": grouped, told "you and Nia"');
  let st = await rpc('getState');
  const g1 = (st.rides.find(r => r.phone10 === P.max) || {}).group;
  ok(g1 && g1.members.length === 2 && !g1.both && g1.members.some(m => m.first === 'Nia'), 'dashboard: Max is grouped with Nia, one side so far');
  const mrow = top, nrow = top + 1;
  const L1 = C.txs ? await until(() => B.js(`(() => { const a = __xl.text(${mrow},'${C.txs}'), b = __xl.text(${nrow},'${C.txs}'); const m = /^\\d{1,2}:\\d{2} · Group ([A-H])$/.exec(a); return m && b === 'Group ' + m[1] && m[1]; })()`), 'Confirmed column: Max "H:MM · Group X", Nia (not confirmed yet) "Group X"') : 'x';
  const ni = await say(P.nia, "Okay - I'm with Max");
  ok(ni.length === 1 && /you're confirmed/i.test(ni[0]) && /you and Max/.test(ni[0]), 'Nia: "Okay - I\'m with Max" = a YES; one text, confirmed + grouped');
  st = await rpc('getState');
  const g2 = (st.rides.find(r => r.phone10 === P.nia) || {}).group;
  ok(g2 && g2.both && g2.letter && (!C.txs || g2.letter === L1), `dashboard: they named each other (Group ${g2 && g2.letter})`);
  ok(!st.flags.some(f => ['Confirmed + more', 'Reply', 'Group?'].includes(f.kind) && [P.max, P.nia].includes(f.phone)), 'no flags for Max or Nia');
  if (C.txs) await until(() => B.js(`/^\\d{1,2}:\\d{2} · Group ${L1}$/.test(__xl.text(${nrow},'${C.txs}'))`), 'Nia\'s Confirmed cell gets her time next to the group');
  const o2 = await say(P.oli, 'no just me');
  st = await rpc('getState');
  ok(o2.length === 0 && !st.flags.some(f => f.phone === P.oli), 'Oli: "no just me" = riding alone: no "reply CANCEL" text, no flag');
  ok(!(st.rides.find(r => r.phone10 === P.oli) || {}).group && (st.rides.find(r => r.phone10 === P.oli) || {}).state === 'confirmed', 'Oli stays confirmed and ungrouped');
  // names that don't fit -> a "Group?" flag for the dispatcher, nobody grouped
  const Q = { quinn: '5125550193', rae: '5125550194' }, qtop = top + 3;
  await B.js(`__xl.row(${qtop}, ${JSON.stringify(ride(43, 0, 'Quinn', 'Grp', Q.quinn, 'Gregory Gym', 'Kins'))})`);
  await B.js(`__xl.row(${qtop + 1}, ${JSON.stringify(ride(44, 0, 'Rae', 'Grp', Q.rae, 'Gregory Gym', 'PCL'))})`);
  await until(async () => { await pump(); return Object.values(Q).every(k => (got[k] || []).length); }, 'Quinn and Rae get their confirmation texts');
  Object.values(Q).forEach(take);
  ok(/Reply with their first names/.test((await say(Q.quinn, 'yes')).join(' ')), 'Quinn says YES and is asked too');
  await say(Q.quinn, 'Oli');
  st = await rpc('getState');
  ok(st.flags.some(f => f.kind === 'Group?' && f.phone === Q.quinn && /riding alone/.test(f.note)) && !(st.rides.find(r => r.phone10 === Q.quinn) || {}).group, 'Quinn names Oli, who said "just me": flagged, not grouped');
  await say(Q.rae, 'yes');
  const rz = await say(Q.rae, 'me and zed');
  st = await rpc('getState');
  ok(rz.length === 0 && st.flags.some(f => f.kind === 'Group?' && f.phone === Q.rae && /zed/.test(f.note)), 'Rae names "Zed", who has no ride: flagged, no text back');
  if (C.txs) { // a dispatcher removes Max from the group in the sheet: the texting computer doesn't put it back
    await B.js(`__xl.type(${mrow}, '${C.txs}', '')`); await sleep(2500); await pump(); await sleep(1500);
    ok(await B.js(`/^\\d{1,2}:\\d{2}$/.test(__xl.text(${mrow},'${C.txs}'))`), 'the group letter is written once: a dispatcher\'s change in the sheet stands (only the YES time comes back)');
  }
}

console.log('📍 drop-off check: residence / campus building? (safe list, remembered ✓ Valid / ✗ Not valid)');
{
  const P = { val: '5125550195', unk: '5125550196', again: '5125550197', addr: '5125550198' };
  const top = (await B.js(`Math.max(...SWT.X.rides.map(r => r.row))`)) + 1;
  await B.js(`__xl.row(${top}, ${JSON.stringify(ride(50, 0, 'Uma', 'Drop', P.val, 'PCL', 'The Eastwood'))})`); // on the safe list (old sheets)
  await B.js(`__xl.row(${top + 1}, ${JSON.stringify(ride(51, 0, 'Vic', 'Drop', P.unk, 'PCL', 'Pluckers Wing Bar'))})`); // not on it
  await B.js(`__xl.row(${top + 2}, ${JSON.stringify(ride(52, 0, 'Wes', 'Drop', P.addr, 'PCL', '2410 Leon St'))})`); // a street address near campus
  const got = {};
  const pump = async () => { const r = await bridge(); const out = r.outbox || []; out.forEach(o => { const k = o.to.slice(-10); (got[k] = got[k] || []).push(o.body); }); if (out.length) await bridge([], out.map(o => ({ outId: o.outId, status: 'sent' }))); return out; };
  await until(async () => { await pump(); return [P.val, P.unk, P.addr].every(k => (got[k] || []).length); }, 'Uma (safe list), Vic (unknown drop-off) and Wes (address) all get the normal confirmation');
  let st = await rpc('getState');
  const by = k => st.rides.find(r => r.phone10 === k) || {};
  ok(by(P.val).drop === '' && by(P.addr).drop === '' && !st.flags.some(f => [P.val, P.addr].includes(f.phone) && /drop-off/i.test(f.kind)), 'safe-list place and near-campus address: no drop-off flag');
  ok(by(P.unk).drop === 'unknown' && st.flags.some(f => f.kind === 'Drop-off?' && f.phone === P.unk && /Pluckers/.test(f.note)), 'unknown drop-off: "Drop-off?" flag for the dispatcher, ride still texted');
  ok(/Reply YES/i.test((got[P.unk] || [])[0] || ''), 'the rider with the unknown drop-off got the usual confirmation');
  ok(st.templates.cx_notres && /residence/.test(st.templates.cx_notres) && st.cancelNotices.some(c => c.key === 'cx_notres'), 'the "not a residence / campus building" cancel text is an editable template');
  st = await rpc('markDropoff', by(P.unk).id, false);
  ok(by(P.unk).drop === 'invalid' && !st.flags.some(f => f.kind === 'Drop-off?' && f.phone === P.unk) && st.flags.some(f => f.kind === 'Not a valid drop-off' && f.phone === P.unk), '✗ Not valid: the ride shows ✗ Drop-off with the cancel text offered');
  ok(by(P.unk).state !== 'flagged', 'a rider already texted keeps their ride until the dispatcher cancels it');
  const dec = await rpc('getDropDecisions');
  ok(dec.length === 1 && dec[0].ok === false && /Pluckers/.test(dec[0].text) && !JSON.stringify(dec).match(/Vic|5550196/), 'the decision is remembered (place only — no name or phone): ' + JSON.stringify(dec));
  const props = JSON.parse(fs.readFileSync(path.join(TMP, 'state', 'props.json'), 'utf8'));
  const rep = await rpc('exportPlaceReports');
  ok(JSON.stringify(props).includes('PLACE_REPORTS') && rep.length === 1 && rep[0].kind === 'dropoff' && rep[0].verdict === 'invalid' && !JSON.stringify(rep).match(/Vic|5550196/), 'stored in PLACE_REPORTS on this computer (place only): ' + JSON.stringify(rep));
  // another rider to the same place, spelled differently: held, not texted, cancel text ready
  await B.js(`__xl.row(${top + 3}, ${JSON.stringify(ride(53, 0, 'Xan', 'Drop', P.again, 'FAC', 'pluckers wing bar.'))})`);
  await until(async () => { await pump(); st = await rpc('getState'); return by(P.again).id; }, 'the next ride to that place is seen');
  await sleep(1500); await pump(); st = await rpc('getState');
  ok(!(got[P.again] || []).length && by(P.again).state === 'flagged' && by(P.again).invalid === 'cx_notres' && st.flags.some(f => f.kind === 'Not a valid drop-off' && f.phone === P.again), 'marked not valid before: the next ride there is held, not texted, cancel text ready');
  // the dispatcher changes their mind: ✓ Valid frees the held ride and clears every drop-off flag for the place
  st = await rpc('markDropoff', by(P.again).id, true);
  ok(by(P.again).state === 'ready' && !by(P.again).invalid && by(P.again).drop === '' && by(P.unk).drop === '' && !st.flags.some(f => /drop-off/i.test(f.kind) && [P.unk, P.again].includes(f.phone)), '✓ Valid: held ride back to "not texted", flags gone for both rides');
  ok((await rpc('getDropDecisions'))[0].ok === true, '✓ Valid is remembered');
  st = await rpc('forgetDropoff', (await rpc('getDropDecisions'))[0].key);
  ok((await rpc('getDropDecisions')).length === 0 && by(P.unk).drop === 'unknown' && st.flags.some(f => f.kind === 'Drop-off?' && f.phone === P.unk), 'Forget: asked again');
  ok(page.includes('markDropoff') && page.includes('? Drop-off'), 'dashboard has the ? Drop-off chip and ✓ Valid / ✗ Not valid buttons');
}

console.log('Calling in its own window (Excel dialog stand-in): the side panel does the sheet work');
await B.js(`(() => {
  SWT.closeCalling(); window.__SWT_HOSTED = true; window.SWT_TEST.callingUrl = '/panel?remote=1';
  Office.EventType = { DialogMessageReceived: 'm', DialogEventReceived: 'e' }; Office.AsyncResultStatus = { Succeeded: 'succeeded' };
  Office.context = { ui: { displayDialogAsync(url, o, cb) {
    const f = document.createElement('iframe'); f.id = 'dlgFrame'; f.src = url; f.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:99;background:#fff';
    const hs = {}; window.__dlgMsg = m => { if (hs.m) hs.m({ message: m }); };
    document.body.appendChild(f);
    cb({ status: 'succeeded', value: { addEventHandler(t, h) { hs[t] = h; }, messageChild(m) { if (f.contentWindow.__fromParent) f.contentWindow.__fromParent(m); }, close() { f.remove(); if (hs.e) hs.e({}); } } });
  } } };
  SWT.openCalling(); return 1; })()`);
const W = `document.getElementById('dlgFrame').contentWindow`;
await until(() => B.js(`!!document.getElementById('dlgFrame') && ${W}.document.querySelectorAll('#list .crow').length > 0 && ${W}.document.getElementById('home').hidden !== undefined`), 'the Calling window opens and gets the rides from the side panel');
ok(await B.js(`document.getElementById('calling').hidden && getComputedStyle(${W}.document.getElementById('home')).display === 'none'`), 'side panel keeps its launcher; the window shows only Calling');
const hRow = await sheetRowOf('5125550162');
await B.js(`${W}.SWT.cl.filter = 'all'; ${W}.SWT.choose(${JSON.stringify(ivyId)}, false); 1`); await sleep(300);
await B.js(`${W}.document.querySelector('#selRide [data-a=called]').click(), 1`);
await until(() => B.js(`/^\\d{1,2}:\\d{2}$/.test(__xl.text(${hRow},'${C.call}'))`), 'Mark called in the window: the side panel writes the Call Time');
await until(() => B.js(`/Ivy/.test(${W}.document.getElementById('toastTxt').textContent) && !${W}.document.getElementById('toastUndo').hidden`), 'the window shows the toast with Undo');
await B.js(`${W}.document.getElementById('toastUndo').click(), 1`);
await until(() => B.js(`__xl.text(${hRow},'${C.call}') === ''`), 'Undo from the window puts the sheet back');

console.log('privacy');
const all = evs();
ok(!/Reply YES|SURE Walk got your ride|your ride is cancelled/i.test(all), 'no text-message content in the chat');
ok(chatMsgs().every(m => m.text.length <= 1000), 'every chat message under 1,000 characters');
if (VIA_LAPTOP) {
  console.log('laptop sync');
  ok(gmChatHits === 0, 'no GroupMe chat traffic at all');
  ok((fs.statSync(path.join(TMP, 'state', 'chat.jsonl')).mode & 0o077) === 0, 'the laptop chat file is readable only by the user');
  ok((await lapi('/groups', { headers: { 'X-Access-Token': 'f'.repeat(32) } })).status === 401, 'a wrong laptop key is refused');
  ok((await lapi('/groups', { headers: { Origin: 'https://evil.example' } })).status === 403, 'other websites are refused even with the key');
  const pre = await fetch(`http://127.0.0.1:${SPORT}/v3/groups/local/messages`, { method: 'OPTIONS', headers: { Origin: 'https://script-lab.public.cdn.office.net', 'Access-Control-Request-Private-Network': 'true', 'Access-Control-Request-Headers': 'x-access-token' } });
  ok(pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'https://script-lab.public.cdn.office.net' && pre.headers.get('access-control-allow-private-network') === 'true', 'the Script Lab panel\'s preflight is allowed (local network access)');
  const st = await (await fetch(`http://127.0.0.1:${SPORT}/api/status`, { method: 'POST', headers: { 'X-SW-Token': TOKEN } })).json();
  ok(st.mode === 'local' && st.localKey === LKEY && st.ready && st.lastExcelAt > 0, 'dashboard: syncing with Excel on this laptop, key shown, panel seen');
  ok((await fetch(`http://127.0.0.1:${SPORT}/v3/groups`)).status === 401, 'no key, no access');
}
const logRows = fs.readFileSync(path.join(TMP, 'state', 'messages.jsonl'), 'utf8').trim().split('\n').length;
ok(logRows >= 3, `the message log stays on this computer (${logRows} rows)`);
ok((fs.statSync(path.join(TMP, 'state', 'messages.jsonl')).mode & 0o077) === 0, 'log readable only by the user');

if (process.env.SHOTS) {
  const shot = async (url, file, w, h, js) => { const t = await (await fetch(`http://127.0.0.1:${CPORT}/json/new?${url}`, { method: 'PUT' })).json(); const s = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => s.addEventListener('open', r)); let i = 0; const c = (m, p) => new Promise(r => { const id = ++i; s.addEventListener('message', e => { const x = JSON.parse(e.data); if (x.id === id) r(x.result); }); s.send(JSON.stringify({ id, method: m, params: p })); }); await c('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); await c('Page.reload'); await sleep(3500); if (js) { await c('Runtime.evaluate', { expression: js }); await sleep(800); } const r = await c('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); s.close(); };
  await B.js(`__xl.click(4)`);
  await shot(`http://127.0.0.1:${GPORT}/panel?click=2`, process.env.SHOTS + '/panel.png', 380, 900);
  await shot(`http://127.0.0.1:${SPORT}/`, process.env.SHOTS + '/dashboard.png', 1280, 800);
  await shot(`http://127.0.0.1:${SPORT}/`, process.env.SHOTS + '/dashboard-add.png', 1280, 900, "document.getElementById('swAdd').click()");
  await shot(`http://127.0.0.1:${GPORT}/panel`, process.env.SHOTS + '/panel-add.png', 380, 900, "document.getElementById('addBtn').click()");
  await shot(`http://127.0.0.1:${SPORT}/setup`, process.env.SHOTS + '/setup.png', 800, 800);
}
B.close(); S.p.kill(); gm.close();
await sleep(300);
if (fails) console.log(S.out().split('\n').slice(-40).join('\n'));
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
