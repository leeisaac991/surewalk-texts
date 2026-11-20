/* Injected at the top of the dashboard page: google.script.run -> this computer's texting server, plus a
   "GroupMe sync" pill in the top bar (opens /setup). */
(function () {
  'use strict';
  var TOKEN = '__TOKEN__';
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SW-Token': TOKEN }, body: JSON.stringify(body || {}) })
      .then(function (r) { if (r.status === 403) throw new Error('The texting server restarted — reload this page.'); return r.json(); });
  }
  function runner(ok, fail) {
    return new Proxy({}, { get: function (_, name) {
      if (name === 'withSuccessHandler') return function (h) { return runner(h, fail); };
      if (name === 'withFailureHandler') return function (h) { return runner(ok, h); };
      if (name === 'withUserObject') return function () { return runner(ok, fail); };
      if (typeof name !== 'string' || name === 'then') return undefined;
      return function () {
        var args = Array.prototype.slice.call(arguments);
        post('/rpc', { fn: name, args: args }).then(function (r) {
          if (r.ok) { if (ok) ok(r.result); } else if (fail) fail(new Error(r.error || 'Error'));
        }, function (e) { if (fail) fail(new Error(e && e.message ? e.message : "Can't reach the texting server — is it running?")); });
      };
    } });
  }
  window.google = { script: { run: runner(null, null), host: { close: function () {}, setHeight: function () {}, setWidth: function () {} },
    url: { getLocation: function (cb) { cb({ hash: '', parameter: {}, parameters: {} }); } } } };
  window.SW_POST = post;

  // the GroupMe sync pill
  function ago(ms) { if (!ms) return 'never'; var s = Math.round((Date.now() - ms) / 1000); return s < 60 ? s + ' s ago' : Math.round(s / 60) + ' min ago'; }
  function pill() {
    var top = document.querySelector('.top'), b = document.getElementById('swGm');
    if (!top) return;
    if (!b) {
      b = document.createElement('a');
      b.id = 'swGm'; b.className = 'pill'; b.href = '/setup'; b.target = '_blank';
      b.style.cssText = 'text-decoration:none;display:inline-flex;align-items:center;gap:6px;cursor:pointer';
      var phone = document.getElementById('phonePill');
      if (phone && phone.parentNode === top) top.insertBefore(b, phone.nextSibling); else top.appendChild(b);
    }
    post('/api/status').then(function (s) {
      var dot = !s.configured ? '#9e9e9e' : s.lastError ? '#d32f2f' : !s.ready ? '#f57c00' : '#2e7d32';
      var lbl = s.mode === 'local' ? 'Sync' : 'GroupMe';
      var txt = !s.configured ? 'Sync: set up' : s.lastError ? lbl + ': ' + s.lastError : !s.ready ? lbl + ': reading…'
        : (s.mode === 'local' ? 'Sync: Excel' : 'GroupMe');
      b.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:' + dot + '"></span>';
      b.appendChild(document.createTextNode(txt));
      b.title = (s.mode === 'local' ? 'Syncing with the Excel panel on this laptop (no GroupMe)' : 'GroupMe sync chat: ' + (s.group || 'not set')) + '\n' + s.rides + ' rides tonight' + (s.waiting ? ' · ' + s.waiting + ' to post' : '') + '\nLast from Excel: ' + ago(s.lastExcelAt) + '\nChecked: ' + ago(s.lastPollAt) + '\nClick for sync settings (laptop key)';
    }).catch(function () { b.textContent = 'Texting server offline'; });
  }

  // ＋ Ride: add a ride by hand. This computer can't write the Excel sheet, so the server asks the Excel panel (GroupMe
  // sync on) to add the row; then it comes back like any ride (and is texted, unless "already talked to them").
  var addsSeen = {}, draft = {};
  function say(text, kind) { if (typeof window.toast === 'function') window.toast(text, kind); else alert(text); }
  function addButton() {
    var top = document.querySelector('.top');
    if (!top || document.getElementById('swAdd')) return;
    var b = document.createElement('button');
    b.id = 'swAdd'; b.className = 'pill'; b.type = 'button'; b.textContent = '＋ Ride';
    b.title = 'Add a ride by hand (a rider who called in). The Excel panel with sync on writes it into the sheet.';
    b.style.cssText = 'cursor:pointer;border:0;font:inherit';
    b.onclick = addRide;
    var gmPill = document.getElementById('swGm');
    if (gmPill && gmPill.parentNode === top) top.insertBefore(b, gmPill); else top.appendChild(b);
  }
  function field(id, label, extra) {
    return '<label style="display:grid;gap:3px;margin-top:8px;font-size:12px;color:var(--muted)">' + label +
      '<input id="' + id + '" autocomplete="off" style="width:100%"' + (extra || '') + '></label>';
  }
  var FIELDS = ['swaFirst', 'swaLast', 'swaPhone', 'swaEid', 'swaEmail', 'swaPu', 'swaDo', 'swaNotes'];
  function val(i) { var el = document.getElementById(i); return el ? el.value.trim() : ''; }
  // Phone lookup (＋ Ride): a 10-digit phone (any format) finds the number's past rides. "Is this…?" lists every name
  // it used (newest first); picking one fills name, EID, email and ADA, tagged "from past ride". Recent trips fill
  // Pick-up / Drop-off only when clicked. "Someone else" undoes the fill. Read only: nothing is written or logged.
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function phone10(v) { var d = String(v || '').replace(/\D/g, ''); if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1); return d.length === 10 ? d : ''; }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function shortDate(d) { var m = /^(\d{4})-(\d\d)-(\d\d)/.exec(d || ''); return m ? MON[+m[2] - 1] + ' ' + (+m[3]) : d || ''; }
  function lookupStyle() {
    if (document.getElementById('swaStyle')) return;
    var st = document.createElement('style'); st.id = 'swaStyle';
    st.textContent = '.swa-card{margin-top:8px;padding:10px 12px;border-radius:12px;background:var(--card);border:1.5px solid var(--sep);font-size:13px}' +
      '.swa-card h4{margin:0 0 6px;font-size:14px}.swa-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px}' +
      '.swa-row .lbl{color:var(--muted);font-size:12px;margin-right:2px}.swa-card button{font-size:13px;padding:4px 11px}' +
      '.swa-card button.on{background:var(--accent);color:#fff}.swa-warn{margin-top:8px;padding:6px 9px;border-radius:8px;background:var(--amber-bg);color:var(--amber);font-size:12.5px;font-weight:600}' +
      '.swa-tag{margin-left:6px;padding:0 7px;border-radius:999px;background:var(--accent-bg);color:var(--accent);font-size:10.5px;font-weight:700;vertical-align:1px}' +
      '.swa-quiet{margin-top:6px;font-size:12.5px;color:var(--muted)}.ask-card:has(#swaPhone){max-height:92vh;overflow-y:auto}';
    document.head.appendChild(st);
  }
  function wireLookup() {
    var ph = document.getElementById('swaPhone'), box = document.getElementById('swaPrior');
    if (!ph || !box) return;
    var timer = null, slow = null, seq = 0, data = null, filled = {};
    var FILL = { first: 'swaFirst', last: 'swaLast', eid: 'swaEid', email: 'swaEmail', ada: 'swaAda' };
    function tag(id, on) {
      var el = document.getElementById(id), lab = el && el.closest('label'); if (!lab) return;
      var t = lab.querySelector('.swa-tag');
      if (on && !t) { t = document.createElement('span'); t.className = 'swa-tag'; t.textContent = 'from past ride'; lab.insertBefore(t, el); }
      if (!on && t) t.remove();
    }
    function set(id, v) { var el = document.getElementById(id); if (!el) return; el.value = v; tag(id, true); filled[id] = v;
      el.addEventListener('input', function () { tag(id, false); }, { once: true }); }
    function clearFill() { Object.keys(filled).forEach(function (id) { var el = document.getElementById(id); if (el && el.value === filled[id]) el.value = id === 'swaAda' ? 'No' : ''; tag(id, false); }); filled = {}; }
    function pickName(i) {
      var n = data.names[i]; clearFill();
      set(FILL.first, n.first); set(FILL.last, n.last);
      if (n.eid || data.eid) set(FILL.eid, n.eid || data.eid);
      if (n.email || data.email) set(FILL.email, n.email || data.email);
      if (data.ada) set(FILL.ada, 'Yes');
      box.querySelectorAll('[data-name]').forEach(function (b) { b.classList.toggle('on', +b.dataset.name === i); });
      var adaNote = document.getElementById('swaAdaNote'); if (adaNote) adaNote.hidden = !data.ada;
    }
    function render() {
      if (!data || !data.rides) { box.innerHTML = '<div class="swa-quiet">No past rides for this number.</div>'; box.hidden = false; return; }
      var warn = [];
      if (data.eids > 1) warn.push('This number has used ' + data.eids + ' different EIDs. Confirm theirs.');
      if (data.optOut) warn.push("Opted out of texts (STOP). They won't get the confirmation text; mark them called.");
      if (data.noShows) warn.push(data.noShows + ' no-show' + (data.noShows > 1 ? 's' : '') + ' in past rides.');
      box.innerHTML = '<div class="swa-card" role="group" aria-label="Past rides for this number"><h4>Rode ' + data.rides + ' time' + (data.rides > 1 ? 's' : '') + ' · last on ' + esc(shortDate(data.lastDate)) + '</h4>' +
        (data.names.length ? '<div class="swa-row"><span class="lbl">Is this…?</span>' + data.names.map(function (n, i) {
          return '<button type="button" data-name="' + i + '" title="Last used ' + esc(shortDate(n.lastDate)) + '">' + esc((n.first + ' ' + n.last).trim()) + ' · ' + n.count + '×</button>'; }).join('') +
          '<button type="button" id="swaElse">Someone else</button></div>' : '') +
        '<div id="swaAdaNote" class="swa-quiet" hidden>Was ADA before, check with them.</div>' +
        (data.routes.length ? '<div class="swa-row"><span class="lbl">Recent trips</span>' + data.routes.map(function (t, i) {
          return '<button type="button" data-trip="' + i + '" title="Fill Pick-up and Drop-off">' + esc(t.pu) + ' → ' + esc(t.do) + ' · ' + t.count + '×</button>'; }).join('') + '</div>' : '') +
        warn.map(function (w) { return '<div class="swa-warn">' + esc(w) + '</div>'; }).join('') + '</div>';
      box.hidden = false;
      box.querySelectorAll('[data-name]').forEach(function (b) { b.onclick = function () { pickName(+b.dataset.name); }; });
      box.querySelectorAll('[data-trip]').forEach(function (b) { b.onclick = function () { var t = data.routes[+b.dataset.trip]; set('swaPu', t.pu); set('swaDo', t.do); }; });
      var other = document.getElementById('swaElse'); if (other) other.onclick = function () { clearFill(); data = null; box.hidden = true; box.innerHTML = ''; };
    }
    function run() {
      var p = phone10(ph.value), my = ++seq;
      clearTimeout(slow);
      if (!p) { if (data !== null || !box.hidden) { clearFill(); data = null; box.hidden = true; box.innerHTML = ''; } return; }
      slow = setTimeout(function () { if (my === seq) { box.innerHTML = '<div class="swa-quiet">Looking up past rides…</div>'; box.hidden = false; } }, 200);
      post('/api/lookupRider', { phone: p }).then(function (r) { if (my !== seq) return; clearTimeout(slow); clearFill(); data = r && r.ok ? r : null; render(); },
        function () { if (my === seq) { clearTimeout(slow); box.hidden = true; } });
    }
    ph.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 300); });
    if (phone10(ph.value)) run();
  }
  async function addRide() {
    if (typeof window.ask !== 'function') return say('The dashboard is still loading.', 'warn');
    lookupStyle();
    var html = field('swaPhone', 'Phone', ' type="tel" inputmode="tel" placeholder="(512) 555-0110"') +
      '<div id="swaPrior" hidden aria-live="polite"></div>' +
      field('swaFirst', 'First name') + field('swaLast', 'Last name') +
      field('swaEid', 'UT EID (or N/A)') + field('swaEmail', 'Email (optional)', ' type="email"') + field('swaPu', 'Pick-up') + field('swaDo', 'Drop-off') +
      '<label style="display:grid;gap:3px;margin-top:8px;font-size:12px;color:var(--muted)">ADA assistance<select id="swaAda" style="width:100%"><option>No</option><option>Yes</option></select></label>' +
      field('swaNotes', 'Notes (optional)') +
      '<label style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:13px"><input type="checkbox" id="swaCalled"> Already talked to them — mark called (no confirmation text)</label>';
    var pending = window.ask('Add a ride by hand. The Excel panel with sync on puts it in the sheet within a few seconds.', 'Add ride', html);
    setTimeout(function () {
      FIELDS.forEach(function (i) { var el = document.getElementById(i); if (el && draft[i]) el.value = draft[i]; });
      var f = document.getElementById('swaPhone'); if (f) f.focus();
      wireLookup();
    }, 50);
    if (!(await pending)) return;
    FIELDS.forEach(function (i) { draft[i] = val(i); });
    var body = { first: val('swaFirst'), last: val('swaLast'), phone: val('swaPhone'), eid: val('swaEid'), email: val('swaEmail'), pu: val('swaPu'), do: val('swaDo'),
      ada: val('swaAda'), notes: val('swaNotes'), called: !!(document.getElementById('swaCalled') || {}).checked };
    try {
      var r = await post('/api/addRide', body);
      if (!r.ok && r.dup) {
        await new Promise(function (ok) { setTimeout(ok, 350); }); // let the first sheet close
        if (!(await window.ask(r.dup + ' Add this one anyway?', 'Add anyway'))) return;
        body.force = true; r = await post('/api/addRide', body);
      }
      if (!r.ok) { say((r.error || 'Not added.') + ' Your entries are kept — press ＋ Ride again.', 'warn'); return; }
      draft = {}; addsSeen[r.id] = 'waiting';
      say('Sent ' + body.first + "'s ride to the Excel panel — you'll see it here once it's in the sheet.");
    } catch (e) { say(e.message || String(e), 'warn'); }
  }
  function watchAdds(s) { // say when an asked-for ride made it into the sheet (or didn't)
    (s.adds || []).forEach(function (a) {
      if (!addsSeen[a.id] || addsSeen[a.id] === a.state) return;
      addsSeen[a.id] = a.state;
      if (a.state === 'added') say(a.first + "'s ride is in the sheet (row " + a.row + ').');
      if (a.state === 'lost') say(a.first + "'s ride never made it into the sheet — is the Excel panel open with sync on? Add it in Excel.", 'warn');
    });
  }
  // Running on the old Linux texting computer: Windows is the main program now. A strip at the top says so, and
  // the tab title is marked, so nobody mistakes this for the computer that should be texting.
  var LEGACY = '__LEGACY__';
  function legacy() {
    if (LEGACY !== true || document.getElementById('swLegacy')) return;
    var b = document.createElement('div');
    b.id = 'swLegacy'; b.setAttribute('role', 'status');
    b.style.cssText = 'position:sticky;top:0;z-index:1000;display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap;' +
      'padding:6px 16px;font:600 12.5px/1.35 system-ui,sans-serif;text-align:center;background:repeating-linear-gradient(135deg,#6b6b70 0 12px,#5f5f64 12px 24px);color:#fff';
    b.innerHTML = '<span style="background:#fff;color:#4a4a4f;border-radius:4px;padding:1px 7px;font-weight:800;letter-spacing:.04em">LINUX · DEPRECATED</span>' +
      '<span>This is the old Linux version, kept as a backup. SURE Walk Texts now runs on the <b>Windows laptop</b> (START-TEXTING.cmd) — only one computer may text at a time.</span>';
    document.body.insertBefore(b, document.body.firstChild);
    if (!/^\[Linux/.test(document.title)) document.title = '[Linux – deprecated] ' + document.title;
  }
  // ⬆ A newer SURE Walk Texts on GitHub: an "Update" pill in the top bar and, once per version, a popup. Update now =
  // the laptop installs it and restarts texting by itself (about a minute); this page reloads when it's back.
  window.SW_APP_VERSION = '__APPVER__';
  var updInfo = null, updAsked = {};
  try { updAsked = JSON.parse(sessionStorage.getItem('swUpdAsked') || '{}'); } catch (e) {}
  function updCheck(force) {
    post('/api/update', { force: !!force }).then(function (u) { updInfo = u; updPill(); if (u.newer && !updAsked[u.latest]) updPopup(); }).catch(function () {});
  }
  function updPill() {
    var top = document.querySelector('.top'), b = document.getElementById('swUpd');
    if (!top || !updInfo || !updInfo.newer) { if (b) b.remove(); return; }
    if (!b) {
      b = document.createElement('button');
      b.id = 'swUpd'; b.type = 'button'; b.className = 'pill';
      b.style.cssText = 'background:var(--accent);color:#fff;font-weight:700';
      b.onclick = updPopup;
      var gm = document.getElementById('swGm');
      if (gm && gm.parentNode === top) top.insertBefore(b, gm.nextSibling); else top.appendChild(b);
    }
    b.textContent = '⬆ Update';
    b.title = 'SURE Walk Texts ' + updInfo.latest + ' is out (you have ' + updInfo.current + '). Click to install it.';
  }
  function updEl(tag, css, text) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; }
  function updPopup() {
    if (!updInfo || !updInfo.newer || document.getElementById('swUpdSheet')) return;
    updAsked[updInfo.latest] = 1; try { sessionStorage.setItem('swUpdAsked', JSON.stringify(updAsked)); } catch (e) {}
    var bg = updEl('div', 'position:fixed;inset:0;z-index:9500;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.45)');
    bg.id = 'swUpdSheet';
    var box = updEl('div', 'width:min(440px,100%);background:var(--card,#fff);color:var(--text,#000);border-radius:14px;padding:18px 20px;box-shadow:0 10px 40px rgba(0,0,0,.35);font:15px/1.4 system-ui,sans-serif');
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    box.appendChild(updEl('div', 'font-size:18px;font-weight:700;margin-bottom:6px', '⬆ A new version is available'));
    box.appendChild(updEl('div', '', 'SURE Walk Texts ' + updInfo.latest + ' (you have ' + updInfo.current + ').'));
    if (updInfo.notes) box.appendChild(updEl('div', 'margin-top:8px;padding:8px 10px;border-radius:9px;background:var(--fill,#eee);font-size:13px;white-space:pre-wrap;max-height:140px;overflow:auto', updInfo.notes));
    box.appendChild(updEl('div', 'margin-top:8px;font-size:13px;color:var(--muted,#888)', 'Texting stops for about a minute while it installs, then starts again by itself (texts waiting to send are kept). This page reloads when it\'s back.'));
    var row = updEl('div', 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px');
    var later = updEl('button', 'border:0;border-radius:9px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer;background:var(--fill,#eee);color:var(--text,#000)', 'Later');
    var go = updEl('button', 'border:0;border-radius:9px;padding:8px 14px;font:inherit;font-weight:700;cursor:pointer;background:var(--accent,#bf5700);color:#fff', 'Update now');
    later.onclick = function () { bg.remove(); };
    go.onclick = function () { go.disabled = later.disabled = true; go.textContent = 'Starting…'; updInstall(box); };
    row.appendChild(later); row.appendChild(go); box.appendChild(row); bg.appendChild(box);
    bg.addEventListener('click', function (e) { if (e.target === bg && !go.disabled) bg.remove(); });
    document.body.appendChild(bg);
  }
  function updInstall(box) {
    post('/api/update', { action: 'install' }).then(function (u) {
      if (!u.ok) { box.appendChild(updEl('div', 'margin-top:10px;color:var(--red,#d32f2f);font-weight:600', u.error || 'The update could not start.')); return; }
      while (box.firstChild) box.removeChild(box.firstChild);
      box.appendChild(updEl('div', 'font-size:18px;font-weight:700;margin-bottom:6px', '⬆ Updating to ' + u.latest + '…'));
      var msg = updEl('div', '', 'Installing. Texting restarts by itself; this page reloads when it\'s back. Don\'t close the laptop.');
      box.appendChild(msg);
      var went = false, t0 = Date.now();
      var iv = setInterval(function () { // wait for the server to go away and come back, then reload
        fetch('/favicon.svg', { cache: 'no-store' }).then(function (r) {
          if (r.ok && (went || Date.now() - t0 > 150e3)) { clearInterval(iv); location.reload(); }
        }, function () { went = true; msg.textContent = 'Installing… texting is restarting (about a minute).'; });
        if (Date.now() - t0 > 300e3) { clearInterval(iv); msg.textContent = 'This is taking long. If texting doesn\'t come back, open "SURE Walk Texts" from the Start menu.'; }
      }, 2000);
    }).catch(function (e) { box.appendChild(updEl('div', 'margin-top:10px;color:var(--red,#d32f2f);font-weight:600', (e && e.message) || 'The update could not start.')); });
  }
  function tick() { legacy(); addButton(); pill(); updPill(); post('/api/status').then(watchAdds).catch(function () {}); }
  document.addEventListener('DOMContentLoaded', function () { tick(); setInterval(tick, 5000); updCheck(); setInterval(function () { updCheck(); }, 15 * 60e3); });
})();
