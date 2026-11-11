// Fake Office.js / Excel over an in-memory sheet (tests only). window.FAKE_SHEET = { rows: [[...text cells]], paint: [[row, color]] }
(() => {
  const W = 32, pad = n => String(n).padStart(2, '0');
  const serial = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 864e5 + 25569;
  function typed(s) {
    let m;
    if (s === '' || s == null) return { v: '', fmt: 'General' };
    if (typeof s === 'number') return { v: s, fmt: 'General' };
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})$/.exec(s))) return { v: serial(+m[3], +m[1], +m[2], +m[4], +m[5]), fmt: 'm/d/yyyy h:mm' };
    if ((m = /^(\d{1,2}):(\d{2})$/.exec(s))) return { v: (+m[1] * 60 + +m[2]) / 1440, fmt: 'h:mm' };
    if (/^\d{1,9}$/.test(s)) return { v: Number(s), fmt: 'General' };
    return { v: s, fmt: 'General' };
  }
  function text(c) {
    if (typeof c.v === 'number' && c.fmt !== 'General') {
      const d = new Date(Math.round((c.v - 25569) * 864e5)), time = `${d.getUTCHours()}:${pad(d.getUTCMinutes())}`;
      return c.fmt === 'h:mm' ? time : `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${time}`;
    }
    return c.v === '' || c.v == null ? '' : String(c.v);
  }
  const newCell = s => Object.assign(typed(s), { bg: '#FFFFFF', fc: '#000000' });
  const grid = [];
  const cell = (r, c) => { while (grid.length <= r) { const l = []; for (let j = 0; j < W; j++) l.push(newCell('')); grid.push(l); } return grid[r][c]; };
  (window.FAKE_SHEET.rows || []).forEach((row, i) => row.forEach((s, j) => Object.assign(cell(i, j), typed(s))));
  (window.FAKE_SHEET.paint || []).forEach(([r, color, font]) => { for (let j = 0; j < W; j++) { cell(r - 1, j).bg = color; if (font) cell(r - 1, j).fc = font; } });
  const writes = [];
  const colN = s => s.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  let selected = 'A1';
  const selHandlers = [];
  class Rng {
    constructor(r, c, h, w) { this.r = r; this.c = c; this.h = h; this.w = w; const self = this;
      this.format = {
        fill: { set color(v) { self.each(x => { x.bg = v.toUpperCase(); }); writes.push(`${self.r + 1}:${self.c + 1} fill ${v}`); }, clear() { self.each(x => { x.bg = '#FFFFFF'; }); } },
        font: { set color(v) { self.each(x => { x.fc = v.toUpperCase(); }); } },
      }; }
    each(fn) { for (let i = 0; i < this.h; i++) for (let j = 0; j < this.w; j++) fn(cell(this.r + i, this.c + j), i, j); }
    grid(fn) { const o = []; for (let i = 0; i < this.h; i++) { const l = []; for (let j = 0; j < this.w; j++) l.push(fn(cell(this.r + i, this.c + j))); o.push(l); } return o; }
    load() { return this; }
    get values() { return this.grid(x => x.v); }
    set values(g) { this.each((x, i, j) => { const t = typeof g[i][j] === 'string' ? typed(g[i][j]) : { v: g[i][j], fmt: x.fmt }; x.v = t.v; if (typeof g[i][j] === 'string') x.fmt = t.fmt; }); writes.push(`${this.r + 1}:${this.c + 1}=${JSON.stringify(g)}`); }
    get text() { return this.grid(text); }
    set numberFormat(g) { this.each((x, i, j) => { x.fmt = g[i][j]; }); }
    get numberFormat() { return this.grid(x => x.fmt); }
    clear() { this.each(x => { x.v = ''; x.fmt = 'General'; }); writes.push(`${this.r + 1}:${this.c + 1} cleared`); }
    select() { selected = `R${this.r + 1}`; }
    getCellProperties() { return { value: this.grid(x => ({ format: { fill: { color: x.bg }, font: { color: x.fc } } })) }; }
  }
  const lastRow = () => { for (let r = grid.length; r > 0; r--) if (grid[r - 1].some(x => x.v !== '')) return r; return 0; };
  const ws = { name: 'Form1', load() {},
    getRangeByIndexes: (r, c, h, w) => new Rng(r, c, h, w),
    getRange(a) {
      let m = /^(\d+):(\d+)$/.exec(a);
      if (m) return new Rng(+m[1] - 1, 0, m[2] - m[1] + 1, W);
      m = /^([A-Z]+)(\d+)$/.exec(a);
      return new Rng(+m[2] - 1, colN(m[1]) - 1, 1, 1);
    },
    getUsedRangeOrNullObject() { return { isNullObject: false, rowIndex: 0, rowCount: lastRow(), load() {} }; },
    onSelectionChanged: { add(h) { selHandlers.push(h); } } };
  const workbook = { name: 'Rides.xlsx', load() {}, worksheets: { getFirst: () => ws, getItem: () => ws },
    getSelectedRange: () => ({ address: 'Form1!' + selected.replace(/^R(\d+)$/, 'A$1'), load() {} }) };
  window.Excel = { run: async fn => fn({ workbook, sync: async () => {} }), ClearApplyTo: { contents: 'Contents' } };
  window.Office = { onReady: cb => setTimeout(() => cb({ host: 'Excel' }), 0) };
  const col = c => colN(c) - 1;
  window.__xl = { writes, text: (r, c) => text(cell(r - 1, col(c))), bg: (r, c) => cell(r - 1, col(c)).bg, fc: (r, c) => cell(r - 1, col(c)).fc,
    type(r, c, s) { Object.assign(cell(r - 1, col(c)), typed(s)); }, row(r, vals) { vals.forEach((s, j) => Object.assign(cell(r - 1, j), typed(s))); },
    paint(r, color) { for (let j = 0; j < W; j++) cell(r - 1, j).bg = color; },
    click(r) { selected = 'R' + r; selHandlers.forEach(h => h({ address: 'Form1!K' + r })); } };
})();
