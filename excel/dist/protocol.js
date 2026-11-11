/*
 * SURE Walk Texts — the GroupMe sync protocol ("sw1"), shared by the Excel panel and the texting server.
 *
 * The sync chat is a log of ride events. Each event is ONE line of a GroupMe message:
 *     <short human summary> ‹sw1›{"e":"ride","id":"200","src":"x1a2b","f":{…}}
 * A message holds as many lines as fit in GroupMe's 1,000 characters. Lines without the marker are ignored, so
 * people can still talk in the chat.
 *
 *   e: 'ride'  a ride as the sheet has it (the Excel panel posts it the first time it sees the ride)
 *      'upd'   some of a ride's fields changed. `was` (texting server only) = what the server believed before, so the
 *              Excel panel only writes a cell that still holds that value (a dispatcher's edit always wins).
 *   src: 's' = the texting server, 'x…' = an Excel panel.
 *   f (fields, all strings): ts (Austin wall clock "YYYY-MM-DD HH:MM:SS"), row (sheet row), first, last, phone,
 *      pu (pick-up), do (drop-off), ada, disp (Dispatcher), call (Call Time H:MM), arr (Arrival H:MM), loc, van, drv,
 *      nav, rsn (cancel reason), bg (the row's fill color, e.g. #000000 cancelled, #ff0000 duplicate).
 *
 * Never put text-message content in here: only what the sheet itself holds.
 */
(function (root) {
  'use strict';
  const TAG = '‹sw1›';
  const MAX = 990; // GroupMe allows 1,000 characters per message
  const FIELDS = ['ts', 'row', 'first', 'last', 'phone', 'pu', 'do', 'ada', 'disp', 'call', 'arr', 'loc', 'van', 'drv', 'nav', 'rsn', 'bg'];
  const LIMIT = 160; // longest value we send for one field

  const clean = v => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').split(TAG).join('').slice(0, LIMIT);
  function pick(f) {
    const o = {};
    FIELDS.forEach(k => { if (f && f[k] !== undefined && f[k] !== null) o[k] = clean(f[k]); });
    return o;
  }

  const hhmm = ts => { const m = /\d{4}-\d{2}-\d{2} (\d{2}):(\d{2})/.exec(ts || ''); if (!m) return ''; const h = +m[1]; return `${(h + 11) % 12 + 1}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`; };
  const who = (f, known) => { const x = Object.assign({}, known || {}, f || {}); return [x.first, x.last ? x.last.charAt(0) + '.' : ''].filter(Boolean).join(' ') || 'row ' + (x.row || '?'); };
  function summary(ev, known) {
    const f = ev.f || {};
    if (ev.e === 'ride') return `🆕 ${hhmm(f.ts)} ${who(f)} · ${f.pu || '?'} → ${f.do || '?'}`;
    const bits = [];
    if ('rsn' in f && f.rsn && f.rsn !== '0') bits.push(`cancelled (${f.rsn})`);
    else if ('bg' in f && /^#ff0000$/i.test(f.bg)) bits.push('duplicate');
    if ('call' in f) bits.push(f.call ? `call ${f.call}` : 'call time cleared');
    if ('pu' in f) bits.push(`pick-up → ${f.pu}`);
    if ('do' in f) bits.push(`drop-off → ${f.do}`);
    if ('ada' in f) bits.push(`ADA ${f.ada || '—'}`);
    if ('drv' in f && f.drv) bits.push(`crew ${f.drv}${f.nav ? '/' + f.nav : ''}`);
    if ('arr' in f && f.arr) bits.push(`arrived ${f.arr}`);
    if (!bits.length) bits.push('updated');
    return `${ev.src === 's' ? '💬' : '✏️'} ${who(f, known)}: ${bits.join(', ')}`;
  }

  /** One line for one event. `known` = the ride's fields so far (for a readable name). */
  function line(ev, known) {
    const out = { e: ev.e, id: String(ev.id), src: String(ev.src || ''), f: pick(ev.f) };
    if (ev.was) out.was = pick(ev.was);
    return clean(summary(out, known)).replace(/[{}]/g, '').slice(0, 90) + ' ' + TAG + JSON.stringify(out);
  }
  /** Lines → GroupMe message texts of at most MAX characters each (in order). */
  function pack(lines) {
    const msgs = [];
    let cur = '';
    lines.forEach(l => {
      if (l.length > MAX) return; // can't happen with LIMIT, but never post a broken line
      if (cur && cur.length + 1 + l.length > MAX) { msgs.push(cur); cur = ''; }
      cur = cur ? cur + '\n' + l : l;
    });
    if (cur) msgs.push(cur);
    return msgs;
  }
  /** A GroupMe message's text → its events (bad lines are skipped). */
  function parse(text) {
    const evs = [];
    String(text || '').split('\n').forEach(l => {
      const i = l.indexOf(TAG);
      if (i < 0) return;
      try {
        const ev = JSON.parse(l.slice(i + TAG.length));
        if (ev && (ev.e === 'ride' || ev.e === 'upd') && ev.id && ev.f && typeof ev.f === 'object') {
          evs.push({ e: ev.e, id: String(ev.id), src: String(ev.src || ''), f: pick(ev.f), was: ev.was ? pick(ev.was) : null });
        }
      } catch (e) { /* not ours / cut off */ }
    });
    return evs;
  }

  /** The rides as the chat describes them: fold events in chat order. state = { rides: { id: { id, f, at, src } } } */
  function fold(state, ev, at) {
    const r = state.rides[ev.id] || (state.rides[ev.id] = { id: ev.id, f: {}, at: 0, src: '' });
    Object.assign(r.f, ev.f);
    r.at = at || Date.now();
    r.src = ev.src;
    return r;
  }

  // A dispatch night runs past midnight and rolls over at 2:30 AM (same as the texting code's nightKey_).
  function nightOf(ts) {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(ts || '');
    if (!m) return '';
    return new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) - 150 * 60e3).toISOString().slice(0, 10);
  }
  /** Austin wall clock ("YYYY-MM-DD HH:MM:SS") for a moment (default now). */
  function austin(ms) {
    const p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms == null ? Date.now() : ms)).forEach(z => { p[z.type] = z.value; });
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  }
  /** Same value for the sheet? (times "09:05" = "9:05", colors ignore case, blank color = white, reason "0" = blank) */
  function same(k, a, b) {
    const n = v => {
      let s = String(v == null ? '' : v).trim();
      if (k === 'bg') s = s.toLowerCase() || '#ffffff';
      if (k === 'call' || k === 'arr') s = s.replace(/^0(\d:)/, '$1');
      if (k === 'rsn' && s === '0') s = '';
      return s;
    };
    return n(a) === n(b);
  }

  const api = { TAG, MAX, FIELDS, line, pack, parse, fold, nightOf, austin, same, summary };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SWP = api;
})(typeof self !== 'undefined' ? self : this);
