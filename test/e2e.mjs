// End-to-end: fake GroupMe + the real texting server (running the real .gs code) + the real Excel panel on a fake
// Excel in headless Chromium + a pretend phone bridge. Run with test/run.sh.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.dirname(HERE);
const TMP = process.env.TMPDIR_E2E || fs.mkdtempSync('/tmp/swt-');
const GPORT = 8791, SPORT = 8792, CPORT = 9339;
const NOW = Date.UTC(2026, 10, 12, 4, 0); // 10:00 PM in Austin, Wed Nov 11 2026
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, msg) => { if (c) { passes++; console.log('  ✓', msg); } else { fails++; console.log('  ✗', msg); } };
async function until(fn, msg, ms = 25000) {
  const t0 = Date.now();
  for (;;) { let v; try { v = await fn(); } catch (e) { v = false; } if (v) { ok(true, msg); return v; } if (Date.now() - t0 > ms) { ok(false, msg + ' (timed out)'); return null; } await sleep(300); }
}

/* ---------- fake GroupMe ---------- */
const msgs = []; let seq = 1000;
const gm = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST' };
  const send = (code, body, type = 'application/json') => { res.writeHead(code, Object.assign({ 'Content-Type': type }, cors)); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  if (req.method === 'OPTIONS') return send(204, '');
  if (u.pathname === '/panel') return send(200, panelPage(u.searchParams.get('click')), 'text/html');
  if (u.pathname.startsWith('/files/')) return send(200, fs.readFileSync(path.join(ROOT, u.pathname.slice(7))), 'text/javascript');
  if (u.pathname === '/v3/groups') return send(200, { response: [{ id: 'g1', name: 'SURE Walk Texts sync' }] });
  const m = /^\/v3\/groups\/g1\/messages$/.exec(u.pathname);
  if (!m) return send(404, {});
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
  'Do you require Americans with Disabilities Act assistance?', 'Location', 'Vehicle Type', 'Driver', 'Navigator', 'Agree 1', 'Agree 2', 'Agree 3', 'Email Address:', 'Reason for Cancellation', 'Notes']);
const idx = re => HEADER.findIndex(h => re.test(h));
const L = n => String.fromCharCode(65 + n);
const C = { call: L(idx(/^Call Time/)), disp: L(idx(/^Dispatcher/)), rsn: L(idx(/^Reason/)), pu: L(idx(/^Pick-up/)), do: L(idx(/^Drop-off/)), first: L(idx(/^First Name/)) };
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
], paint: [[4, '#000000', '#FFFFFF']] };
function panelPage(click) {
  const html = fs.readFileSync(path.join(ROOT, 'excel/panel.html'), 'utf8');
  const clock = `(() => { const R = Date, T0 = ${NOW}, R0 = R.now(); window.Date = class extends R { constructor(...a) { super(...(a.length ? a : [T0 + R.now() - R0])); } static now() { return T0 + R.now() - R0; } }; })();`;
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}
<script>${clock}
window.FAKE_SHEET = ${JSON.stringify(SHEET)};
window.SWT_TEST = { tick: 1000, gap: 300, gm: 'http://127.0.0.1:${GPORT}/v3' };
localStorage.setItem('swt.settings', JSON.stringify({ name: 'T. Tester', dispName: true, token: 'tok_${'a'.repeat(30)}', groupId: 'g1', groupName: 'SURE Walk Texts sync', sync: true }));
window.confirm = () => true;
${click ? `setTimeout(() => { __xl.click(${+click}); setTimeout(() => document.querySelector('#selRide [data-a=cancel]').click(), 400); }, 1500);` : ''}
</script>
<script src="/files/test/fake-excel.js"></script><script src="/files/protocol.js"></script><script src="/files/excel/panel.js"></script></body></html>`;
}

/* ---------- Chromium over the DevTools protocol ---------- */
async function browser() {
  const prof = path.join(TMP, 'chrome');
  const bin = ['chromium-browser', 'chromium', 'google-chrome'].map(b => '/usr/bin/' + b).find(b => fs.existsSync(b));
  const ch = spawn(bin, ['--headless=new', '--no-sandbox', '--password-store=basic', `--user-data-dir=${prof}`, `--remote-debugging-port=${CPORT}`, '--no-first-run', `http://127.0.0.1:${GPORT}/panel`], { stdio: 'ignore' });
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
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ token: 'tok_' + 'b'.repeat(30), groupId: 'g1', groupName: 'SURE Walk Texts sync' }));
  const p = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(`const R=Date,T0=${NOW},R0=R.now();globalThis.Date=class extends R{constructor(...a){super(...(a.length?a:[T0+R.now()-R0]))}static now(){return T0+R.now()-R0}};`), path.join(ROOT, 'server/server.mjs')], {
    env: Object.assign({}, process.env, { PORT: SPORT, SUREWALK_STATE: path.join(TMP, 'state'), XDG_CONFIG_HOME: path.join(TMP, 'cfg'), GROUPME_API: `http://127.0.0.1:${GPORT}/v3`, SW_POLL_MS: 700, SW_POST_GAP_MS: 200 }),
    stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  return { p, out: () => out };
}

