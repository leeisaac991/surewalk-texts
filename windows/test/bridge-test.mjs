// End-to-end test of the Windows phone bridge: the real texting server (throwaway state) + bridge.ps1 + a pretend iPhone.
//   node windows/test/bridge-test.mjs          (Windows: built-in powershell.exe; elsewhere: pwsh, or set PWSH=/path/to/pwsh)
// Env: SUREWALK_GS (the .gs folder), BT_PORT_BASE (default 8900: server +1, phone +2).
// Touches nothing outside a temp folder: own state, own config, no GroupMe, no real phone.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakePhone } from './fake-phone.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
// repo: <root>/server/server.mjs; Windows package: app/texts-panel/server/server.mjs
const SERVER = [path.join(ROOT, 'server', 'server.mjs'), path.join(ROOT, 'texts-panel', 'server', 'server.mjs')].find(f => fs.existsSync(f));
const BASE = +process.env.BT_PORT_BASE || 8900, SPORT = BASE + 1, PPORT = BASE + 2;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-bridge-test-'));
const BST = path.join(TMP, 'bridge');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, what) => { if (c) { pass++; console.log('  ok  ' + what); } else { fail++; console.log('  FAIL ' + what); } };
async function until(fn, what, ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) { ok(true, what); return true; } } catch (e) { /* not yet */ } await sleep(250); }
  ok(false, what); return false;
}
const pad = n => String(n).padStart(2, '0');
const mapDt = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };
const blog = () => read(path.join(BST, 'bridge.log'));
const msgs = () => read(path.join(TMP, 'state', 'messages.jsonl'));
const inRows = t => msgs().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r[2] === 'in' && r[7] === t).length; // incoming rows with exactly this text
const kids = [];
const cleanup = () => { kids.forEach(k => { try { k.kill(); } catch (e) {} }); };
process.on('exit', () => { cleanup(); if (process.env.KEEP) { console.log('kept ' + TMP); return; } try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

// ---- server
const env = Object.assign({}, process.env, {
  PORT: String(SPORT), SUREWALK_STATE: path.join(TMP, 'state'), XDG_CONFIG_HOME: path.join(TMP, 'cfg'), LOCALAPPDATA: path.join(TMP, 'local'),
  GROUPME_API: 'http://127.0.0.1:9/v3', SW_SEND_GAP_MS: '0',
});
const srv = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
kids.push(srv);
let srvOut = ''; srv.stdout.on('data', d => srvOut += d); srv.stderr.on('data', d => srvOut += d);
console.log('server');
if (!await until(async () => (await fetch(`http://127.0.0.1:${SPORT}/`)).ok, 'texting server starts with throwaway state')) { console.log(srvOut); process.exit(1); }
const page = await (await fetch(`http://127.0.0.1:${SPORT}/`)).text();
const TOKEN = /var TOKEN = '([a-f0-9]+)'/.exec(page)[1];
const rpc = async (fn, ...args) => { const r = await (await fetch(`http://127.0.0.1:${SPORT}/rpc`, { method: 'POST', headers: { 'X-SW-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ fn, args }) })).json(); if (!r.ok) throw new Error(r.error); return r.result; };
const KEY = JSON.parse(read(path.join(TMP, 'state', 'props.json'))).script.TX_KEY;
fs.mkdirSync(BST, { recursive: true });
fs.writeFileSync(path.join(BST, 'config.json'), JSON.stringify({ url: `http://127.0.0.1:${SPORT}/bridge`, key: KEY }));

// ---- pretend phone with history
let ph = await fakePhone({ port: PPORT, maxPacket: 400 });
const old = new Date(Date.now() - 3600e3);
ph.inbox.push({ handle: '1001', from: '+15125550100', text: 'HISTORY-old-text', datetime: mapDt(old) });

// ---- bridge
const PS = process.platform === 'win32' ? 'powershell.exe' : (process.env.PWSH || 'pwsh');
const startBridge = (dir, port) => {
  const b = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'windows', 'bridge.ps1'), '-TestTcp', `127.0.0.1:${port}`, '-StateDir', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  b.out = ''; b.stdout.on('data', d => b.out += d); b.stderr.on('data', d => b.out += d);
  kids.push(b); return b;
};
console.log('bridge');
let br = startBridge(BST, PPORT);
if (!await until(() => /first run: 1 texts already on the phone/.test(blog()), 'first run: what is already on the phone is history')) { console.log(br.out); process.exit(1); }
ok(/connected to test phone/.test(blog()), 'connects (CONNECT + folders telecom/msg)');
await until(async () => { const s = JSON.parse(read(path.join(TMP, 'state', 'props.json'))).script.TX_BRIDGE; return s && JSON.parse(s).connected === true && /^win-/.test(JSON.parse(s).version); }, 'server shows the bridge as connected (version win-…)');

console.log('incoming');
const now = new Date();
ph.inbox.push({ handle: '1002', from: '+15125550101', text: 'yes', datetime: mapDt(now) });
const long = 'LONG-' + 'a'.repeat(300) + ' ✔ end';
ph.inbox.push({ handle: '1003', from: '+15125550102', text: long, datetime: mapDt(now) });
ph.inbox.push({ handle: '1004', from: '+15125550104', text: 'NOADDR-needs the full message', datetime: mapDt(now), noAddr: true });
ph.inbox.push({ handle: '1005', from: '+15125550105', text: 'Tom & Jerry <3', rawSubject: 'Tom & Jerry <3', datetime: mapDt(now) });
ph.inbox.push({ handle: '1006', from: 'someone@example.com', text: 'EMAIL-should be skipped', datetime: mapDt(now), type: 'EMAIL' });
ph.inbox.push({ handle: '1007', from: '+15125550107', text: 'STALE-3h-old', datetime: mapDt(new Date(Date.now() - 3 * 3600e3)) });
await until(() => msgs().includes('"yes"'), 'a new text reaches the server log');
await until(() => inRows(long) === 1, 'a long text (cut short in the listing) is read in full, unicode intact');
await until(() => msgs().includes('NOADDR-needs the full message'), 'sender missing from the listing: taken from the full message');
await until(() => msgs().includes('Tom & Jerry <3'), 'unescaped characters in the listing do not break it');
await sleep(4000);
ok(!msgs().includes('HISTORY-old-text'), 'history is never forwarded');
ok(!msgs().includes('EMAIL-should be skipped'), 'e-mail entries are skipped');
ok(!msgs().includes('STALE-3h-old'), 'texts older than 2 h are not forwarded');
ok(inRows('yes') === 1, 'each text forwarded once (polled many times)');

console.log('sending');
const body = 'Hi from SURE Walk ✔\nEND:MSG\nBEGIN:VCARD trick\n' + 'z'.repeat(500);
await rpc('sendToNumber', '5125550103', body);
await until(() => ph.sent.some(s => /5125550103$/.test(s.to)), 'a queued text is pushed to the phone outbox');
const s1 = ph.sent.find(s => /5125550103$/.test(s.to)) || {};
ok(s1.text === body, 'text arrives exactly (line stuffing undone, unicode intact)');
ok(s1.packets > 1, `long text split over several packets (${s1.packets})`);
ok(s1.originatorEmpty, 'originator left empty for the iPhone to fill in');
await until(() => /text 1\/1: sent/.test(blog()), 'bridge records the send as sent');
await until(() => { const st = JSON.parse(read(path.join(BST, 'state.json'))); return st.results.length === 0; }, 'the outcome is reported to the server');

console.log('phone goes away and comes back');
await ph.close();
await until(() => /phone: /.test(blog()), 'losing the phone is noticed');
ph = await fakePhone({ port: PPORT, maxPacket: 400 });
ph.inbox.push({ handle: '1002', from: '+15125550101', text: 'yes', datetime: mapDt(now) });
await until(() => (blog().match(/connected to test phone/g) || []).length >= 2, 'reconnects when the phone is back', 90000);
ph.inbox.push({ handle: '2001', from: '+15125550108', text: 'after-reconnect', datetime: mapDt(new Date()) });
await until(() => msgs().includes('after-reconnect'), 'texts flow again after reconnecting');
await sleep(3000);
ok(inRows('yes') === 1, 'old texts not re-forwarded after reconnecting');

console.log('restart');
br.kill(); await sleep(1500);
br = startBridge(BST, PPORT);
await until(() => (blog().match(/starting/g) || []).length >= 2, 'bridge restarts from saved state');
ph.inbox.push({ handle: '2002', from: '+15125550109', text: 'after-restart', datetime: mapDt(new Date()) });
await until(() => msgs().includes('after-restart'), 'new texts after a restart are forwarded');
await sleep(3000);
ok(!/first run/.test(blog().split('starting').pop()), 'restart is not treated as a first run');
ok(inRows('after-reconnect') === 1, 'nothing re-forwarded after a restart');

console.log('privacy');
const L = blog();
ok(!/51255501/.test(L) && !L.includes('yes\n') && !L.includes('LONG-') && !L.includes('Tom &'), 'bridge.log has no phone numbers or message text');
br.kill(); await sleep(1500);

console.log('refusal');
const ph2 = await fakePhone({ port: PPORT + 10, refuse: 0xC3 });
const B2 = path.join(TMP, 'bridge2'); fs.mkdirSync(B2);
fs.writeFileSync(path.join(B2, 'config.json'), JSON.stringify({ url: `http://127.0.0.1:${SPORT}/bridge`, key: KEY }));
const br2 = startBridge(B2, PPORT + 10);
await until(() => /Show Notifications ON/.test(read(path.join(B2, 'bridge.log'))), 'a phone that refuses access gets a clear fix in the log');
br2.kill(); await ph2.close(); await ph.close();

console.log(`\n${pass} passed, ${fail} failed`);
cleanup();
process.exit(fail ? 1 : 0);
