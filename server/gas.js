/*
 * Stand-ins for the Google services the SURE Walk Texts code (Code/Rides/Texts/Bridge/Places .gs) uses, so it runs
 * unchanged on this computer:
 *   PropertiesService  -> <state>/props.json (only this user can read it)
 *   CacheService / LockService / Session / Utilities / ContentService
 *   SpreadsheetApp     -> openById(<the master sheet>) = a virtual sheet over the rides from the GroupMe sync chat;
 *                         every write is recorded (takeChanges) and sent back to the Excel sheet through GroupMe.
 *                         create()/openById(<log id>) = the message log, <state>/messages.jsonl — it never leaves
 *                         this computer.
 * Installs them as globals (the .gs files expect that). Needs TZ=America/Chicago.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_ID = 'local-log';
const W = 23; // A:W of the old Google sheet layout (CFG.LAST_COL)
// old-layout column -> sync field (protocol.js)
const COLS = { 1: 'ts', 2: 'disp', 3: 'call', 4: 'arr', 7: 'last', 8: 'first', 9: 'phone', 10: 'pu', 11: 'do', 12: 'ada',
  13: 'loc', 14: 'van', 15: 'drv', 16: 'nav', 22: 'rsn' };

function install(stateDir, store) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const write = (file, text) => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file); };

  /* ---------- properties ---------- */
  const propsFile = path.join(stateDir, 'props.json');
  let P = { script: {}, user: {} };
  try { P = Object.assign(P, JSON.parse(fs.readFileSync(propsFile, 'utf8'))); } catch (e) { /* first run */ }
  let propsDirty = false;
  const propStore = m => ({
    getProperty: k => (k in P[m] ? P[m][k] : null),
    getProperties: () => Object.assign({}, P[m]),
    setProperty(k, v) { P[m][k] = String(v); propsDirty = true; return this; },
    setProperties(o, deleteOthers) { if (deleteOthers) P[m] = {}; Object.keys(o).forEach(k => { P[m][k] = String(o[k]); }); propsDirty = true; return this; },
    deleteProperty(k) { delete P[m][k]; propsDirty = true; return this; },
  });
  global.PropertiesService = { getScriptProperties: () => propStore('script'), getUserProperties: () => propStore('user') };

  /* ---------- cache, lock, session, utilities ---------- */
  const cache = new Map();
  const C = {
    get: k => { const e = cache.get(k); if (!e) return null; if (e.until < Date.now()) { cache.delete(k); return null; } return e.v; },
    put: (k, v, sec) => { cache.set(k, { v: String(v), until: Date.now() + (sec || 600) * 1000 }); },
    remove: k => { cache.delete(k); },
    removeAll: ks => ks.forEach(k => cache.delete(k)),
  };
  global.CacheService = { getScriptCache: () => C, getUserCache: () => C };
  // One process, and the .gs code never waits on anything: a lock is always free.
  const lock = { waitLock() {}, tryLock: () => true, releaseLock() {}, hasLock: () => true };
  global.LockService = { getScriptLock: () => lock, getUserLock: () => lock };
  const me = { getEmail: () => 'texting@this-computer' };
  global.Session = { getActiveUser: () => me, getEffectiveUser: () => me, getScriptTimeZone: () => 'America/Chicago' };
  global.Utilities = {
    getUuid: () => crypto.randomUUID(),
    formatDate(d, tz, fmt) {
      const p = {};
      new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Chicago', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
        .formatToParts(d).forEach(z => { p[z.type] = z.value; });
      const pad = (v, n) => String(v).padStart(n, '0');
      const T = { yyyy: p.year, yy: String(p.year).slice(2), MM: pad(p.month, 2), M: p.month, dd: pad(p.day, 2), d: p.day,
        HH: pad(p.hour % 24, 2), H: String(p.hour % 24), mm: pad(p.minute, 2), m: String(+p.minute), ss: pad(p.second, 2), s: String(+p.second) };
      return String(fmt).replace(/yyyy|yy|MM|M|dd|d|HH|H|mm|m|ss|s/g, t => T[t]);
    },
    sleep() {},
  };
  global.ContentService = { MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
    createTextOutput: s => ({ s, setMimeType() { return this; }, getContent() { return this.s; } }) };
  global.HtmlService = { createHtmlOutput: s => ({ s, setTitle() { return this; }, addMetaTag() { return this; } }),
    createHtmlOutputFromFile: () => global.HtmlService.createHtmlOutput('') };

  /* ---------- the message log (local file) ---------- */
  const logFile = path.join(stateDir, 'messages.jsonl');
  let logCount = null;
  const logRows = () => { try { return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { return []; } };
  const countLog = () => (logCount == null ? (logCount = logRows().length) : logCount);
  const chain = o => new Proxy(o, { get: (t, k) => (k in t ? t[k] : () => t.self || t) }); // setFontWeight & co. do nothing
  const logSheet = chain({
    getName: () => 'Messages', setName() { return logSheet; }, setFrozenRows() { return logSheet; },
    getLastRow: () => 1 + countLog(),
    getRange(row, col, n, w) {
      return chain({
        self: null,
        setValues(rows) {
          if (row === 1) return this; // the header
          const text = rows.map(r => JSON.stringify(r.map(v => (v instanceof Date ? { d: v.getTime() } : v)))).join('\n') + '\n';
          fs.appendFileSync(logFile, text, { mode: 0o600 });
          logCount = countLog() + rows.length;
          return this;
        },
        getValues() {
          return logRows().slice(row - 2, row - 2 + (n || 1)).map(r => r.slice(0, w || 11).map(v => (v && typeof v === 'object' && 'd' in v ? new Date(v.d) : v)));
        },
      });
    },
  });
  const logBook = { getId: () => LOG_ID, getSheets: () => [logSheet], getSheetByName: n => (n === 'Messages' ? logSheet : null), getUrl: () => '/log.csv' };

  /* ---------- the master sheet: a virtual sheet over the synced rides ---------- */
  let changes = []; // { id, k, was, now }
  let layout = null, layoutVer = -1;
  function rows() { // row number -> ride id (the sheet's own row numbers; a clash goes after the last row)
    if (layoutVer === store.ver && layout) return layout;
    const byRow = {}, loose = [];
    Object.values(store.rides).filter(r => r.f.ts).sort((a, b) => (a.f.ts < b.f.ts ? -1 : 1)).forEach(r => {
      const n = parseInt(r.f.row, 10);
      if (n >= 2 && !byRow[n]) byRow[n] = r.id; else loose.push(r.id);
    });
    let last = Math.max(1, ...Object.keys(byRow).map(Number));
    loose.forEach(id => { byRow[++last] = id; });
    layout = { byRow, last }; layoutVer = store.ver;
    return layout;
  }
  const rideAt = row => { const id = rows().byRow[row]; return id ? store.rides[id] : null; };
  function tsDate(ts) {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):?(\d{2})?/.exec(ts || '');
    return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null; // TZ=America/Chicago
  }
  const tsText = d => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  function cell(row, col) {
    if (row === 1) return { v: col === 1 ? 'Timestamp' : '', t: col === 1 ? 'Timestamp' : '' };
    const r = rideAt(row), k = COLS[col];
    if (!r || !k) return { v: '', t: '' };
    if (k === 'ts') { const d = tsDate(r.f.ts); return d ? { v: d, t: tsText(d) } : { v: '', t: '' }; }
    const s = r.f[k] == null ? '' : String(r.f[k]);
    return { v: s, t: s };
  }
  function set(row, col, value) {
    const r = rideAt(row), k = COLS[col];
    if (!r || !k || k === 'ts') return;
    const now = value == null ? '' : String(value);
    if (String(r.f[k] || '') === now) return;
    changes.push({ id: r.id, k, was: String(r.f[k] || ''), now });
    r.f[k] = now;
    store.ver++;
  }
  function setBg(row, color) {
    const r = rideAt(row);
    if (!r) return;
    const now = String(color || '#ffffff').toLowerCase();
    if ((r.f.bg || '#ffffff').toLowerCase() === now) return;
    changes.push({ id: r.id, k: 'bg', was: r.f.bg || '#ffffff', now });
    r.f.bg = now;
    store.ver++;
  }
  function range(row, col, n, w) {
    n = n || 1; w = w || 1;
    const grid = fn => { const o = []; for (let i = 0; i < n; i++) { const l = []; for (let j = 0; j < w; j++) l.push(fn(row + i, col + j)); o.push(l); } return o; };
    const R = {
      getValues: () => grid((r, c) => cell(r, c).v), getDisplayValues: () => grid((r, c) => cell(r, c).t),
      getValue: () => cell(row, col).v, getDisplayValue: () => cell(row, col).t,
      getBackgrounds: () => grid(r => { const x = rideAt(r); return (x && x.f.bg) || '#ffffff'; }),
      getBackground: () => { const x = rideAt(row); return (x && x.f.bg) || '#ffffff'; },
      setValue(v) { set(row, col, v); return R; },
      setValues(vals) { vals.forEach((l, i) => l.forEach((v, j) => set(row + i, col + j, v))); return R; },
      clearContent() { for (let i = 0; i < n; i++) for (let j = 0; j < w; j++) set(row + i, col + j, ''); return R; },
      setBackground(c) { if (w >= 3) for (let i = 0; i < n; i++) setBg(row + i, c); return R; },
      setFontColor() { return R; }, setFontWeight() { return R; }, setNumberFormat() { return R; },
      getRow: () => row, getColumn: () => col, getNumRows: () => n, getNumColumns: () => w,
    };
    return R;
  }
  const master = { getName: () => 'Rides', getLastRow: () => rows().last, getLastColumn: () => W, getMaxColumns: () => W,
    getRange: (r, c, n, w) => range(r, c, n, w) };
  const masterBook = { getId: () => 'excel', getSheets: () => [master], getSheetByName: () => master };

  global.SpreadsheetApp = {
    openById: id => (id === LOG_ID ? logBook : masterBook),
    create: () => logBook,
    flush() {},
  };

  return {
    LOG_ID,
    /** The sheet edits the texting code made since the last call, merged per ride + field. */
    takeChanges() {
      const by = new Map();
      changes.forEach(c => {
        const key = c.id + '|' + c.k, x = by.get(key);
        if (x) x.now = c.now; else by.set(key, Object.assign({}, c));
      });
      changes = [];
      return [...by.values()].filter(c => c.was !== c.now);
    },
    clearCache: () => { C.removeAll(['rides', 'state_view']); },
    flush() { if (propsDirty) { write(propsFile, JSON.stringify(P)); propsDirty = false; } },
    props: P,
    logRows,
    logFile,
  };
}

module.exports = { install, COLS };
