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
    ['id', /^id$/], ['ts', /^(form submitted|timestamp|completion time)/], ['disp', /^dispatch/], ['call', /^call time/], ['arr', /^arrival/],
    ['last', /^last name/], ['first', /^first name/], ['phone', /^phone/], ['pu', /^pick ?-?up/], ['do', /^drop ?-?off/],
    ['ada', /disabilit|^ada\b/], ['loc', /^location$/], ['van', /^(van|vehicle)/], ['drv', /^driver$/], ['nav', /^navigator$/],
    ['rsn', /^reason/], ['rsn', /cancel/],
  ];
  function layoutOf(header) {
    const h = header.map(x => String(x || '').toLowerCase().replace(/[^a-z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim());
    const col = {}, used = new Set();
    HEAD.forEach(([k, re]) => { if (col[k]) return; const i = h.findIndex((x, j) => re.test(x) && !used.has(j)); if (i >= 0) { col[k] = i + 1; used.add(i); } });
    const need = { ts: 'Form Submitted', first: 'First Name', phone: 'Phone', pu: 'Pick-up', do: 'Drop-off', call: 'Call Time' };
    const missing = Object.keys(need).filter(k => !col[k]).map(k => need[k]);
    if (missing.length) throw new Error(`Can't find these columns in row 1 of this tab: ${missing.join(', ')}. Pick the rides tab in ⚙ Settings.`);
    return col;
  }
  const letter = n => { let s = ''; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const RIDE_FIELDS = ['first', 'last', 'phone', 'pu', 'do', 'ada', 'disp', 'call', 'arr', 'loc', 'van', 'drv', 'nav', 'rsn'];

  /* ---------------- reading ---------------- */
  const sheetOf = ctx => (set.tab ? ctx.workbook.worksheets.getItem(set.tab) : ctx.workbook.worksheets.getFirst());
  let X = null; // { name, col, rides: [ride], byId, byRow }
  function rowColor(cells, cols) { // the row's color: the most common fill among the ride columns
    const n = {};
    cols.forEach(c => { const v = cells[c - 1] && cells[c - 1].bg; if (v) n[v] = (n[v] || 0) + 1; });
    return Object.keys(n).sort((a, b) => n[b] - n[a])[0] || '#ffffff';
  }
  async function readSheet() {
    X = await Excel.run(async ctx => {
      const ws = sheetOf(ctx);
      ws.load('name');
      const used = ws.getUsedRangeOrNullObject(true); used.load('rowIndex,rowCount');
      const hdr = ws.getRangeByIndexes(0, 0, 1, READ_COLS); hdr.load('text');
      await ctx.sync();
      const col = layoutOf(hdr.text[0]);
      const lastRow = used.isNullObject ? 1 : used.rowIndex + used.rowCount;
      const top = Math.max(2, lastRow - SCAN_ROWS - 60);
      if (lastRow < top) return { name: ws.name, col, rides: [] };
      const rg = ws.getRangeByIndexes(top - 1, 0, lastRow - top + 1, READ_COLS);
      rg.load('values,text');
      const props = rg.getCellProperties({ format: { fill: { color: true }, font: { color: true } } });
      await ctx.sync();
      const rideCols = ['ts', 'first', 'last', 'phone', 'pu', 'do'].map(k => col[k]).filter(Boolean);
      const rides = [];
      for (let i = 0; i < rg.values.length; i++) {
        const v = rg.values[i], t = rg.text[i], cells = props.value[i].map(c => ({ bg: String((c.format.fill && c.format.fill.color) || '#ffffff').toLowerCase() }));
        const tsv = v[col.ts - 1], ts = typeof tsv === 'number' && tsv > 1 ? serialToWall(tsv) : textToWall(t[col.ts - 1]);
        if (!ts) continue; // not a ride (blank, or the shift roster below the rides)
        const get = k => (col[k] ? String(t[col[k] - 1] == null ? '' : t[col[k] - 1]).trim() : '');
        const f = { ts, row: String(top + i) };
        RIDE_FIELDS.forEach(k => { f[k] = get(k); });
        f.call = col.call ? hm(v[col.call - 1], t[col.call - 1]) : '';
        f.arr = col.arr ? hm(v[col.arr - 1], t[col.arr - 1]) : '';
        if (f.rsn === '0') f.rsn = '';
        if (/^#+$/.test(f.phone)) f.phone = String(v[col.phone - 1]);
        f.bg = rowColor(cells, rideCols);
        const idv = col.id ? String(v[col.id - 1] == null ? '' : v[col.id - 1]).trim() : '';
        const id = idv ? 'f' + idv : 't' + ts.replace(/\D/g, '') + (f.phone.replace(/\D/g, '').slice(-4) || f.first.toLowerCase());
        rides.push({ id, row: top + i, f, cells });
      }
      return { name: ws.name, col, rides };
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
      const ws = sheetOf(ctx);
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
    const idOk = col.id ? 'f' + String(v[col.id - 1]).trim() === r.id : true;
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
    if ((k === 'call' || k === 'arr') && /^\d{1,2}:\d{2}$/.test(val)) { rg.values = [[hmToSerial(val)]]; rg.numberFormat = [['h:mm']]; return; }
    rg.values = [[String(val)]];
  }
  function paintRow(ws, row, color) {
    const pr = X && X.byRow.get(row); if (pr) painted.add(pr.id);
    const rg = ws.getRange(`${row}:${row}`);
    if (!color || color === '#ffffff') rg.format.fill.clear(); else rg.format.fill.color = color;
    rg.format.font.color = isBlack(color) ? '#ffffff' : '#000000';
  }
  async function act(r, label, keys, wholeRow, fn) {
    const snap = snapshot(r, keys, wholeRow);
    await Excel.run(async ctx => {
      const ws = sheetOf(ctx);
      await check(ws, ctx, r);
      fn(ws);
      await ctx.sync();
    });
    undoStack.push(Object.assign(snap, { label }));
    if (undoStack.length > 15) undoStack.shift();
    feed(`${label}: ${who(r.f)}`);
    toast(label + ' — ' + who(r.f), true);
    await refresh();
  }
  const undoStack = [];
  async function undo() {
    const u = undoStack.pop();
    if (!u) return toast('Nothing to undo.');
    const r = X.byId.get(u.id) || { id: u.id, row: u.row, f: u.before };
    await Excel.run(async ctx => {
      const ws = sheetOf(ctx);
      await check(ws, ctx, Object.assign({}, r, { row: u.row }));
      u.keys.forEach(k => writeField(ws, u.row, k, u.before[k]));
      if (u.wholeRow) {
        const all = ws.getRange(`${u.row}:${u.row}`);
        all.format.fill.clear(); all.format.font.color = '#000000';
        u.fills.forEach((bg, j) => { if (bg && bg !== '#ffffff') ws.getRangeByIndexes(u.row - 1, j, 1, 1).format.fill.color = bg; });
        if (isBlack(u.before.bg)) all.format.font.color = '#ffffff';
      }
      await ctx.sync();
    });
    feed(`Undid ${u.label.toLowerCase()}: ${who(u.before)}`);
    toast('Undone');
    await refresh();
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
  const editPlaces = (r, pu, dropoff) => {
    const keys = [];
    if (pu !== r.f.pu) keys.push('pu');
    if (dropoff !== r.f.do) keys.push('do');
    if (!keys.length) return toast('Nothing changed.');
    return act(r, 'Changed ' + keys.map(k => (k === 'pu' ? 'pick-up' : 'drop-off')).join(' + '), keys, false, ws => {
      if (keys.includes('pu')) writeField(ws, r.row, 'pu', pu);
      if (keys.includes('do')) writeField(ws, r.row, 'do', dropoff);
    });
  };

  /* ---------------- GroupMe sync ---------------- */
  const S = { rides: {} };               // the rides as the chat describes them
  const sync = { ready: false, lastId: '', seen: new Set(), pending: [], todo: [], lastPost: 0, err: '', lastServerAt: 0, busy: false };
  async function gm(pathname, query, body, token) {
    const u = new URL(GM + pathname);
    Object.entries(query || {}).forEach(([k, v]) => u.searchParams.set(k, v));
    const res = await fetch(u, { method: body ? 'POST' : 'GET', headers: Object.assign({ 'X-Access-Token': token || set.token }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    if (res.status === 304) return null;
    if (res.status === 401) throw new Error('GroupMe refused the token — paste a new one in ⚙ Settings.');
    if (!res.ok) throw new Error('GroupMe answered ' + res.status);
    return (await res.json()).response;
  }
  function takeMessages(ms) { // chat messages -> fold; the texting computer's edits go on the to-do list
    ms.slice().sort((a, b) => a.created_at - b.created_at || (BigInt(a.id) < BigInt(b.id) ? -1 : 1)).forEach(m => {
      if (sync.seen.has(m.id)) return;
      sync.seen.add(m.id);
      if (!sync.lastId || BigInt(m.id) > BigInt(sync.lastId)) sync.lastId = m.id;
      SWP.parse(m.text).forEach(ev => {
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
      if (skipped.length) feed(`Kept the sheet's ${skipped.join(', ')} for ${who(r.f)} (changed here first)`, true);
    });
    if (!work.length) return;
    await Excel.run(async ctx => {
      const ws = sheetOf(ctx);
      for (const { r, ch } of work) {
        try { await check(ws, ctx, r); } catch (e) { feed(e.message, true); continue; }
        Object.keys(ch).forEach(k => { if (k === 'bg') paintRow(ws, r.row, ch.bg); else writeField(ws, r.row, k, ch[k]); });
        Object.assign(r.f, ch);
        feed('Texting: ' + SWP.summary({ e: 'upd', src: 's', f: ch }, r.f).replace(/^\S+\s/, ''));
      }
      await ctx.sync();
    });
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
        return;
      }
      const ch = {};
      SWP.FIELDS.forEach(f => { if (f !== 'ts' && r.f[f] !== undefined && !SWP.same(f, r.f[f], k.f[f])) ch[f] = r.f[f]; });
      if (!Object.keys(ch).length) return;
      if (k.src === 'ignored') { Object.assign(k.f, ch); return; }
      const ev = { e: 'upd', id: r.id, src, f: ch };
      lines.push(SWP.line(ev, k.f)); SWP.fold(S, ev);
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
        diff();
        try { await postOne(); } catch (e) { sync.err = e.message || String(e); }
      }
      render();
    } catch (e) {
      loadErr = e && e.code === 'ItemNotFound' ? `There's no tab named "${set.tab}" — fix it in ⚙ Settings.` : (e.message || String(e));
      render();
    } finally { busy = false; }
  }

  /* ---------------- UI ---------------- */
  const feedItems = [];
  function feed(text, bad) {
    feedItems.unshift({ at: SWP.austin().slice(11, 16), text, bad });
    feedItems.length = Math.min(feedItems.length, 40);
    $('feed').innerHTML = feedItems.map(x => `<div class="${x.bad ? 'bad' : ''}"><span class="tm">${ampm(x.at)}</span><span>${esc(x.text)}</span></div>`).join('');
  }
  let toastT = 0;
  function toast(text, canUndo) {
    $('toastTxt').textContent = text; $('toastUndo').hidden = !canUndo; $('toast').hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { $('toast').hidden = true; }, canUndo ? 7000 : 3500);
  }
  function ago(ms) { if (!ms) return ''; const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? 'just now' : Math.round(s / 60) + ' min ago'; }

  function renderSync() {
    const dot = $('syncDot'), txt = $('syncTxt');
    if (!syncOn()) { dot.style.background = '#cfcfcf'; txt.textContent = 'Sync off'; return; }
    if (sync.err) { dot.style.background = '#ff5252'; txt.textContent = sync.err; return; }
    if (!sync.ready) { dot.style.background = '#ffd54f'; txt.textContent = 'Reading chat…'; return; }
    dot.style.background = '#69f0ae';
    txt.textContent = sync.pending.length ? `Syncing · ${sync.pending.length} to post` : 'Synced' + (sync.lastServerAt ? ' · texting ' + ago(sync.lastServerAt) : '');
    $('syncLbl').title = `GroupMe sync chat: ${set.groupName}`;
  }

  let openForm = ''; // '', 'cancel', 'edit'
  function renderSel() {
    const r = sel && X && (X.byId.get(sel) || null);
    $('selEmpty').hidden = !!r; $('selRide').hidden = !r;
    if (loadErr) { $('selEmpty').hidden = false; $('selEmpty').innerHTML = `<span class="err">${esc(loadErr)}</span>`; $('selRide').hidden = true; return; }
    if (!r) { $('selEmpty').textContent = 'Click a ride\'s row in the sheet (or pick one below).'; return; }
    if ($('selRide').contains(document.activeElement) && openForm) return; // don't wipe what they're typing
    const f = r.f, st = stateOf(r), open = st === 'open';
    $('selRide').innerHTML = `
      <div class="who"><h2>${esc(who(f))}</h2><span class="muted small">${esc(ampm(f.ts.slice(11, 16)))} · row ${r.row}${f.phone ? ' · ' + esc(f.phone) : ''}</span></div>
      <div class="route">${esc(f.pu || '?')} <span class="muted">→</span> ${esc(f.do || '?')}</div>
      <div class="chips">${chips(r).map(([c, t]) => `<span class="chip ${c}">${esc(t)}</span>`).join('')}</div>
      <div class="acts">
        <button class="btn primary" data-a="called" ${open ? '' : 'disabled'}>📞 ${f.call ? 'Called again (now)' : 'Mark called'}</button>
        <button class="btn" data-a="edit" ${open ? '' : 'disabled'}>✎ Pick-up / drop-off</button>
        <button class="btn danger" data-a="cancel" ${open ? '' : 'disabled'}>✖ Cancel ride…</button>
        <button class="btn" data-a="dup" ${open ? '' : 'disabled'}>⧉ Duplicate</button>
        ${undoStack.length ? `<button class="btn wide" data-a="undo">↶ Undo: ${esc(undoStack[undoStack.length - 1].label.toLowerCase())}</button>` : ''}
      </div>
      ${openForm === 'cancel' && open ? `<div class="form">
        <label>Reason for cancellation<select id="fReason"><option value="">— pick a reason —</option>${CANCEL_REASONS.map(x => `<option>${esc(x)}</option>`).join('')}</select></label>
        <div class="row2"><button class="btn primary" data-a="cancelGo">Cancel ride</button><button class="btn" data-a="close">Back</button></div></div>` : ''}
      ${openForm === 'edit' && open ? `<div class="form">
        <label>Pick-up<input id="fPu" value="${esc(f.pu)}"></label>
        <label>Drop-off<input id="fDo" value="${esc(f.do)}"></label>
        <div class="row2"><button class="btn primary" data-a="editGo">Save</button><button class="btn" data-a="close">Back</button></div></div>` : ''}`;
  }
  function renderList() {
    if (!X) return;
    const q = $('q').value.trim().toLowerCase();
    let rides = X.tonight.slice().reverse();
    if (filter === 'open') rides = rides.filter(r => stateOf(r) === 'open');
    if (q) rides = rides.filter(r => [r.f.first, r.f.last, r.f.phone, r.f.pu, r.f.do].join(' ').toLowerCase().includes(q));
    $('list').innerHTML = rides.slice(0, 150).map(r => {
      const st = stateOf(r), c = chips(r)[0] || ['', ''];
      return `<div class="ride ${r.id === sel ? 'sel' : ''} ${st !== 'open' ? 'done' : ''}" data-id="${esc(r.id)}">
        <span class="t">${esc(ampm(r.f.ts.slice(11, 16)))}</span>
        <span style="min-width:0"><div class="n">${esc(who(r.f))}</div><div class="r">${esc(r.f.pu)} → ${esc(r.f.do)}</div></span>
        <span class="chip ${c[0]}">${esc(c[1].replace(/:.*/, ''))}</span></div>`;
    }).join('') || `<div class="empty muted">${filter === 'open' ? 'No open rides tonight.' : 'No rides tonight yet.'}</div>`;
    $('listNote').textContent = `${X.tonight.length} rides tonight · ${X.tonight.filter(r => stateOf(r) === 'open').length} open · tab "${X.name}"`;
  }
  function render() { renderSync(); renderSel(); renderList(); }

  async function busyBtn(btn, fn) {
    if (btn) btn.classList.add('busy');
    try { await fn(); } catch (e) { toast(e.message || String(e)); feed(e.message || String(e), true); } finally { if (btn) btn.classList.remove('busy'); }
  }
  $('selRide').addEventListener('click', e => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const r = X && X.byId.get(sel), a = b.dataset.a;
    if (a === 'undo') return busyBtn(b, undo);
    if (!r) return;
    if (a === 'called') return busyBtn(b, () => markCalled(r));
    if (a === 'dup') { if (confirm(`Mark ${who(r.f)}'s ride (row ${r.row}) as a duplicate? The row turns red.`)) busyBtn(b, () => markDup(r)); return; }
    if (a === 'cancel' || a === 'edit') { openForm = openForm === a ? '' : a; renderSel(); const el = $(a === 'cancel' ? 'fReason' : 'fPu'); if (el) el.focus(); return; }
    if (a === 'close') { openForm = ''; renderSel(); return; }
    if (a === 'cancelGo') {
      const reason = $('fReason').value;
      if (!reason) return toast('Pick a reason first.');
      openForm = '';
      return busyBtn(b, () => cancelRide(r, reason));
    }
    if (a === 'editGo') {
      const pu = $('fPu').value.trim(), dropoff = $('fDo').value.trim();
      if (!pu || !dropoff) return toast('Pick-up and drop-off can\'t be blank.');
      openForm = '';
      return busyBtn(b, () => editPlaces(r, pu, dropoff));
    }
  });
  $('list').addEventListener('click', e => {
    const el = e.target.closest('.ride');
    if (!el) return;
    choose(el.dataset.id, true);
  });
  function choose(id, selectInSheet) {
    if (sel !== id) openForm = '';
    sel = id; render();
    const r = X && X.byId.get(id);
    if (selectInSheet && r) Excel.run(async ctx => { sheetOf(ctx).getRange(`${letter(X.col.first || 1)}${r.row}`).select(); await ctx.sync(); }).catch(() => {});
  }
  $('q').addEventListener('input', renderList);
  document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
    filter = b.dataset.f; document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b)); renderList();
  }));
  $('toastUndo').addEventListener('click', () => { $('toast').hidden = true; busyBtn(null, undo); });

  // the row you click in the sheet
  async function onSelect(address) {
    const m = /!?\$?[A-Z]+\$?(\d+)/.exec(String(address || '').split('!').pop());
    if (!m) return;
    const row = +m[1];
    if (!X || !X.byRow.has(row)) { try { await refresh(); } catch (e) { return; } }
    const r = X.byRow.get(row);
    if (r && r.id !== sel) choose(r.id, false);
  }
  async function watchSelection() {
    try {
      await Excel.run(async ctx => {
        sheetOf(ctx).onSelectionChanged.add(ev => onSelect(ev.address));
        const cur = ctx.workbook.getSelectedRange(); cur.load('address');
        await ctx.sync();
        onSelect(cur.address);
      });
    } catch (e) { // older Excel: check the selection now and then instead
      setInterval(() => Excel.run(async ctx => { const cur = ctx.workbook.getSelectedRange(); cur.load('address'); await ctx.sync(); onSelect(cur.address); }).catch(() => {}), 1500);
    }
  }

  // settings
  function showSettings(on) {
    $('setCard').hidden = !on;
    if (!on) return;
    $('setName').value = set.name; $('setDispName').checked = !!set.dispName; $('setTab').value = set.tab;
    $('setTok').value = ''; $('setTok').placeholder = set.token ? 'Saved (paste a new one to change it)' : 'X-Access-Token from web.groupme.com';
    $('setGrp').innerHTML = set.groupId ? `<option value="${esc(set.groupId)}">${esc(set.groupName)}</option>` : '<option value="">— load chats first —</option>';
    $('setSync').checked = !!set.sync; $('setMsg').textContent = '';
  }
  const cleanTok = s => String(s || '').trim()
    .replace(/^.*(?:x-access-token|access_token|token|bearer)[:=\s]+/i, '')
    .replace(/^["']|["'];?$/g, '')
    .trim();
  $('setTok').addEventListener('paste', () => setTimeout(() => { $('setTok').value = cleanTok($('setTok').value); }, 0));
  $('setBtn').addEventListener('click', () => showSettings($('setCard').hidden));
  $('setClose').addEventListener('click', () => showSettings(false));
  $('setLoad').addEventListener('click', () => busyBtn($('setLoad'), async () => {
    const tok = cleanTok($('setTok').value) || set.token;
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(tok)) throw new Error("That doesn't look like a GroupMe token.");
    const gs = (await gm('/groups', { per_page: 100, omit: 'memberships' }, null, tok)) || [];
    $('setGrp').innerHTML = '<option value="">— pick the sync chat —</option>' + gs.map(g => `<option value="${esc(g.id)}" ${g.id === set.groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('');
    $('setMsg').textContent = `Token works — ${gs.length} chats. Pick the sync chat (the same one the texting computer uses).`;
  }));
  $('setSave').addEventListener('click', () => busyBtn($('setSave'), async () => {
    const tok = cleanTok($('setTok').value) || set.token, g = $('setGrp');
    const next = Object.assign({}, set, { name: $('setName').value.trim(), dispName: $('setDispName').checked, tab: $('setTab').value.trim(),
      token: tok, groupId: g.value, groupName: g.value ? g.options[g.selectedIndex].text : '', sync: $('setSync').checked });
    if (next.sync && (!next.token || !next.groupId)) throw new Error('GroupMe sync needs a token and a chat.');
    if (next.groupId !== set.groupId || next.token !== set.token || !next.sync) Object.assign(sync, { ready: false, lastId: '', seen: new Set(), pending: [], todo: [], err: '' }), (S.rides = {});
    set = next; ls.set('settings', set);
    showSettings(false);
    toast('Saved');
    await tick();
  }));

  window.SWT = { tick, refresh, get X() { return X; }, get S() { return S; }, sync, undoStack, choose }; // console / tests
  Office.onReady(async () => {
    await tick();
    watchSelection();
    setInterval(tick, TICK_MS);
  });
})();
