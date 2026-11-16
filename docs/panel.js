/*
 * SURE Walk Texts — the Excel panel (Script Lab) for the texting / calling side.
 *   • On the sheet: mark a ride called (Call Time = now), cancel it with a reason, mark it duplicate, fix its pick-up /
 *     drop-off, undo. The ride is the row you click in the sheet (or pick in the list).
 *   • GroupMe sync (Settings, off until you turn it on): new rides and changes go to the sync chat; the texting computer
 *     reads them, texts riders, and posts back its own sheet edits (Call Time, cancels, duplicates, place fixes), which
 *     this panel writes into the sheet — only when the cell still holds what the texting computer saw.
 * Needs protocol.js (window.SWP) loaded first.
 */
(function () {
  'use strict';
  const SWP = window.SWP;
  const T = window.SWT_TEST || {}; // tests only
  const READ_COLS = 30, SCAN_ROWS = 400, TICK_MS = T.tick || 4000, POST_GAP_MS = T.gap || 1500;
  const GM = T.gm || 'https://api.groupme.com/v3';
  const CANCEL_REASONS = ['Chose Alternative Way Home', 'Not Answering', 'Long Wait Time Expected', 'Before Start', 'Not Ready',
    'Not Within Pickup Drop-off Parameters', 'Exceeded 2min Wait', 'After Deadline', 'Wrong Number', 'Not Grouped with Friends', 'Luggage etc.', 'Other'];
  const DUP = '#ff0000', BLACK = '#000000';

  /* ---------------- settings (this browser only) ---------------- */
  const ls = {
    get(k, d) { try { const v = localStorage.getItem('swt.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('swt.' + k, JSON.stringify(v)); } catch (e) { /* this session only */ } },
  };
  let set = Object.assign({ name: '', dispName: true, tab: '', token: '', groupId: '', groupName: '', sync: false }, ls.get('settings', {}));
  let src = ls.get('src', '');
  if (!src) { src = 'x' + Math.random().toString(16).slice(2, 7); ls.set('src', src); }

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');

  /* ---------------- dates ---------------- */
  function serialToWall(serial) {
    const d = new Date(Math.round((serial - 25569) * 864e5));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }
  function textToWall(s) { // "11/10/2026 23:14", "11/10/26 11:14 PM"
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?$/i.exec(String(s || '').trim());
    if (!m) return '';
    let h = +m[4];
    if (m[7]) h = (h % 12) + (/pm/i.test(m[7]) ? 12 : 0);
    return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${pad(m[1])}-${pad(m[2])} ${pad(h)}:${m[5]}:${m[6] || '00'}`;
  }
  function hm(v, t) { // a Call Time / Arrival cell -> "H:MM" (24 h), or its text
    if (typeof v === 'number' && v > 0) { const mins = Math.round((v % 1) * 1440) % 1440; return `${Math.floor(mins / 60)}:${pad(mins % 60)}`; }
    const s = String(t == null ? '' : t).trim(), m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)?$/i.exec(s);
    if (!m) return s;
    let h = +m[1];
    if (m[3]) h = (h % 12) + (/pm/i.test(m[3]) ? 12 : 0);
    return `${h}:${m[2]}`;
  }
  const nowHM = () => { const w = SWP.austin(); return `${+w.slice(11, 13)}:${w.slice(14, 16)}`; };
  const hmToSerial = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(s); return m ? (+m[1] * 60 + +m[2]) / 1440 : s; };
  const ampm = s => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ''); return m ? `${(+m[1] + 11) % 12 + 1}:${m[2]}` : s; };
  function wallMs(ts) {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?/.exec(ts || '');
    return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : 0;
  }

  /* ---------------- the sheet layout (found by header) ---------------- */
  const HEAD = [ // in this order: a header is used once (the pick-up header mentions "cancelled")
    ['id', /^id$/], ['ts', /^(form submitted|timestamp|completion time)/], ['date', /^date$/], ['stime', /^(submitted time|time submitted)$/], ['disp', /^dispatch/], ['call', /^call time/], ['arr', /^arrival/],
    ['last', /^last name/], ['first', /^first name/], ['phone', /^phone/], ['pu', /^pick ?-?up/], ['do', /^drop ?-?off/],
    ['ada', /disabilit|^ada\b/], ['loc', /^location$/], ['van', /^(van|vehicle)/], ['drv', /^driver$/], ['nav', /^navigator$/],
    ['rsn', /^reason/], ['rsn', /cancel/], ['eid', /^(ut )?eid/], ['notes', /^notes?$/], ['txs', /^(confirmed|text( status)?)$/],
    // the rider's email ("Email Address:"; the plain "Email" column is the Forms account) and the form's three agreements
    ['email', /^email address/], ['agree', /^i have read the updated rules/], ['verified', /^all pick ?-?up locations/], ['food', /food establishment/],
  ];
  function layoutOf(header) {
    const h = header.map(x => String(x || '').toLowerCase().replace(/[^a-z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim());
    const col = {}, used = new Set();
    HEAD.forEach(([k, re]) => { if (col[k]) return; const i = h.findIndex((x, j) => re.test(x) && !used.has(j)); if (i >= 0) { col[k] = i + 1; used.add(i); } });
    // the ride's time: one timestamp column (older layouts), or Date + Submitted Time (Nov 2026 layout)
    if (!col.ts && !(col.date && col.stime)) col.ts = 0;
    const need = { first: 'First Name', phone: 'Phone', pu: 'Pick-up', do: 'Drop-off', call: 'Call Time' };
    const missing = Object.keys(need).filter(k => !col[k]).map(k => need[k]);
    if (col.ts === 0) { delete col.ts; missing.unshift('Date + Submitted Time'); }
    if (missing.length) throw new Error(`Can't find these columns in row 1 of this tab: ${missing.join(', ')}. Pick the rides tab in ⚙ Settings.`);
    return col;
  }
  // A ride's submit time as Austin wall clock "YYYY-MM-DD HH:MM:SS", or '' when the row isn't a ride.
  function rowTs(col, v, t) {
    if (col.ts) { const x = v[col.ts - 1]; return typeof x === 'number' && x > 1 ? serialToWall(x) : textToWall(t[col.ts - 1]); }
    const dv = v[col.date - 1], dt = String(t[col.date - 1] == null ? '' : t[col.date - 1]).trim();
    let day = '';
    if (typeof dv === 'number' && dv > 1) day = serialToWall(Math.floor(dv)).slice(0, 10);
    else { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(dt) || /^(\d{4})-(\d{2})-(\d{2})$/.exec(dt);
      if (m) day = m[1].length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3].length === 2 ? '20' + m[3] : m[3]}-${pad(m[1])}-${pad(m[2])}`; }
    const tm = hm(v[col.stime - 1], t[col.stime - 1]), mt = /^(\d{1,2}):(\d{2})$/.exec(tm);
    if (!day || !mt || +mt[1] > 23) return '';
    return `${day} ${pad(mt[1])}:${mt[2]}:00`;
  }
  const letter = n => { let s = ''; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  // The ride's key: 'f' + the form's Id, or (no Id: a row added by hand) its time + the phone's last 4 digits.
  function rideId(col, v, t, ts) {
    const idv = col.id ? String(v[col.id - 1] == null ? '' : v[col.id - 1]).trim() : '';
    if (idv) return 'f' + idv;
    const ph = String(t[col.phone - 1] == null ? '' : t[col.phone - 1]).replace(/\D/g, ''), fi = String(t[col.first - 1] || '').trim().toLowerCase();
    return 't' + ts.replace(/\D/g, '') + (ph.slice(-4) || fi);
  }
  const RIDE_FIELDS = ['first', 'last', 'phone', 'pu', 'do', 'ada', 'disp', 'call', 'arr', 'loc', 'van', 'drv', 'nav', 'rsn', 'txs'];

  /* ---------------- reading ---------------- */
  // The rides tab. The workbook's first tab is now "Pairings", so it isn't "the first tab" anymore:
  //   the tab set in ⚙ Settings, else the tab named for tonight's month ("November", "Dec 2026"), else the latest
  //   month tab, else the first tab that isn't Pairings. Everything but readSheet uses the tab readSheet last used.
  const MONTHS = ['jan(uary)?', 'feb(ruary)?', 'mar(ch)?', 'apr(il)?', 'may', 'june?', 'july?', 'aug(ust)?', 'sept?(ember)?', 'oct(ober)?', 'nov(ember)?', 'dec(ember)?'];
  const monthOfTab = name => MONTHS.findIndex(m => new RegExp(`(^|[^a-z])${m}($|[^a-z])`, 'i').test(String(name)));
  const nightMonth = () => +new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'numeric' })
    .format(new Date(Date.now() - 6 * 3600e3)) - 1; // 12:30 AM Dec 1 is still the Nov 30 night
  function pickRidesTab(names, month) {
    const tabs = names.filter(n => !/pairing/i.test(n));
    const back = n => (month - monthOfTab(n) + 12) % 12; // months since that tab's month: 0 = tonight's
    const months = tabs.filter(n => monthOfTab(n) >= 0).sort((a, b) => back(a) - back(b));
    return months[0] || tabs[0] || names[0];
  }
  let ridesTab = '';
  async function sheetOf(ctx, reuse) {
    if (set.tab) return ctx.workbook.worksheets.getItem(set.tab);
    if (!(reuse && ridesTab)) {
      const wss = ctx.workbook.worksheets; wss.load('items/name,items/position'); await ctx.sync();
      ridesTab = pickRidesTab(wss.items.slice().sort((a, b) => a.position - b.position).map(x => x.name), nightMonth());
    }
    return ctx.workbook.worksheets.getItem(ridesTab);
  }
  let X = null; // { name, col, rides: [ride], byId, byRow }
  function rowColor(cells, cols) { // the row's color: the most common fill among the ride columns
    const n = {};
    cols.forEach(c => { const v = cells[c - 1] && cells[c - 1].bg; if (v) n[v] = (n[v] || 0) + 1; });
    return Object.keys(n).sort((a, b) => n[b] - n[a])[0] || '#ffffff';
  }
  async function readSheet() {
    X = await Excel.run(async ctx => {
      const ws = await sheetOf(ctx);
      ws.load('name');
      const used = ws.getUsedRangeOrNullObject(true); used.load('rowIndex,rowCount');
      const hdr = ws.getRangeByIndexes(0, 0, 1, READ_COLS); hdr.load('text');
      await ctx.sync();
      const col = layoutOf(hdr.text[0]);
      const lastRow = used.isNullObject ? 1 : used.rowIndex + used.rowCount;
      const top = Math.max(2, lastRow - SCAN_ROWS - 60);
      if (lastRow < top) return { name: ws.name, col, rides: [], lastRow };
      const rg = ws.getRangeByIndexes(top - 1, 0, lastRow - top + 1, READ_COLS);
      rg.load('values,text');
      const props = rg.getCellProperties({ format: { fill: { color: true }, font: { color: true } } });
      await ctx.sync();
      const rideCols = ['ts', 'date', 'stime', 'first', 'last', 'phone', 'pu', 'do'].map(k => col[k]).filter(Boolean);
      const rides = [];
      for (let i = 0; i < rg.values.length; i++) {
        const v = rg.values[i], t = rg.text[i], cells = props.value[i].map(c => ({ bg: String((c.format.fill && c.format.fill.color) || '#ffffff').toLowerCase() }));
        const ts = rowTs(col, v, t);
        if (!ts) continue; // not a ride (blank, or a roster below the rides in older layouts)
        const get = k => (col[k] ? String(t[col[k] - 1] == null ? '' : t[col[k] - 1]).trim() : '');
        const f = { ts, row: String(top + i) };
        RIDE_FIELDS.forEach(k => { f[k] = get(k); });
        f.call = col.call ? hm(v[col.call - 1], t[col.call - 1]) : '';
        f.arr = col.arr ? hm(v[col.arr - 1], t[col.arr - 1]) : '';
        f.txs = col.txs ? hm(v[col.txs - 1], t[col.txs - 1]) : ''; // "Confirmed": a time, like Call Time
        if (f.rsn === '0') f.rsn = '';
        if (/^#+$/.test(f.phone)) f.phone = String(v[col.phone - 1]);
        f.bg = rowColor(cells, rideCols);
        if (/^#+$/.test(String(t[col.phone - 1]))) t[col.phone - 1] = f.phone;
        const id = rideId(col, v, t, ts);
        rides.push({ id, row: top + i, f, cells, notes: get('notes') });
      }
      return { name: ws.name, col, rides, lastRow };
    });
    await clearCopiedColors(X);
    X.byId = new Map(X.rides.map(r => [r.id, r]));
    X.byRow = new Map(X.rides.map(r => [r.row, r]));
    X.night = SWP.nightOf(SWP.austin());
    X.tonight = X.rides.filter(r => SWP.nightOf(r.f.ts) === X.night);
    return X;
  }

  /*
   * Excel gives each new form response the formatting of the row above, so after a picked (colored) or cancelled
   * (black) ride, new rides arrive already highlighted. A ride nobody has touched yet (no dispatcher, call time,
   * arrival, crew or reason) less than an hour old, whose color is exactly the row above's, had it copied: clear it
   * (same rule as the dispatch panel).
   */
  const painted = new Set(); // rides this panel colored itself (never 'copied')
  async function clearCopiedColors(x) {
    const byRow = new Map(x.rides.map(r => [r.row, r])), now = wallMs(SWP.austin()), fixes = [];
    x.rides.forEach(r => {
      const above = byRow.get(r.row - 1), f = r.f;
      if (!above || f.bg === '#ffffff' || f.bg !== above.f.bg || painted.has(r.id)) return;
      if (['disp', 'call', 'arr', 'loc', 'van', 'drv', 'nav', 'rsn'].some(k => f[k] && f[k] !== '0')) return;
      const age = (now - wallMs(f.ts)) / 60e3;
      if (age >= 0 && age <= 60) fixes.push(r);
    });
    if (!fixes.length) return;
    await Excel.run(async ctx => {
      const ws = await sheetOf(ctx, true);
      fixes.forEach(r => { const rg = ws.getRange(`${r.row}:${r.row}`); rg.format.fill.clear(); rg.format.font.color = '#000000'; });
      await ctx.sync();
    });
    fixes.forEach(r => { r.f.bg = '#ffffff'; r.cells.forEach(c => { c.bg = '#ffffff'; }); });
  }

  /* ---------------- ride state ---------------- */
  const rgb = h => { const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h || ''); return m ? m.slice(1).map(x => parseInt(x, 16)) : null; };
  const isBlack = h => { const c = rgb(h); return !!c && Math.max(...c) <= 0x50 && Math.max(...c) - Math.min(...c) <= 40; };
  const isRed = h => { const c = rgb(h); if (!c || isBlack(h)) return false; const [r, g, b] = c, mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx !== r || mx - mn < 25 || (mx - mn) / mx < 0.15) return false; const hue = ((g - b) / (mx - mn)) * 60; return hue >= -15 && hue <= 15; };
  const isColored = h => { const c = rgb(h); return !!c && !isBlack(h) && !isRed(h) && Math.max(...c) - Math.min(...c) >= 12; };
  function stateOf(r) {
    const f = r.f;
    if (f.rsn || isBlack(f.bg)) return 'cancelled';
    if (isRed(f.bg)) return 'dup';
    if (isColored(f.bg) && f.arr) return 'picked';
    return 'open';
  }
  function chips(r) {
    const f = r.f, st = stateOf(r), out = [];
    if (st === 'cancelled') out.push(['dark', 'Cancelled' + (f.rsn ? ': ' + f.rsn : '')]);
    else if (st === 'dup') out.push(['bad', 'Duplicate']);
    else if (st === 'picked') out.push(['ok', 'Picked']);
    if (st === 'open' || st === 'picked') {
      if (f.call) out.push(['info', 'Called ' + ampm(f.call)]); else if (f.disp) out.push(['info', 'Taken by ' + f.disp]); else if (st === 'open') out.push(['warn', 'Not called']);
      if (f.drv) out.push(['', 'Crew ' + f.drv + (f.nav ? ' / ' + f.nav : '')]);
      if (f.arr && st === 'open') out.push(['', 'Arrived ' + ampm(f.arr)]);
    }
    if (/yes/i.test(f.ada)) out.push(['bad', '♿ ADA']);
    return out;
  }

  /* ---------------- writing ---------------- */
  // The row still holds the same ride? (rows can move, and the sheet may have changed since the last read)
  async function check(ws, ctx, r) {
    const rg = ws.getRangeByIndexes(r.row - 1, 0, 1, READ_COLS); rg.load('values,text');
    await ctx.sync();
    const col = X.col, v = rg.values[0], t = rg.text[0];
    const idOk = col.id ? rideId(col, v, t, rowTs(col, v, t)) === r.id || r.id.charAt(0) !== 'f' && !String(v[col.id - 1]).trim() : true;
    const ph = String(t[col.phone - 1] || '').replace(/\D/g, '').slice(-10), want = String(r.f.phone || '').replace(/\D/g, '').slice(-10);
    if (!idOk || ph !== want) throw new Error(`Row ${r.row} isn't ${r.f.first}'s ride anymore — reload the list and try again.`);
    return { v, t };
  }
  // Capture what an action will overwrite, so Undo can put it back.
  function snapshot(r, keys, wholeRow) {
    return { row: r.row, id: r.id, keys, wholeRow, fills: wholeRow ? r.cells.map(c => c.bg) : null, before: Object.assign({}, r.f) };
  }
  function writeField(ws, row, k, val) {
    const c = X.col[k];
    if (!c) return;
    const rg = ws.getRangeByIndexes(row - 1, c - 1, 1, 1);
    if (val === '' || val == null) { rg.clear(Excel.ClearApplyTo.contents); return; }
    if ((k === 'call' || k === 'arr' || k === 'txs') && /^\d{1,2}:\d{2}$/.test(val)) { rg.values = [[hmToSerial(val)]]; rg.numberFormat = [['h:mm']]; return; }
    rg.values = [[String(val)]];
  }
  function paintRow(ws, row, color) {
    const pr = X && X.byRow.get(row); if (pr) painted.add(pr.id);
    const rg = ws.getRange(`${row}:${row}`);
    if (!color || color === '#ffffff') rg.format.fill.clear(); else rg.format.fill.color = color;
    rg.format.font.color = isBlack(color) ? '#ffffff' : '#000000';
  }
  // One sheet change (the screen that asked for it shows the toast): undoable, then the list is re-read.
  async function act(r, label, keys, wholeRow, fn) {
    const snap = snapshot(r, keys, wholeRow);
    await Excel.run(async ctx => {
      const ws = await sheetOf(ctx, true);
      await check(ws, ctx, r);
      fn(ws);
      await ctx.sync();
    });
    undoStack.push(Object.assign(snap, { label }));
    if (undoStack.length > 15) undoStack.shift();
    await refresh();
    return label;
  }
  const undoStack = [];
  // Undo the newest change: puts back the cells (and colors) it overwrote; a group change undoes every row it touched.
  async function undo() {
    const u = undoStack.pop();
    if (!u) return '';
    const parts = u.multi || [u];
    await Excel.run(async ctx => {
      const ws = await sheetOf(ctx, true);
      for (const p of parts) {
        const r = X.byId.get(p.id) || { id: p.id, row: p.row, f: p.before };
        await check(ws, ctx, Object.assign({}, r, { row: p.row }));
        p.keys.forEach(k => writeField(ws, p.row, k, p.before[k]));
        if (p.wholeRow) {
          const all = ws.getRange(`${p.row}:${p.row}`);
          all.format.fill.clear(); all.format.font.color = '#000000';
          p.fills.forEach((bg, j) => { if (bg && bg !== '#ffffff') ws.getRangeByIndexes(p.row - 1, j, 1, 1).format.fill.color = bg; });
          if (isBlack(p.before.bg)) all.format.font.color = '#ffffff';
        }
      }
      await ctx.sync();
    });
    await refresh();
    return u.label;
  }

  const who = f => [f.first, f.last].filter(Boolean).join(' ') || 'row ' + f.row;
  const markCalled = r => {
    const keys = ['call'], withName = set.dispName && set.name && !r.f.disp;
    if (withName) keys.push('disp');
    return act(r, 'Marked called ' + ampm(nowHM()), keys, false, ws => { writeField(ws, r.row, 'call', nowHM()); if (withName) writeField(ws, r.row, 'disp', set.name); });
  };
  const cancelRide = (r, reason) => act(r, 'Cancelled (' + reason + ')', ['disp', 'call', 'arr', 'loc', 'van', 'drv', 'nav', 'rsn'], true, ws => {
    // like the dispatch panel: clear Dispatcher → Arrival and Location → Navigator, reason, whole row black
    ['disp', 'call', 'arr', 'loc', 'van', 'drv', 'nav'].forEach(k => writeField(ws, r.row, k, ''));
    writeField(ws, r.row, 'rsn', reason);
    paintRow(ws, r.row, BLACK);
  });
  const markDup = r => act(r, 'Marked duplicate', [], true, ws => paintRow(ws, r.row, DUP));
  const markNotAda = r => act(r, 'Marked not ADA', ['ada'], false, ws => writeField(ws, r.row, 'ada', 'No'));

  /*
   * Traveling together: the group letter (A–H) lives in the rides tab's "Confirmed" column next to the confirmation
   * time ("9:40 · Group A", or "Group A" before they confirm), so the sheet needs no extra column. The texting computer
   * only ever changes the time part, this panel only the group part.
   */
  const cfTime = s => (/^\s*(\d{1,2}:\d{2})/.exec(String(s || '')) || [])[1] || '';
  const cfGroup = s => (/\bGroup ([A-H])\b/.exec(String(s || '')) || [])[1] || '';
  const cfJoin = (t, g) => [t, g ? 'Group ' + g : ''].filter(Boolean).join(' · ');
  async function writeGroups(changes, label) { // changes: [{ r, letter }]
    if (!X.col.txs) throw new Error('Add a "Confirmed" column to the rides tab to group riders.');
    const snaps = changes.map(c => snapshot(c.r, ['txs'], false));
    await Excel.run(async ctx => {
      const ws = await sheetOf(ctx, true);
      for (const c of changes) { await check(ws, ctx, c.r); writeField(ws, c.r.row, 'txs', cfJoin(cfTime(c.r.f.txs), c.letter)); }
      await ctx.sync();
    });
    undoStack.push({ label, multi: snaps });
    if (undoStack.length > 15) undoStack.shift();
    await refresh();
    return label;
  }
  // Group these rides (with the selected one's letter, or the first free one); riders in another group move over.
  function groupRides(ids, letter) {
    const rides = ids.map(id => X.byId.get(id)).filter(Boolean);
    if (rides.length < 2) throw new Error('Pick at least one more rider.');
    const L = letter || rides.map(r => cfGroup(r.f.txs)).find(Boolean) || freeLetter();
    return writeGroups(rides.filter(r => cfGroup(r.f.txs) !== L).map(r => ({ r, letter: L })), `Grouped ${rides.length} riders`);
  }
  function freeLetter() {
    const used = new Set(X.tonight.map(r => cfGroup(r.f.txs)).filter(Boolean));
    return 'ABCDEFGH'.split('').find(l => !used.has(l)) || 'H';
  }
  // Take one rider out; a group left with one rider is dissolved.
  function ungroupRide(id) {
    const r = X.byId.get(id), L = r && cfGroup(r.f.txs);
    if (!L) return null;
    const rest = X.tonight.filter(x => x.id !== id && cfGroup(x.f.txs) === L && stateOf(x) === 'open');
    return writeGroups([r].concat(rest.length < 2 ? rest : []).map(x => ({ r: x, letter: '' })), 'Removed from group');
  }
  const editPlaces = (r, pu, dropoff) => {
    const keys = [];
    if (pu !== r.f.pu) keys.push('pu');
    if (dropoff !== r.f.do) keys.push('do');
    if (!keys.length) return null;
    return act(r, 'Changed ' + keys.map(k => (k === 'pu' ? 'pick-up' : 'drop-off')).join(' + '), keys, false, ws => {
      if (keys.includes('pu')) writeField(ws, r.row, 'pu', pu);
      if (keys.includes('do')) writeField(ws, r.row, 'do', dropoff);
    });
  };

  /*
   * A ride added by hand (a rider who called in, the form being down…): a new row under the last ride, filled like a
   * form response. The Id stays blank (the form numbers its own responses, so a made-up Id could clash with the next
   * one) and Notes says who added it. With sync on, the next tick posts it like any new ride, so it gets texted
   * unless "called" is ticked.
   */
  const wallToSerial = w => wallMs(w) / 864e5 + 25569;
  // What the form writes in its three agreement columns: a ride added by hand gets the same answers.
  const AGREE = { agree: 'I agree and adhere to the rules and guidelines laid out above.',
    verified: 'I understand and have verified my pick-up location.', food: 'I understand.' };
  async function addRide(a, quiet) { // a: first last phone eid pu do ada notes, call ('H:MM' or ''), disp, by
    await readSheet();
    const col = X.col, w = SWP.austin(), lastRide = X.rides.length ? Math.max(...X.rides.map(r => r.row)) : 0;
    const vals = {}; // column -> value
    const put = (k, v) => {
      if (typeof v === 'string') v = v.replace(/^[=+@-]+/, '').trim(); // typed text never becomes a formula
      if (col[k] && v !== '' && v != null) vals[col[k]] = v;
    };
    if (col.ts) put('ts', wallToSerial(w)); else { put('date', Math.floor(wallToSerial(w))); put('stime', hmToSerial(`${+w.slice(11, 13)}:${w.slice(14, 16)}`)); }
    ['first', 'last', 'phone', 'eid', 'email', 'pu', 'do', 'ada'].forEach(k => put(k, a[k]));
    Object.keys(AGREE).forEach(k => put(k, AGREE[k]));
    if (/^\d{1,2}:\d{2}$/.test(a.call || '')) { put('call', hmToSerial(a.call)); put('disp', a.disp); }
    put('notes', [a.by || `Added in the Texts panel${set.name ? ' by ' + set.name : ''}`, a.notes].filter(Boolean).join(' — '));
    const timeFmt = { ts: 'm/d/yyyy h:mm', date: 'm/d/yyyy', stime: 'h:mm AM/PM', call: 'h:mm' };
    const row = await Excel.run(async ctx => {
      const ws = await sheetOf(ctx, true);
      let row = (lastRide || Math.max(1, X.lastRow)) + 1;
      const above = ws.getRangeByIndexes(row - 2, 0, 1, READ_COLS), next = ws.getRangeByIndexes(row - 1, 0, 1, READ_COLS);
      above.load('numberFormat,formulasR1C1'); next.load('values');
      const tables = ws.tables; if (tables) tables.load('items/name');
      await ctx.sync();
      // the rides are an Excel table (form responses) ending right above? add the row through the table
      let table = null;
      if (tables && tables.items.length) {
        const rgs = tables.items.map(tb => { const r = tb.getRange(); r.load('rowIndex,rowCount,columnIndex,columnCount'); return { tb, r }; });
        await ctx.sync();
        const hit = rgs.find(x => x.r.rowIndex + x.r.rowCount === row - 1 && x.r.columnIndex < READ_COLS);
        if (hit) table = hit;
      }
      if (table) table.tb.rows.add(); // an empty table row: Excel fills its calculated columns (Wait Time…)
      else {
        if (next.values[0].some(v => v !== '' && v != null)) ws.getRange(`${row}:${row}`).insert('Down'); // something sits under the rides
        above.formulasR1C1[0].forEach((f, j) => { // carry the row above's formulas (Wait Time…) down
          if (vals[j + 1] === undefined && typeof f === 'string' && f.charAt(0) === '=') ws.getRangeByIndexes(row - 1, j, 1, 1).formulasR1C1 = [[f]];
        });
      }
      Object.keys(vals).forEach(c => { ws.getRangeByIndexes(row - 1, c - 1, 1, 1).values = [[vals[c]]]; });
      Object.keys(timeFmt).forEach(k => {
        if (!col[k] || vals[col[k]] === undefined) return;
        const f = above.numberFormat[0][col[k] - 1];
        ws.getRangeByIndexes(row - 1, col[k] - 1, 1, 1).numberFormat = [[f && f !== 'General' ? f : timeFmt[k]]];
      });
      const all = ws.getRange(`${row}:${row}`); all.format.fill.clear(); all.format.font.color = '#000000'; // not the row above's highlight
      await ctx.sync();
      return row;
    });
    if (quiet) logEv('down', `New ride · ${who(a)}`, `Row ${row} · added on the texting computer`);
    await readSheet();
    render();
    return row;
  }

  /* ---------------- GroupMe sync ---------------- */
  const S = { rides: {} };               // the rides as the chat describes them
  const sync = { ready: false, lastId: '', seen: new Set(), pending: [], todo: [], adds: [], lastPost: 0, err: '', lastServerAt: 0, busy: false };
  async function gm(pathname, query, body, token) {
    const u = new URL(GM + pathname);
    Object.entries(query || {}).forEach(([k, v]) => u.searchParams.set(k, v));
    const res = await fetch(u, { method: body ? 'POST' : 'GET', headers: Object.assign({ 'X-Access-Token': token || set.token }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    if (res.status === 304) return null;
    if (res.status === 401) throw new Error('GroupMe refused the token — reconnect GroupMe in Auto-text.');
    if (!res.ok) throw new Error('GroupMe answered ' + res.status);
    return (await res.json()).response;
  }
  function takeMessages(ms) { // chat messages -> fold; the texting computer's edits go on the to-do list
    ms.slice().sort((a, b) => a.created_at - b.created_at || (BigInt(a.id) < BigInt(b.id) ? -1 : 1)).forEach(m => {
      if (sync.seen.has(m.id)) return;
      sync.seen.add(m.id);
      if (!sync.lastId || BigInt(m.id) > BigInt(sync.lastId)) sync.lastId = m.id;
      SWP.parse(m.text).forEach(ev => {
        if (ev.e === 'add') { if (ev.src === 's') sync.adds.push(ev); return; }
        SWP.fold(S, ev, m.created_at * 1000);
        if (ev.src === 's') { sync.todo.push(ev); sync.lastServerAt = Math.max(sync.lastServerAt, m.created_at * 1000); }
      });
    });
  }
  async function syncRead() {
    if (!sync.ready) {
      const cutoff = Date.now() / 1000 - 20 * 3600, all = [];
      let before = '';
      for (let p = 0; p < 40; p++) {
        const r = await gm(`/groups/${set.groupId}/messages`, before ? { limit: 100, before_id: before } : { limit: 100 });
        const ms = (r && r.messages) || [];
        all.push(...ms);
        if (ms.length < 100 || ms[ms.length - 1].created_at < cutoff) break;
        before = ms[ms.length - 1].id;
      }
      takeMessages(all.filter(m => m.created_at >= cutoff));
      if (!sync.lastId && all.length) sync.lastId = all[0].id;
      sync.ready = true;
      return;
    }
    for (let p = 0; p < 10; p++) {
      const r = await gm(`/groups/${set.groupId}/messages`, sync.lastId ? { after_id: sync.lastId, limit: 100 } : { limit: 100 });
      const ms = (r && r.messages) || [];
      if (!ms.length) break;
      takeMessages(ms);
      if (ms.length < 100) break;
    }
  }
  // The texting computer's edits -> the sheet, only where the cell still holds what it saw (a dispatcher's edit wins).
  async function applyServer() {
    const todo = sync.todo.splice(0);
    const work = [];
    todo.forEach(ev => {
      const r = X.byId.get(ev.id);
      if (!r) return;
      const ch = {}, skipped = [];
      Object.keys(ev.f).forEach(k => {
        if (k === 'row' || k === 'ts') return;
        const want = ev.f[k], cur = r.f[k];
        if (SWP.same(k, cur, want)) return;
        if (ev.was && k in ev.was && SWP.same(k, cur, ev.was[k])) ch[k] = want; else skipped.push(k);
      });
      if (Object.keys(ch).length) work.push({ r, ch });
      if (skipped.length) logEv('bad', `Kept the sheet's ${skipped.join(', ')} · ${who(r.f)}`, 'Changed here first');
    });
    if (!work.length) return;
    await Excel.run(async ctx => {
      const ws = await sheetOf(ctx, true);
      for (const { r, ch } of work) {
        try { await check(ws, ctx, r); } catch (e) { logEv('bad', e.message); continue; }
        const before = Object.assign({}, r.f);
        // the texting computer's Confirmed time never wipes the group letter that shares the cell
        if ('txs' in ch) ch.txs = cfJoin(cfTime(ch.txs), cfGroup(ch.txs) || cfGroup(r.f.txs));
        Object.keys(ch).forEach(k => { if (k === 'bg') paintRow(ws, r.row, ch.bg); else writeField(ws, r.row, k, ch[k]); });
        Object.assign(r.f, ch);
        logDown(r, ch, before);
      }
      await ctx.sync();
    });
  }
  // Rides typed into the texting computer's dashboard -> new rows. Each once: its Notes carry "#<request id>", and a
  // ride with that phone submitted since the request counts as done too (a reload re-reads the chat). Older than
  // 30 min = dropped (the dashboard says so).
  async function applyAdds() {
    const todo = sync.adds.splice(0), now = wallMs(SWP.austin());
    for (const ev of todo) {
      const f = ev.f, tag = '#' + ev.id, ph = String(f.phone || '').replace(/\D/g, '').slice(-10);
      if (!f.ts || now - wallMs(f.ts) > 30 * 60e3) continue;
      if (X.rides.some(r => (r.notes || '').includes(tag) || (ph && r.f.phone.replace(/\D/g, '').slice(-10) === ph && r.f.ts.slice(0, 16) >= f.ts.slice(0, 16)))) continue;
      try { await addRide(Object.assign({}, f, { by: `Added on the texting computer ${tag}` }), true); }
      catch (e) { logEv('bad', `Couldn't add ${who(f)}'s ride`, e.message || String(e)); }
    }
  }
  // The sheet vs the chat: post what the chat doesn't know yet (new rides, changed cells).
  function diff() {
    const lines = [], nowMs = wallMs(SWP.austin());
    X.tonight.forEach(r => {
      const k = S.rides[r.id];
      if (!k) {
        // At most send rides submitted up to 1 hour before: older rides are tracked locally without spamming chat
        if (nowMs - wallMs(r.f.ts) > 60 * 60e3) {
          SWP.fold(S, { e: 'ride', id: r.id, src: 'ignored', f: r.f });
          return;
        }
        const ev = { e: 'ride', id: r.id, src, f: r.f };
        lines.push(SWP.line(ev)); SWP.fold(S, ev);
        logEv('up', `New ride · ${who(r.f)}`, `${r.f.pu} → ${r.f.do}`);
        return;
      }
      const ch = {};
      SWP.FIELDS.forEach(f => {
        if (f === 'ts' || r.f[f] === undefined || SWP.same(f, r.f[f], k.f[f])) return;
        if (f === 'txs' && !X.col.txs) return; // no "Confirmed" column in this tab: the time stays in the chat
        ch[f] = r.f[f];
      });
      if (!Object.keys(ch).length) return;
      if (k.src === 'ignored') { Object.assign(k.f, ch); return; }
      const ev = { e: 'upd', id: r.id, src, f: ch };
      lines.push(SWP.line(ev, k.f));
      logUp(r, ch, k.f);
      SWP.fold(S, ev);
    });
    sync.pending.push(...lines);
  }
  async function postOne() {
    if (!sync.pending.length || Date.now() - sync.lastPost < POST_GAP_MS) return;
    const text = SWP.pack(sync.pending.slice(0, 40))[0];
    await gm(`/groups/${set.groupId}/messages`, null, { message: { source_guid: (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())), text } });
    sync.pending.splice(0, text.split('\n').length);
    sync.lastPost = Date.now();
  }
  const syncOn = () => set.sync && set.token && set.groupId;

  /* ---------------- the loop ---------------- */
  let busy = false, sel = null, filter = 'open', loadErr = '';
  async function refresh() { await readSheet(); render(); }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      if (syncOn()) { try { await syncRead(); sync.err = ''; } catch (e) { sync.err = e.message || String(e); } }
      await readSheet();
      loadErr = '';
      if (syncOn() && sync.ready && !sync.err) {
        await applyServer();
        await applyAdds();
        diff();
        try { await postOne(); } catch (e) { sync.err = e.message || String(e); }
      }
      render();
    } catch (e) {
      loadErr = e && e.code === 'ItemNotFound' ? `There's no tab named "${set.tab || ridesTab}" — fix it in ⚙ Settings.` : (e.message || String(e));
      render();
    } finally { busy = false; }
  }

  /* ======================================================================================================== UI ====
   * The side panel: a launcher (how many to call, one big "Open Calling"), the Auto-text view (GroupMe relay switch,
   * status, log, Connect GroupMe) and Settings. Calling (the call list and one rider at a time) opens in its own
   * window in the SURE Walk Texts add-in (Excel's dialog window), or over the side panel in Script Lab. The Calling
   * window can't reach the sheet itself: it asks the side panel (ACTIONS) and gets the rides back (snapshots).
   */
  const REMOTE = !!window.__SWT_REMOTE;  // this page IS the Calling window
  const HOSTED = () => !!window.__SWT_HOSTED; // the SURE Walk Texts add-in (its own site): can open the Calling window
  const GROUP_COLORS = { A: '#ff9500', B: '#af52de', C: '#34a853', D: '#007aff', E: '#e8467c', F: '#00a3a3', G: '#8d6e63', H: '#5c6bc0' };
  const ACCENTS = { orange: ['Burnt orange', '#bf5700', '#ff8a3d'], blue: ['Blue', '#1565c0', '#64b5f6'], green: ['Green', '#2e7d32', '#66bb6a'], purple: ['Purple', '#6a1b9a', '#ce93d8'] };
  const MASCOTS = {
    m1: ['Mascot 1', '<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="52" r="38" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="4"/><circle cx="38" cy="46" r="5" fill="var(--accent)"/><circle cx="62" cy="46" r="5" fill="var(--accent)"/><path d="M36 64q14 12 28 0" fill="none" stroke="var(--accent)" stroke-width="4" stroke-linecap="round"/></svg>'],
    m2: ['Mascot 2', '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M20 70h60l-6-22H26z" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="4" stroke-linejoin="round"/><path d="M30 48l6-14h28l6 14" fill="none" stroke="var(--accent)" stroke-width="4" stroke-linejoin="round"/><circle cx="32" cy="72" r="7" fill="var(--accent)"/><circle cx="68" cy="72" r="7" fill="var(--accent)"/></svg>'],
    none: ['None', '<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="34" fill="none" stroke="var(--muted)" stroke-width="4" stroke-dasharray="8 8"/></svg>'],
  };
  const REASONS = [['Rider cancelled', 'Chose Alternative Way Home'], ['No answer', 'Not Answering'], ['Off campus', 'Not Within Pickup Drop-off Parameters'], ['Other', 'Other']];
  const BM_COPY = "javascript:(()=>{if(!/groupme\\.com$/.test(location.hostname)){alert('Open web.groupme.com first, then click this bookmark.');return}let t=localStorage.getItem('access_token');if(!t){alert('No token found. Log in to GroupMe, then try again.');return}t=t.replace(/^\"|\"$/g,'');navigator.clipboard.writeText(t).then(()=>alert('GroupMe token copied. Paste it in the SURE Walk panel.'),()=>prompt('Copy your GroupMe token:',t))})()";

  set = Object.assign({ theme: 'auto', accent: 'orange', mascot: 'm1' }, set);
  const who2 = f => f.first || who(f);
  const digits10 = s => String(s || '').replace(/\D/g, '').slice(-10);
  const fmtPhone = s => { const d = digits10(s); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(s || ''); };
  const timeOf = r => ampm(r.f.ts.slice(11, 16));
  // status model: new (not called), called, cancelled, duplicate (and picked up)
  const isOpen = r => stateOf(r) === 'open';
  const isNew = r => isOpen(r) && !r.f.call && !r.f.disp;
  const isCalled = r => isOpen(r) && !!(r.f.call || r.f.disp);
  function statusChip(r) {
    const st = stateOf(r);
    if (st === 'cancelled') return '<span class="chip cancelled">Cancelled</span>';
    if (st === 'dup') return '<span class="chip dup">Duplicate</span>';
    if (st === 'picked') return '<span class="chip picked">Picked up</span>';
    if (r.f.call) return `<span class="chip called">Called ${esc(ampm(r.f.call))}</span>`;
    if (r.f.disp) return `<span class="chip called">Called</span>`;
    return '<span class="chip new">Not called</span>';
  }
  const groupOf = r => cfGroup(r.f.txs);
  const groupMembers = L => (X ? X.tonight.filter(r => groupOf(r) === L && isOpen(r)) : []);
  const gBadge = r => { const L = groupOf(r); if (!L) return ''; return `<span class="gbadge" style="background:${GROUP_COLORS[L]}">👥 ${L} · ${groupMembers(L).length}</span>`; };

  /* ---------- appearance (theme, accent, mascot) ---------- */
  function applyAppearance() {
    const root = document.documentElement, a = ACCENTS[set.accent] || ACCENTS.orange;
    if (set.theme === 'light' || set.theme === 'dark') root.dataset.theme = set.theme; else delete root.dataset.theme;
    root.style.setProperty('--acc-l', a[1]); root.style.setProperty('--acc-d', a[2]);
  }
  applyAppearance();

  /* ---------- the Auto-text log: ↑ sent to the laptop, ↓ written into the sheet ---------- */
  const logItems = [];
  function logEv(dir, title, detail) {
    logItems.unshift({ at: SWP.austin().slice(11, 16), dir, title, detail: detail || '' });
    logItems.length = Math.min(logItems.length, 80);
    renderLog();
  }
  function feed(text, bad) { logEv(bad ? 'bad' : 'up', text); }
  function logUp(r, ch, was) { // what this panel posted for a ride
    const n = who(r.f);
    if (ch.rsn) return logEv('up', `Cancel · ${n}`, `Row ${r.row} · ${ch.rsn}`);
    if (ch.bg && isRed(ch.bg)) return logEv('up', `Duplicate · ${n}`, `Row ${r.row}`);
    if ('pu' in ch || 'do' in ch) return logEv('up', `Route fix · ${n}`, `${ch.pu || r.f.pu} → ${ch.do || r.f.do}`);
    if ('txs' in ch && cfGroup(ch.txs) !== cfGroup(was && was.txs)) {
      const L = cfGroup(ch.txs);
      return logEv('up', L ? `Group · ${groupMembers(L).map(x => x.f.first).join(', ') || n}` : `Ungrouped · ${n}`, L ? 'Traveling together' : `Row ${r.row}`);
    }
    if (ch.call || ch.disp) return logEv('up', `Called · ${n}`, ch.call ? ampm(ch.call) : `Row ${r.row}`);
    if (ch.ada) return logEv('up', `ADA → ${ch.ada} · ${n}`, `Row ${r.row}`);
    logEv('up', `Update · ${n}`, Object.keys(ch).join(', '));
  }
  function logDown(r, ch, before) { // what the texting computer sent back and this panel wrote
    const n = who(r.f);
    if (ch.rsn) return logEv('down', `Cancelled · ${n}`, `Row ${r.row} · rider replied CANCEL`);
    if (ch.bg && isRed(ch.bg)) return logEv('down', `Duplicate · ${n}`, `Row ${r.row} marked red`);
    if ('pu' in ch) return logEv('down', `Pick-up fixed · ${n}`, `Row ${r.row} · ${before.pu} → ${ch.pu}`);
    if ('do' in ch) return logEv('down', `Drop-off fixed · ${n}`, `Row ${r.row} · ${before.do} → ${ch.do}`);
    if ('call' in ch) return logEv('down', ch.call ? `Call Time ${ampm(ch.call)} · ${n}` : `Call Time cleared · ${n}`, `Row ${r.row}`);
    if ('txs' in ch && cfTime(ch.txs)) return logEv('down', `Confirmed ${ampm(cfTime(ch.txs))} · ${n}`, `Row ${r.row} · replied YES`);
    if ('ada' in ch) return logEv('down', `ADA → ${ch.ada || '—'} · ${n}`, `Row ${r.row}`);
    logEv('down', `Update · ${n}`, `Row ${r.row}`);
  }
  function renderLog() {
    const el = $('feed'); if (!el) return;
    const G = { up: ['up', '↑', 'Sent to the laptop'], down: ['down', '↓', 'Written into the sheet'], bad: ['bad', '!', 'Problem'] };
    el.innerHTML = logItems.length ? logItems.map(x => { const g = G[x.dir] || G.up;
      return `<div class="lg ${x.dir === 'bad' ? 'bad' : ''}"><span class="gl ${g[0]}" title="${g[2]}">${g[1]}</span><span><b>${esc(x.title)}</b>${x.detail ? `<span class="d">${esc(x.detail)}</span>` : ''}</span><span class="t tab">${esc(ampm(x.at))}</span></div>`; }).join('')
      : '<div class="lg"><span></span><span class="muted small">Nothing yet.</span><span></span></div>';
  }

  /* ---------- toast (with Undo) ---------- */
  let toastT = 0;
  function toast(text, canUndo) {
    $('toastTxt').textContent = text; $('toastUndo').hidden = !canUndo; $('toast').hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { $('toast').hidden = true; }, 4000);
  }
  $('toastUndo').addEventListener('click', () => { $('toast').hidden = true; run(() => api('undo'), l => toast(l ? 'Undone · ' + l.toLowerCase() : 'Nothing to undo.')); });
  async function run(fn, done, btn) {
    if (btn) btn.classList.add('busy');
    try { const r = await fn(); if (done) done(r); return r; }
    catch (e) { toast(e.message || String(e)); if (!REMOTE) logEv('bad', e.message || String(e)); }
    finally { if (btn) btn.classList.remove('busy'); }
  }
  function ago(ms) { if (!ms) return ''; const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? 'just now' : Math.round(s / 60) + 'm ago'; }

  /* ---------- the actions (the Calling window asks the side panel to do these) ---------- */
  const rideOf = id => { const r = X && X.byId.get(id); if (!r) throw new Error("That ride isn't in the list anymore."); return r; };
  const ACTIONS = {
    called: id => markCalled(rideOf(id)),
    cancel: (id, reason) => cancelRide(rideOf(id), reason),
    dup: id => markDup(rideOf(id)),
    notAda: id => markNotAda(rideOf(id)),
    route: (id, pu, dropoff) => editPlaces(rideOf(id), pu, dropoff),
    group: (ids, letter) => groupRides(ids, letter),
    ungroup: id => ungroupRide(id),
    addRide: a => addRide(a),
    undo: () => undo(),
    settings: patch => saveSettings(patch),
    selectRow: id => { const r = X && X.byId.get(id); if (r) Excel.run(async ctx => { (await sheetOf(ctx, true)).getRange(`${letter(X.col.first || 1)}${r.row}`).select(); await ctx.sync(); }).catch(() => {}); },
  };
  function api(name, ...args) { return REMOTE ? remoteCall(name, args) : Promise.resolve().then(() => ACTIONS[name](...args)); }
  function saveSettings(patch) {
    const tabChanged = 'tab' in patch && patch.tab !== set.tab;
    set = Object.assign({}, set, patch); ls.set('settings', set);
    applyAppearance(); render();
    if (tabChanged) { ridesTab = ''; tick(); }
    pushSnap(true);
  }

  /* ---------- 3a: the launcher ---------- */
  function renderSync() {
    const dot = $('syncDot'), txt = $('syncTxt');
    if (!syncOn()) { dot.style.background = 'var(--muted)'; txt.textContent = 'Sync off'; }
    else if (sync.err) { dot.style.background = 'var(--bad)'; txt.textContent = sync.err; }
    else if (!sync.ready) { dot.style.background = 'var(--warn)'; txt.textContent = 'Reading chat…'; }
    else { dot.style.background = 'var(--ok)'; txt.textContent = 'Sync on'; }
    $('syncLbl').title = syncOn() ? `GroupMe sync chat: ${set.groupName}` : 'GroupMe sync is off';
    const on = !!syncOn();
    $('abDot').style.background = on ? 'var(--ok)' : 'var(--muted)';
    $('abState').textContent = on ? 'on' : 'off'; $('abState').className = on ? '' : 'muted';
  }
  function renderHome() {
    const news = X ? X.tonight.filter(isNew) : [];
    $('lcN').textContent = X ? news.length : '–';
    $('lcN').style.color = news.length ? 'var(--accent)' : 'var(--ok)';
    const next = news.slice().sort((a, b) => (a.f.ts < b.f.ts ? -1 : 1))[0];
    $('lcNext').innerHTML = !X ? '' : next ? `Next: <b>${esc(who(next.f))}</b> · since ${esc(timeOf(next))}` : '<span style="color:var(--ok)">Everyone\'s been called.</span>';
    $('lcErr').hidden = !loadErr; $('lcErr').textContent = loadErr;
  }
  $('openCalling').addEventListener('click', openCalling);
  $('autoBar').addEventListener('click', () => showAuto(true));
  $('restartBtn').addEventListener('click', () => location.reload());

  /* ---------- 3c: Auto-text ---------- */
  function showAuto(on) { $('home').hidden = on; $('auto').hidden = !on; if (on) renderAuto(); }
  $('autoBack').addEventListener('click', () => showAuto(false));
  function renderAuto() {
    const on = !!syncOn();
    $('setSync').setAttribute('aria-checked', String(on));
    $('avDot').style.background = on && !sync.err ? 'var(--ok)' : on ? 'var(--bad)' : 'var(--muted)';
    $('avState').textContent = !on ? 'Off' : sync.err ? 'Problem' : sync.ready ? 'Connected' : 'Connecting…';
    $('avSeen').textContent = !on ? 'Not sending' : sync.err ? sync.err : sync.lastServerAt ? `Laptop seen ${ago(sync.lastServerAt)}` : 'Laptop not seen yet';
    $('avGm').innerHTML = set.token ? `<span>GroupMe: <b>${esc(set.groupName || 'no chat chosen')}</b></span><button class="link" id="avChange">Change</button><button class="link" id="avForget" style="color:var(--bad)">Forget token</button>`
      : '<button class="link" id="avConnect">Connect GroupMe</button>';
    if ($('avChange')) $('avChange').onclick = () => showConnect(3);
    if ($('avForget')) $('avForget').onclick = () => { Object.assign(sync, { ready: false, lastId: '', seen: new Set(), pending: [], todo: [], adds: [], err: '' }); S.rides = {};
      set = Object.assign({}, set, { token: '', groupId: '', groupName: '', sync: false }); ls.set('settings', set); toast('GroupMe token forgotten'); render(); };
    if ($('avConnect')) $('avConnect').onclick = () => showConnect(1);
  }
  $('setSync').addEventListener('click', () => {
    if (!set.token || !set.groupId) return showConnect(set.token ? 3 : 1);
    setSyncOn(!set.sync);
  });
  function setSyncOn(on) {
    Object.assign(sync, { ready: false, lastId: '', seen: new Set(), pending: [], todo: [], adds: [], err: '' }); S.rides = {};
    set = Object.assign({}, set, { sync: on }); ls.set('settings', set);
    render(); tick();
  }

  /* ---------- 2a: Connect GroupMe (inside Excel the bookmark copies the token; pasting it here saves it) ---------- */
  const cg = { step: 1, err: '', busy: false, groups: null, opened: false, token: '' };
  function showConnect(step) {
    Object.assign(cg, { step: step || 1, err: '', busy: false, opened: false });
    if (cg.step === 3) { cg.token = set.token; cg.groups = null; loadChats(); }
    $('connect').hidden = false; renderConnect();
  }
  $('cgBack').addEventListener('click', () => { if (cg.step === 2) { cg.step = 1; renderConnect(); } else $('connect').hidden = true; });
  function renderConnect() {
    const b = $('cgBody'), err = cg.err ? `<div class="cg-err" role="alert">${esc(cg.err)}</div>` : '';
    if (cg.step === 3) {
      const list = cg.groups, best = list && list.length ? (list.find(g => /dispatch/i.test(g.name)) || list.slice().sort((a, c) => (c.active || 0) - (a.active || 0))[0]) : null;
      b.innerHTML = `<h2>Pick the dispatch chat</h2><p class="cg-sub">Sync turns on when you pick.</p>${err}
        ${!list ? '<div class="muted">Loading your chats…</div>' : list.map(g => `<button class="grp" data-g="${esc(g.id)}">${esc(g.name)}${best && g.id === best.id ? '<span class="sugg">Suggested</span>' : ''}</button>`).join('') || '<div class="muted">No chats on this GroupMe account.</div>'}`;
      b.querySelectorAll('[data-g]').forEach(x => x.onclick = () => pickChat(x.dataset.g));
      return;
    }
    if (cg.step === 2) {
      b.innerHTML = `<h2>Connect GroupMe</h2><p class="cg-sub">Needed for ride posts and crew updates.</p>
        <input class="fld" id="cgTok" type="password" placeholder="Paste token" autocomplete="off" spellcheck="false" style="height:42px">
        <button class="btn primary" id="cgSave" style="width:100%;margin-top:10px" ${cg.busy ? 'disabled' : ''}>${cg.busy ? 'Checking…' : 'Save'}</button>${err}
        <p style="margin-top:12px"><button class="link" id="cgBack2">‹ Back</button></p>`;
      $('cgTok').onkeydown = e => { if (e.key === 'Enter') saveToken($('cgTok').value); };
      $('cgTok').oninput = () => { if (cg.err) { cg.err = ''; const e = b.querySelector('.cg-err'); if (e) e.remove(); } };
      $('cgSave').onclick = () => saveToken($('cgTok').value);
      $('cgBack2').onclick = () => { cg.step = 1; cg.err = ''; renderConnect(); };
      if (!cg.busy) $('cgTok').focus();
      return;
    }
    b.innerHTML = `<h2>Connect GroupMe</h2><p class="cg-sub">Needed for ride posts and crew updates.</p>
      <ol class="cg-steps">
        <li><span class="cg-n">1</span><span class="cg-st"><a class="cg-open" id="cgOpen" href="https://web.groupme.com" target="_blank" rel="noopener">Open GroupMe ↗</a></span></li>
        <li><span class="cg-n">2</span><span class="cg-st"><span>Click your <b>🔖 Get GroupMe token</b> bookmark</span></span></li>
        <li><span class="cg-n">3</span><span class="cg-st"><label for="cgPaste">Come back and paste it here</label>
          <input class="fld" id="cgPaste" type="password" placeholder="Ctrl+V" autocomplete="off" spellcheck="false" ${cg.busy ? 'disabled' : ''}></span></li>
      </ol>
      ${cg.busy ? '<div class="cg-wait">Checking…</div>' : cg.opened ? '<div class="cg-wait">Waiting for your token…</div>' : ''}${err}
      <details class="cg-help"><summary>Need help?</summary>
        <p>No bookmark yet? Drag this to your bookmarks bar:</p>
        <a class="cg-bm" id="cgBm" draggable="true">🔖 Get GroupMe token</a>
        <div class="cg-wait" id="cgFlash" role="status"></div>
        <p><button class="link" id="cgManual">I have the token, paste it instead</button></p>
      </details>`;
    $('cgBm').setAttribute('href', BM_COPY);
    $('cgBm').onclick = e => { e.preventDefault(); const f = $('cgFlash'); f.textContent = "Drag it, don't click it."; clearTimeout(f._t); f._t = setTimeout(() => { f.textContent = ''; }, 2500); };
    $('cgOpen').onclick = () => { cg.opened = true; setTimeout(renderConnect, 50); };
    $('cgPaste').onpaste = () => setTimeout(() => saveToken($('cgPaste').value), 0);
    $('cgPaste').onkeydown = e => { if (e.key === 'Enter') saveToken($('cgPaste').value); };
    $('cgManual').onclick = () => { cg.step = 2; cg.err = ''; renderConnect(); };
  }
  window.addEventListener('focus', () => { if (!$('connect').hidden && cg.step === 1 && $('cgPaste') && !cg.busy) $('cgPaste').focus(); });
  async function saveToken(raw) {
    const tok = cleanTok(raw);
    if (tok.length < 20 || !/^[A-Za-z0-9_-]{20,128}$/.test(tok)) { cg.err = 'That token looks incomplete. Try again.'; return renderConnect(); }
    cg.busy = true; cg.err = ''; renderConnect();
    try {
      const gs = (await gm('/groups', { per_page: 100, omit: 'memberships' }, null, tok)) || []; // the token works if GroupMe lists its chats
      cg.token = tok; set = Object.assign({}, set, { token: tok }); ls.set('settings', set);
      cg.groups = gs.map(g => ({ id: String(g.id), name: g.name, active: Number((g.messages && g.messages.last_message_created_at) || g.updated_at || 0) }));
      Object.assign(cg, { busy: false, step: 3 });
    } catch (e) { Object.assign(cg, { busy: false, err: 'That token looks incomplete. Try again.' }); }
    renderConnect(); render();
  }
  async function loadChats() {
    try { const gs = (await gm('/groups', { per_page: 100, omit: 'memberships' }, null, cg.token)) || [];
      cg.groups = gs.map(g => ({ id: String(g.id), name: g.name, active: Number((g.messages && g.messages.last_message_created_at) || g.updated_at || 0) })); }
    catch (e) { cg.groups = []; cg.err = e.message || String(e); }
    renderConnect();
  }
  function pickChat(id) {
    const g = (cg.groups || []).find(x => x.id === id); if (!g) return;
    Object.assign(sync, { ready: false, lastId: '', seen: new Set(), pending: [], todo: [], adds: [], err: '' }); S.rides = {};
    set = Object.assign({}, set, { token: cg.token || set.token, groupId: g.id, groupName: g.name, sync: true }); ls.set('settings', set);
    $('connect').hidden = true;
    toast('GroupMe sync turned on');
    render(); tick();
  }

  /* ---------- Settings: You / Appearance / Sheet (save as they change) ---------- */
  let setSec = 'you';
  function showSettings(on) {
    $('setModal').hidden = !on;
    if (!on) return;
    $('setName').value = set.name || ''; $('setTab').value = set.tab || '';
    renderSettings();
  }
  function renderSettings() {
    document.querySelectorAll('.mnav button').forEach(b => b.classList.toggle('on', b.dataset.sc === setSec));
    document.querySelectorAll('.mbody section').forEach(x => { x.hidden = x.dataset.sc !== setSec; });
    $('setDispName').setAttribute('aria-checked', String(!!set.dispName));
    document.querySelectorAll('#themeSeg button').forEach(b => b.classList.toggle('on', b.dataset.th === (set.theme || 'auto')));
    $('accRow').innerHTML = Object.keys(ACCENTS).map(k => `<button class="acc ${set.accent === k ? 'on' : ''}" data-acc="${k}" style="background:${ACCENTS[k][1]}" title="${ACCENTS[k][0]}" aria-label="${ACCENTS[k][0]}"></button>`).join('');
    $('mascRow').innerHTML = Object.keys(MASCOTS).map(k => `<button class="masc ${set.mascot === k ? 'on' : ''}" data-masc="${k}">${MASCOTS[k][1]}${MASCOTS[k][0]}</button>`).join('');
  }
  const setChange = patch => { if (REMOTE) { Object.assign(set, patch); applyAppearance(); renderSettings(); renderCalling(true); api('settings', patch).catch(() => {}); } else { saveSettings(patch); renderSettings(); } };
  document.querySelectorAll('.mnav button').forEach(b => b.addEventListener('click', () => { setSec = b.dataset.sc; renderSettings(); }));
  $('setName').addEventListener('change', () => setChange({ name: $('setName').value.trim() }));
  $('setTab').addEventListener('change', () => setChange({ tab: $('setTab').value.trim() }));
  $('setDispName').addEventListener('click', () => setChange({ dispName: !set.dispName }));
  $('themeSeg').addEventListener('click', e => { const b = e.target.closest('[data-th]'); if (b) setChange({ theme: b.dataset.th }); });
  $('accRow').addEventListener('click', e => { const b = e.target.closest('[data-acc]'); if (b) setChange({ accent: b.dataset.acc }); });
  $('mascRow').addEventListener('click', e => { const b = e.target.closest('[data-masc]'); if (b) setChange({ mascot: b.dataset.masc }); });
  $('setBtn').addEventListener('click', () => showSettings(true));
  $('cSet').addEventListener('click', () => showSettings(true));
  $('setClose').addEventListener('click', () => showSettings(false));
  $('setModal').addEventListener('click', e => { if (e.target === $('setModal')) showSettings(false); });

  /* ---------- 3b: Calling ---------- */
  const cl = { open: REMOTE, filter: 'new', sel: null, editing: '', confirm: '', reason: 'Rider cancelled', picking: false, picks: new Set(), copied: '', sig: '' };
  function visibleRides() {
    if (!X) return [];
    const q = $('q').value.trim().toLowerCase(), qd = q.replace(/\D/g, '');
    let rides = X.tonight.slice().reverse();
    if (cl.filter === 'new') rides = rides.filter(isNew); else if (cl.filter === 'called') rides = rides.filter(isCalled);
    if (q) rides = rides.filter(r => [r.f.first, r.f.last, r.f.pu, r.f.do].join(' ').toLowerCase().includes(q) || (qd.length >= 3 && digits10(r.f.phone).includes(qd)));
    return rides;
  }
  function renderCalling(force) {
    if (!cl.open) return;
    document.body.classList.toggle('calling-open', !REMOTE);
    const rides = visibleRides(), all = X ? X.tonight : [];
    const counts = { new: all.filter(isNew).length, called: all.filter(isCalled).length, all: all.length };
    $('cCount').textContent = `${counts.new} to call`;
    $('cPills').innerHTML = [['new', 'To call'], ['called', 'Called'], ['all', 'All']].map(([k, l]) => `<button role="tab" data-f="${k}" class="${cl.filter === k ? 'on' : ''}" aria-selected="${cl.filter === k}">${l} ${counts[k]}</button>`).join('');
    if (cl.sel && !rides.some(r => r.id === cl.sel) && !(X && X.byId.get(cl.sel) && cl.filter === 'all')) { /* keep the selected ride shown even if it left the filter */ }
    $('list').innerHTML = rides.slice(0, 200).map(r => `<button class="crow ${r.id === cl.sel ? 'sel' : ''}" data-id="${esc(r.id)}">
        <span class="t tab">${esc(timeOf(r))}</span>
        <span style="min-width:0"><span class="n"><span class="nm">${esc(who(r.f))}</span>${gBadge(r)}</span><span class="r" style="display:block">${esc(r.f.pu)} → ${esc(r.f.do)}</span></span>
        ${statusChip(r)}</button>`).join('') || '<div class="cempty">Nothing here.</div>';
    $('calling').classList.toggle('has-sel', !!cl.sel);
    renderDetail(force);
  }
  function renderDetail(force) {
    const box = $('selRide'), r = cl.sel && X && X.byId.get(cl.sel);
    const sig = JSON.stringify([r && r.f, cl.editing, cl.confirm, cl.reason, cl.picking, [...cl.picks], cl.copied, set.mascot, set.dispName, r && groupOf(r) && groupMembers(groupOf(r)).map(x => x.id)]);
    if (!force && sig === cl.sig) return;
    if (!force && box.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return; // don't wipe what they're typing
    cl.sig = sig;
    if (!r) {
      const m = MASCOTS[set.mascot] && set.mascot !== 'none' ? MASCOTS[set.mascot][1] : '';
      box.innerHTML = cl.filter === 'new' && !visibleRides().length
        ? `<div class="nobody">${m}<h3>No one to call</h3><div class="muted">New rides show up here.</div></div>`
        : '<div class="nobody"><div class="muted">Pick a rider on the left.</div></div>';
      return;
    }
    const f = r.f, open = isOpen(r), ada = /yes/i.test(f.ada), L = groupOf(r), d = digits10(f.phone);
    const others = X.tonight.filter(x => x.id !== r.id && isOpen(x) && (!L || groupOf(x) !== L))
      .sort((a, b) => (a.f.pu.toLowerCase() === f.pu.toLowerCase() ? 0 : 1) - (b.f.pu.toLowerCase() === f.pu.toLowerCase() ? 0 : 1) || (a.f.ts < b.f.ts ? 1 : -1));
    const routeCard = (k, label) => cl.editing ? `<div class="rcard ed"><small>${label}</small><input id="${k === 'pu' ? 'cPu' : 'cDo'}" value="${esc(f[k])}" aria-label="${label}" autocomplete="off"></div>`
      : `<button class="rcard" data-a="route" data-which="${k}" ${open ? '' : 'disabled'} title="${open ? 'Click to edit' : ''}"><small>${label}</small><span class="v">${esc(f[k] || '?')}</span></button>`;
    box.innerHTML = `<button class="link cback" data-a="back">‹ List</button>
      <div class="chead"><h2 id="cName">${esc(who(f))}</h2>${statusChip(r)}${ada ? '<span class="pill-ada">ADA</span>' : ''}</div>
      <div class="csub">Submitted ${esc(timeOf(r))} · row ${r.row}</div>
      <div class="phone"><a class="tel" href="tel:+1${d}">${esc(fmtPhone(f.phone))}</a>
        <button class="btn" data-a="copy">${cl.copied === r.id ? 'Copied' : 'Copy'}</button>
        ${open ? `<button class="btn primary" data-a="called">${f.call || f.disp ? 'Called again' : 'Mark called'}</button>` : ''}</div>
      <div class="lbl">Route${open ? ' · click to edit' : ''}</div>
      <div class="rte">${routeCard('pu', 'Pick-up')}<span class="rarrow">→</span>${routeCard('do', 'Drop-off')}</div>
      ${cl.editing ? '<div class="ract"><button class="btn" data-a="routeCancel">Cancel</button><button class="btn primary" data-a="routeSave">Save to sheet</button></div>' : ''}
      ${r.notes ? `<div class="cnote">Note: ${esc(r.notes)}</div>` : ''}
      ${open ? `<div class="gsec">
        ${L ? `<div class="gcard" style="border-color:${GROUP_COLORS[L]}"><b style="color:${GROUP_COLORS[L]}">Group ${L}</b>
          ${groupMembers(L).map(x => `<span class="gmem">${esc(x.f.first || who(x.f))}${x.id === r.id ? ' <span class="muted">(this rider)</span>' : ''}<button data-a="ungroup" data-id="${esc(x.id)}" aria-label="Remove from group">✕</button></span>`).join('')}</div>` : ''}
        ${cl.picking ? `<div class="gpick"><b>Who's riding with ${esc(who2(f))}?</b><div class="gl">${others.map(x => `<div class="gopt ${cl.picks.has(x.id) ? 'on' : ''}" data-pick="${esc(x.id)}" role="checkbox" aria-checked="${cl.picks.has(x.id)}" tabindex="0">
            <span class="sq">${cl.picks.has(x.id) ? '✓' : ''}</span><span>${esc(who(x.f))}${groupOf(x) ? ` <span class="muted">(in group ${groupOf(x)})</span>` : ''}${x.f.pu.toLowerCase() === f.pu.toLowerCase() ? '<span class="samepu">Same pick-up</span>' : ''}<small>${esc(x.f.pu)} → ${esc(x.f.do)}</small></span></div>`).join('') || '<div class="muted small">No other open rides tonight.</div>'}</div>
            <div class="ract" style="margin-top:0"><button class="btn" data-a="pickCancel">Cancel</button><button class="btn primary" data-a="groupGo" ${cl.picks.size ? '' : 'disabled'}>${cl.picks.size ? `Group ${cl.picks.size + 1} riders` : 'Pick riders'}</button></div></div>`
          : `<button class="gbtn" data-a="pick">${L ? '＋ Add someone to this group' : '👥 Traveling with others…'}</button>`}
      </div>
      <div class="cacts"><button class="btn red" data-a="cancel">✖ Cancel ride</button><button class="btn" data-a="dup">⧉ Mark duplicate</button>
        ${ada ? '<button class="btn" data-a="notAda" title="Rider doesn\'t need ADA assistance">♿ Mark not ADA</button>' : ''}</div>
      ${cl.confirm === 'cancel' ? `<div class="conf cx"><p>Cancel ${esc(who2(f))}'s ride?</p><div class="rpills">${REASONS.map(([l]) => `<button data-reason="${l}" class="${cl.reason === l ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="row2" style="justify-content:flex-end"><button class="btn" data-a="close">Keep ride</button><button class="btn badf" data-a="cancelGo">Cancel ride</button></div></div>` : ''}
      ${cl.confirm === 'dup' ? `<div class="conf dx"><p>Mark row ${r.row} as a duplicate?</p><div class="small muted" style="margin:-6px 0 10px">The row turns red in the sheet.</div>
        <div class="row2"><button class="btn" data-a="close">Back</button><button class="btn warnf" data-a="dupGo">Mark duplicate</button></div></div>` : ''}` : ''}`;
    if (cl.editing) { const el = $(cl.editing === 'do' ? 'cDo' : 'cPu'); if (el) { el.focus(); el.select(); } }
  }
  function choose(id, selectInSheet) {
    if (cl.sel !== id) Object.assign(cl, { editing: '', confirm: '', picking: false, picks: new Set(), copied: '' });
    cl.sel = id; renderCalling(true);
    const row = $('list').querySelector(`[data-id="${CSS.escape(id)}"]`); if (row) row.scrollIntoView({ block: 'nearest' });
    if (selectInSheet) api('selectRow', id).catch(() => {});
  }
  // after a ride leaves "To call": the next one in the list
  function advance(fromId) {
    if (cl.filter !== 'new') return renderCalling(true);
    const ids = visibleRides().map(r => r.id), prev = cl.prevIds || [];
    const i = prev.indexOf(fromId), next = prev.slice(i + 1).find(id => ids.includes(id)) || prev.slice(0, Math.max(i, 0)).reverse().find(id => ids.includes(id)) || ids[0] || null;
    choose(next, false);
  }
  $('cPills').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (!b) return; cl.filter = b.dataset.f; renderCalling(true); });
  $('q').addEventListener('input', () => renderCalling(true));
  $('list').addEventListener('click', e => { const b = e.target.closest('.crow'); if (b) choose(b.dataset.id, true); });
  $('selRide').addEventListener('click', e => {
    const p = e.target.closest('[data-pick]');
    if (p) { cl.picks.has(p.dataset.pick) ? cl.picks.delete(p.dataset.pick) : cl.picks.add(p.dataset.pick); return renderDetail(true); }
    const rp = e.target.closest('[data-reason]');
    if (rp) { cl.reason = rp.dataset.reason; return renderDetail(true); }
    const b = e.target.closest('[data-a]'); if (!b) return;
    doAction(b.dataset.a, b);
  });
  $('selRide').addEventListener('keydown', e => {
    if (e.target.id === 'cPu' || e.target.id === 'cDo') { if (e.key === 'Enter') { e.preventDefault(); doAction('routeSave'); } else if (e.key === 'Escape') { e.preventDefault(); doAction('routeCancel'); } }
    const p = e.target.closest && e.target.closest('[data-pick]'); if (p && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); p.click(); }
  });
  function doAction(a, btn) {
    const r = cl.sel && X && X.byId.get(cl.sel); if (!r && a !== 'back') return;
    const n = r && who2(r.f), id = r && r.id;
    cl.prevIds = visibleRides().map(x => x.id);
    if (a === 'back') { cl.sel = null; return renderCalling(true); }
    if (a === 'copy') { const t = fmtPhone(r.f.phone); (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).catch(() => {}); cl.copied = id; return renderDetail(true); }
    if (a === 'called') { const again = !!(r.f.call || r.f.disp); return run(() => api('called', id), () => { toast(again ? `Called ${n} again` : `Marked ${n} called`, true); if (!again) advance(id); else renderCalling(true); }, btn); }
    if (a === 'route') { if (!isOpen(r)) return; cl.editing = btn.dataset.which || 'pu'; return renderDetail(true); }
    if (a === 'routeCancel') { cl.editing = ''; return renderDetail(true); }
    if (a === 'routeSave') {
      const pu = ($('cPu') || {}).value, dropoff = ($('cDo') || {}).value;
      if (!String(pu || '').trim() || !String(dropoff || '').trim()) return toast("Pick-up and drop-off can't be blank.");
      cl.editing = '';
      return run(() => api('route', id, pu.trim(), dropoff.trim()), res => { toast(res ? 'Route saved to the sheet' : 'Nothing changed.', !!res); renderCalling(true); });
    }
    if (a === 'pick') { cl.picking = true; cl.picks = new Set(); return renderDetail(true); }
    if (a === 'pickCancel') { cl.picking = false; cl.picks = new Set(); return renderDetail(true); }
    if (a === 'groupGo') {
      const ids = [id, ...cl.picks]; cl.picking = false; cl.picks = new Set();
      return run(() => api('group', ids, groupOf(r) || ''), () => { toast(`${ids.length} riders grouped · sent to dispatch`, true); renderCalling(true); }, btn);
    }
    if (a === 'ungroup') return run(() => api('ungroup', btn.dataset.id), () => { toast('Removed from group', true); renderCalling(true); }, btn);
    if (a === 'cancel' || a === 'dup') { cl.confirm = cl.confirm === a ? '' : a; if (a === 'cancel') cl.reason = 'Rider cancelled'; return renderDetail(true); }
    if (a === 'close') { cl.confirm = ''; return renderDetail(true); }
    if (a === 'cancelGo') {
      const reason = (REASONS.find(x => x[0] === cl.reason) || REASONS[0])[1], shown = cl.reason; cl.confirm = '';
      return run(() => api('cancel', id, reason), () => { toast(`${n}'s ride cancelled · ${shown}`, true); advance(id); }, btn);
    }
    if (a === 'dupGo') { cl.confirm = ''; return run(() => api('dup', id), () => { toast(`Row ${r.row} marked duplicate`, true); advance(id); }, btn); }
    if (a === 'notAda') return run(() => api('notAda', id), () => { toast(`${n} marked not ADA`, true); renderCalling(true); }, btn);
  }
  // keyboard: ↑ ↓ move · C mark called · E edit route (not while typing in a field)
  window.addEventListener('keydown', e => {
    if (!cl.open || !$('setModal').hidden || !$('addCard').hidden) return;
    const t = e.target, typing = t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const ids = visibleRides().map(r => r.id), i = ids.indexOf(cl.sel);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const j = e.key === 'ArrowDown' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1); if (ids[j]) choose(ids[j], true); return; }
    const r = cl.sel && X && X.byId.get(cl.sel); if (!r) return;
    if ((e.key === 'c' || e.key === 'C') && isNew(r)) { e.preventDefault(); doAction('called'); }
    if ((e.key === 'e' || e.key === 'E') && isOpen(r)) { e.preventDefault(); cl.editing = 'pu'; renderDetail(true); }
  });
  $('cClose').addEventListener('click', () => { if (REMOTE) { try { window.close(); } catch (e) { /* Excel closes it */ } send({ t: 'close' }); } else closeCalling(); });

  /* ---------- ＋ Ride ---------- */
  let addPending = null;
  function showAdd(on) {
    $('addCard').hidden = !on;
    if (!on) return;
    $('addCard').querySelectorAll('input:not([type=checkbox])').forEach(el => { el.value = ''; });
    $('aAda').value = 'No'; $('aCalled').checked = false; $('aMsg').textContent = ''; $('aConfirm').hidden = true; addPending = null;
    $('aEidRow').hidden = !!(X && X.col && !X.col.eid);
    $('aEmailRow').hidden = !!(X && X.col && !X.col.email);
    $('aFirst').focus();
  }
  $('addBtn').addEventListener('click', () => showAdd(true));
  $('aClose').addEventListener('click', () => showAdd(false));
  $('addCard').addEventListener('click', e => { if (e.target === $('addCard')) showAdd(false); });
  $('addCard').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); $('aSave').click(); } });
  $('aSave').addEventListener('click', () => {
    const g = id => $(id).value.trim();
    let phone = g('aPhone').replace(/\D/g, '');
    if (phone.length === 11 && phone.charAt(0) === '1') phone = phone.slice(1);
    const called = $('aCalled').checked;
    const a = { first: g('aFirst'), last: g('aLast'), phone, eid: g('aEid'), email: g('aEmail'), pu: g('aPu'), do: g('aDo'), ada: $('aAda').value, notes: g('aNotes'),
      call: called ? nowHM() : '', disp: called ? set.name : '' };
    const miss = [['first', 'first name'], ['pu', 'pick-up'], ['do', 'drop-off']].filter(([k]) => !a[k]).map(x => x[1]);
    if (miss.length) { $('aMsg').textContent = 'Fill in the ' + miss.join(', ') + '.'; return; }
    if (phone.length !== 10) { $('aMsg').textContent = 'The phone number needs 10 digits.'; return; }
    if (a.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)) { $('aMsg').textContent = "That email doesn't look right."; return; }
    const same = X && X.tonight.find(r => isOpen(r) && digits10(r.f.phone) === phone);
    if (same && addPending !== phone) { // no confirm() in Excel: ask in the form, a second press adds it
      addPending = phone; $('aConfirm').hidden = false;
      $('aConfirm').textContent = `${who(same.f)} already has an open ride tonight with that phone (row ${same.row}). Press Add ride again to add another one anyway.`; return;
    }
    $('aMsg').textContent = '';
    run(() => api('addRide', a), row => { showAdd(false); toast(`Added ${who(a)}'s ride — row ${row}`); const r = X && X.byRow.get(row); if (r) choose(r.id, false); else renderCalling(true); }, $('aSave'));
  });

  /* ---------- opening Calling: its own window (the add-in), or over the side panel ---------- */
  let dlg = null, dlgSent = '';
  function openCalling() {
    if (REMOTE) return;
    if (dlg) return toast('Calling is already open in its own window.');
    const ui = window.Office && Office.context && Office.context.ui;
    if (HOSTED() && ui && ui.displayDialogAsync) {
      ui.displayDialogAsync(window.SWT_TEST && T.callingUrl ? T.callingUrl : new URL('calling.html', location.href).href, { height: 82, width: 72, displayInIframe: false }, res => {
        if (res.status !== Office.AsyncResultStatus.Succeeded) { openInPane(); toast("Excel couldn't open a window: Calling is open here instead."); return; }
        dlg = res.value; dlgSent = '';
        dlg.addEventHandler(Office.EventType.DialogMessageReceived, a => onChild(a.message));
        dlg.addEventHandler(Office.EventType.DialogEventReceived, () => { dlg = null; });
      });
    } else openInPane();
  }
  function openInPane() {
    cl.open = true; $('calling').hidden = false;
    if (!cl.sel) { const first = visibleRides()[0]; cl.sel = first ? first.id : null; }
    renderCalling(true);
  }
  function closeCalling() { cl.open = false; $('calling').hidden = true; document.body.classList.remove('calling-open'); render(); }

  /* ---------- the window relay: chunked messages (Excel limits their size) ---------- */
  const CHUNK = 24000, parts = {};
  let seq = 0;
  function chunks(obj) { const s = JSON.stringify(obj), id = 'm' + (++seq), n = Math.max(1, Math.ceil(s.length / CHUNK)), out = [];
    for (let i = 0; i < n; i++) out.push(`SWT|${id}|${i}|${n}|${s.slice(i * CHUNK, (i + 1) * CHUNK)}`); return out; }
  function unchunk(str) {
    const m = /^SWT\|([^|]+)\|(\d+)\|(\d+)\|([\s\S]*)$/.exec(str); if (!m) return null;
    const p = parts[m[1]] || (parts[m[1]] = []); p[+m[2]] = m[4];
    if (p.filter(x => x != null).length < +m[3]) return null;
    delete parts[m[1]]; return JSON.parse(p.join(''));
  }
  function send(obj) { // to the other side
    try {
      if (REMOTE) chunks(obj).forEach(c => Office.context.ui.messageParent(c));
      else if (dlg) chunks(obj).forEach(c => dlg.messageChild(c));
    } catch (e) { /* the window closed */ }
  }
  function snapState() { // the rides + settings the Calling window shows
    if (!X) return { err: loadErr || 'Loading…' };
    return { name: X.name, col: { txs: !!X.col.txs, eid: !!X.col.eid, email: !!X.col.email }, err: loadErr,
      rides: X.tonight.map(r => ({ id: r.id, row: r.row, f: r.f, notes: r.notes || '' })),
      set: { name: set.name, dispName: set.dispName, tab: set.tab, theme: set.theme, accent: set.accent, mascot: set.mascot } };
  }
  function pushSnap(force) {
    if (!dlg) return;
    const s = snapState(), j = JSON.stringify(s);
    if (!force && j === dlgSent) return;
    dlgSent = j; send({ t: 'snap', s });
  }
  async function onChild(str) { // side panel: a message from the Calling window
    const m = unchunk(str); if (!m) return;
    if (m.t === 'ready') return pushSnap(true);
    if (m.t === 'close') { try { dlg.close(); } catch (e) { /* closed */ } dlg = null; return; }
    if (m.t === 'act') {
      try { const result = await ACTIONS[m.name](...(m.args || [])); send({ t: 'ret', id: m.id, ok: true, result: result == null ? null : result }); }
      catch (e) { send({ t: 'ret', id: m.id, ok: false, error: e.message || String(e) }); }
      pushSnap(true);
    }
  }
  const waiting = {};
  let callSeq = 0;
  function remoteCall(name, args) { // Calling window: ask the side panel
    const id = 'c' + (++callSeq);
    return new Promise((ok, fail) => {
      const t = setTimeout(() => { delete waiting[id]; fail(new Error('The side panel in Excel did not answer. Is it still open?')); }, 90000);
      waiting[id] = { ok: v => { clearTimeout(t); ok(v); }, fail: e => { clearTimeout(t); fail(e); } };
      send({ t: 'act', id, name, args });
    });
  }
  function applySnap(s) { // Calling window: the rides as the side panel sees them
    loadErr = s.err || '';
    if (s.set) { set = Object.assign({}, set, s.set); applyAppearance(); }
    if (s.rides) {
      X = { name: s.name, col: s.col, rides: s.rides, tonight: s.rides };
      X.byId = new Map(s.rides.map(r => [r.id, r])); X.byRow = new Map(s.rides.map(r => [r.row, r]));
    }
    if (!cl.sel) { const first = visibleRides()[0]; cl.sel = first ? first.id : null; }
    renderCalling();
  }

  /* ---------- render everything ---------- */
  function render() {
    if (REMOTE) return renderCalling();
    renderSync(); renderHome();
    if (!$('auto').hidden) renderAuto();
    renderCalling();
    pushSnap();
  }

  // the row you click in the sheet: that ride in Calling
  async function onSelect(address) {
    const m = /!?\$?[A-Z]+\$?(\d+)/.exec(String(address || '').split('!').pop());
    if (!m) return;
    const row = +m[1];
    if (!X || !X.byRow.has(row)) { try { await refresh(); } catch (e) { return; } }
    const r = X.byRow.get(row);
    if (!r) return;
    if (dlg) send({ t: 'select', id: r.id });
    if (cl.open && r.id !== cl.sel) choose(r.id, false);
  }
  async function watchSelection() {
    try {
      await Excel.run(async ctx => {
        (await sheetOf(ctx, true)).onSelectionChanged.add(ev => onSelect(ev.address));
        await ctx.sync();
      });
    } catch (e) { // older Excel: check the selection now and then instead
      setInterval(() => Excel.run(async ctx => { const cur = ctx.workbook.getSelectedRange(); cur.load('address'); await ctx.sync(); onSelect(cur.address); }).catch(() => {}), 1500);
    }
  }
  const cleanTok = s => String(s || '').trim()
    .replace(/^.*(?:x-access-token|access_token|token|bearer)[:=\s]+/i, '')
    .replace(/^["']|["'];?$/g, '')
    .trim();

  window.SWT = { tick, refresh, get X() { return X; }, get S() { return S; }, sync, undoStack, choose, openCalling, closeCalling, showConnect, cl, cg, api, logEv, get set() { return set; } }; // console / tests
  if (REMOTE) {
    document.body.classList.add('remote');
    $('calling').hidden = false;
    Office.onReady(() => {
      Office.context.ui.addHandlerAsync(Office.EventType.DialogParentMessageReceived, a => {
        const m = unchunk(a.message); if (!m) return;
        if (m.t === 'snap') applySnap(m.s);
        else if (m.t === 'ret' && waiting[m.id]) { const w = waiting[m.id]; delete waiting[m.id]; m.ok ? w.ok(m.result) : w.fail(new Error(m.error || 'Error')); }
        else if (m.t === 'select') { if (X && X.byId.get(m.id)) choose(m.id, false); }
      }, () => send({ t: 'ready' }));
    });
  } else {
    Office.onReady(async () => {
      await tick();
      watchSelection();
      setInterval(tick, TICK_MS);
      if (!set.token && !T.noConnect) { /* first run: the Auto-text bar says off; Connect GroupMe opens from there */ }
    });
  }
})();