gm.listen(GPORT, '127.0.0.1');
const S = server();
await sleep(1500);
const page = await (await fetch(`http://127.0.0.1:${SPORT}/`)).text();
const TOKEN = /var TOKEN = '([a-f0-9]+)'/.exec(page)[1];
const rpc = async (fn, ...args) => { const r = await (await fetch(`http://127.0.0.1:${SPORT}/rpc`, { method: 'POST', headers: { 'X-SW-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ fn, args }) })).json(); if (!r.ok) throw new Error(r.error); return r.result; };
const KEY = JSON.parse(fs.readFileSync(path.join(TMP, 'state', 'props.json'), 'utf8')).script.TX_KEY;
const bridge = async (inbound = [], results = []) => (await fetch(`http://127.0.0.1:${SPORT}/bridge`, { method: 'POST', body: JSON.stringify({ key: KEY, op: 'sync', bridge: { connected: true, healthy: true, version: 'test' }, inbound, results }) })).json();
const rideOf = async id => (await rpc('getState')).rides.find(r => r.phone10 === id);

console.log('server + panel');
ok(page.includes('google.script.run') || page.includes('window.google'), 'dashboard served with the local google.script.run');
await rpc('setToggle', 'TX_AUTOTEXT', true); // before any ride arrives (rides seen while it's off are never auto-texted)
const B = await browser();
const sees = async () => (await rpc('getState')).rides.length;
await until(async () => (await sees()) === 3, 'panel posted tonight\'s 3 rides; the texting server sees them');
ok(await B.js("!!document.getElementById('restartBtn')"), 'restart button present in the bar');
const evs = () => msgs.map(m => m.text).join('\n');
ok(/‹sw1›\{"e":"ride","id":"f1"/.test(evs()), 'rides are keyed by the form Id');

const groupsRes = await (await fetch(`http://127.0.0.1:${SPORT}/api/groups`, {
  method: 'POST',
  headers: { 'X-SW-Token': TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: '  Bearer "tok_' + 'c'.repeat(30) + '"  ' })
})).json();
ok(groupsRes.ok && groupsRes.groups && groupsRes.groups.length > 0, 'api/groups checks and cleans token without prior config');

console.log('auto-text -> Call Time back in the sheet');
const first = await until(async () => { const r = await bridge(); return r.outbox && r.outbox.length >= 2 && r.outbox; }, 'confirmations queued for Ava and Ben (Cara is cancelled)');
ok(first && !first.some(o => o.to.endsWith('5550103')), 'no text to the cancelled ride');
await bridge([], (first || []).map(o => ({ outId: o.outId, status: 'sent' })));
await until(() => B.js(`__xl.text(2,'${C.call}') === '22:00' && __xl.text(3,'${C.call}') === '22:00'`), 'Call Time 22:00 written into F2 and F3 by the panel');

console.log('rider texts CANCEL -> row cancelled in the sheet');
let res = await bridge([{ id: 'in1', from: '+15125550102', text: 'cancel', ts: NOW + 5000 }]);
await until(() => B.js(`__xl.bg(3,'A') === '#000000' && __xl.text(3,'${C.rsn}') !== '' && __xl.text(3,'${C.call}') === ''`), 'row 3 black, reason in X, Call Time cleared');
ok(/cancel/i.test(JSON.stringify(res.outbox || [])) || (res.outbox || []).length > 0, 'rider gets the cancelled text');

console.log('panel actions -> texting server');
await B.js(`__xl.click(2)`);
await until(() => B.js(`!!document.querySelector('#selRide [data-a=edit]')`), 'clicking row 2 shows Ava');
await B.js(`document.querySelector('#selRide [data-a=edit]').click()`);
await B.js(`document.getElementById('fPu').value = 'Welch Hall'; document.querySelector('#selRide [data-a=editGo]').click()`);
await until(() => B.js(`__xl.text(2,'${C.pu}') === 'Welch Hall'`), 'pick-up changed in the sheet');
await until(async () => (await rideOf('5125550101')).pickup === 'Welch Hall', 'texting server got the new pick-up');
await B.js(`document.querySelector('#selRide [data-a=undo]').click()`);
await until(async () => (await rideOf('5125550101')).pickup === 'PCL', 'undo restored PCL in the sheet and the server');

console.log('a new ride the dispatcher calls first is not texted');
await B.js(`__xl.row(5, ${JSON.stringify(ride(4, 0, 'Dee', 'Park', '5125550104', 'PCL', 'Kins'))})`);
await B.js(`__xl.click(5)`);
await until(() => B.js(`!!document.querySelector('#selRide [data-a=called]:not([disabled])') && document.querySelector('#selRide h2').textContent.includes('Dee')`), 'Dee selected');
await B.js(`document.querySelector('#selRide [data-a=called]').click()`);
await until(() => B.js(`__xl.text(5,'${C.call}') === '22:00' && __xl.text(5,'${C.disp}') === 'T. Tester'`), 'Mark called: F5 = now, Dispatcher = my name');
await until(async () => { const r = await rideOf('5125550104'); return r && r.call === '22:00'; }, 'texting server sees Dee as called');
res = await bridge();
ok(!(res.outbox || []).some(o => o.to.endsWith('5550104')), 'Dee is not texted');

console.log('cancel + duplicate from the panel');
await B.js(`document.querySelector('#selRide [data-a=dup]').click()`);
await until(() => B.js(`__xl.bg(5,'A') === '#FF0000'`), 'duplicate: row 5 red');
await until(async () => (await rideOf('5125550104')).sheetState === 'dup', 'texting server sees the duplicate');
await B.js(`__xl.click(2)`); await sleep(300);
await B.js(`document.querySelector('#selRide [data-a=cancel]').click()`);
await B.js(`document.getElementById('fReason').value = 'Not Answering'; document.querySelector('#selRide [data-a=cancelGo]').click()`);
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
msgs.push({ id: String(++seq), created_at: Math.floor(Date.now() / 1000), text: `💬 test ‹sw1›{"e":"upd","id":"f2","src":"s","f":{"call":"22:05"},"was":{"call":""}}` });
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
  await B.js(`__xl.row(7, ${JSON.stringify(ride(6, 0, name, 'Rider', tp, 'PCL', 'Kins'))})`);
  const conf = await until(async () => { const r = await bridge(); return (r.outbox || []).find(o => o.to.endsWith(tp)); }, 'the test rider gets the confirmation');
  await bridge([], conf ? [{ outId: conf.outId, status: 'sent' }] : []);
  let q = 0;
  const say = async (text, want, label) => {
    const r = await bridge([{ id: 'p' + (++q), from: '+1' + tp, text, ts: NOW + 60e3 + q * 1000 }]);
    const out = (r.outbox || []).filter(o => o.to.endsWith(tp));
    await bridge([], out.map(o => ({ outId: o.outId, status: 'sent' })));
    ok(out.some(o => want.test(o.body)), label);
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

console.log('privacy');
const all = evs();
ok(!/Reply YES|SURE Walk got your ride|your ride is cancelled/i.test(all), 'no text-message content in the chat');
ok(msgs.every(m => m.text.length <= 1000), 'every chat message under 1,000 characters');
const logRows = fs.readFileSync(path.join(TMP, 'state', 'messages.jsonl'), 'utf8').trim().split('\n').length;
ok(logRows >= 3, `the message log stays on this computer (${logRows} rows)`);
ok((fs.statSync(path.join(TMP, 'state', 'messages.jsonl')).mode & 0o077) === 0, 'log readable only by the user');

if (process.env.SHOTS) {
  const shot = async (url, file, w, h) => { const t = await (await fetch(`http://127.0.0.1:${CPORT}/json/new?${url}`, { method: 'PUT' })).json(); const s = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => s.addEventListener('open', r)); let i = 0; const c = (m, p) => new Promise(r => { const id = ++i; s.addEventListener('message', e => { const x = JSON.parse(e.data); if (x.id === id) r(x.result); }); s.send(JSON.stringify({ id, method: m, params: p })); }); await c('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); await c('Page.reload'); await sleep(3500); const r = await c('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); s.close(); };
  await B.js(`__xl.click(4)`);
  await shot(`http://127.0.0.1:${GPORT}/panel?click=2`, process.env.SHOTS + '/panel.png', 380, 900);
  await shot(`http://127.0.0.1:${SPORT}/`, process.env.SHOTS + '/dashboard.png', 1280, 800);
  await shot(`http://127.0.0.1:${SPORT}/setup`, process.env.SHOTS + '/setup.png', 800, 800);
}
B.close(); S.p.kill(); gm.close();
await sleep(300);
if (fails) console.log(S.out().split('\n').slice(-40).join('\n'));
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
