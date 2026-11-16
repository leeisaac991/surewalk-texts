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
      var txt = !s.configured ? 'GroupMe sync: set up' : s.lastError ? 'GroupMe: ' + s.lastError : !s.ready ? 'GroupMe: reading chat…'
        : 'GroupMe';
      b.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:' + dot + '"></span>';
      b.appendChild(document.createTextNode(txt));
      b.title = 'Sync chat: ' + (s.group || 'not set') + '\n' + s.rides + ' rides tonight' + (s.waiting ? ' · ' + s.waiting + ' to post' : '') + '\nLast from Excel: ' + ago(s.lastExcelAt) + '\nChecked: ' + ago(s.lastPollAt) + '\nClick for GroupMe sync settings';
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
    b.title = 'Add a ride by hand (a rider who called in). The Excel panel with GroupMe sync on writes it into the sheet.';
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
  async function addRide() {
    if (typeof window.ask !== 'function') return say('The dashboard is still loading.', 'warn');
    var html = field('swaFirst', 'First name') + field('swaLast', 'Last name') + field('swaPhone', 'Phone', ' type="tel" inputmode="numeric" placeholder="10 digits"') +
      '<div id="swaPrior" style="display:none;margin-top:8px;padding:8px 10px;background:var(--fill);border-radius:8px;font-size:12px;border:1px solid var(--sep)"></div>' +
      field('swaEid', 'UT EID (or N/A)') + field('swaEmail', 'Email (optional)', ' type="email"') + field('swaPu', 'Pick-up') + field('swaDo', 'Drop-off') +
      '<label style="display:grid;gap:3px;margin-top:8px;font-size:12px;color:var(--muted)">ADA assistance<select id="swaAda" style="width:100%"><option>No</option><option>Yes</option></select></label>' +
      field('swaNotes', 'Notes (optional)') +
      '<label style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:13px"><input type="checkbox" id="swaCalled"> Already talked to them — mark called (no confirmation text)</label>';
    var pending = window.ask('Add a ride by hand. The Excel panel with GroupMe sync on puts it in the sheet within a few seconds.', 'Add ride', html);
    setTimeout(function () {
      FIELDS.forEach(function (i) { var el = document.getElementById(i); if (el && draft[i]) el.value = draft[i]; });
      var f = document.getElementById('swaFirst'); if (f) f.focus();
      var phInput = document.getElementById('swaPhone');
      if (phInput) {
        phInput.addEventListener('input', async function () {
          var box = document.getElementById('swaPrior');
          if (!box) return;
          var phone = phInput.value.replace(/\D/g, '');
          if (phone.length === 11 && phone.charAt(0) === '1') phone = phone.slice(1);
          if (phone.length !== 10) { box.style.display = 'none'; box.innerHTML = ''; return; }
          try {
            var res = await post('/api/lookupRider', { phone: phone });
            if (!res.ok || !res.candidates || !res.candidates.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
            box.style.display = 'block';
            var cands = res.candidates;
            function fill(c) {
              if (c.first) { var el = document.getElementById('swaFirst'); if (el) el.value = c.first; }
              if (c.last) { var el = document.getElementById('swaLast'); if (el) el.value = c.last; }
              if (c.eid) { var el = document.getElementById('swaEid'); if (el) el.value = c.eid; }
              if (c.email) { var el = document.getElementById('swaEmail'); if (el) el.value = c.email; }
              if (c.pu) { var el = document.getElementById('swaPu'); if (el && !el.value.trim()) el.value = c.pu; }
              if (c.do) { var el = document.getElementById('swaDo'); if (el && !el.value.trim()) el.value = c.do; }
              if (c.ada) { var el = document.getElementById('swaAda'); if (el) el.value = /yes/i.test(c.ada) ? 'Yes' : 'No'; }
              var st = document.getElementById('swaPriorStatus');
              if (st) st.textContent = '✓ Filled for ' + c.fullName;
            }
            if (cands.length === 1) {
              var c = cands[0];
              box.innerHTML = '<div style="font-weight:600;display:flex;justify-content:space-between"><span>Found prior rider (' + c.count + ' rides):</span><span id="swaPriorStatus" style="color:var(--green)"></span></div>' +
                '<div style="margin:4px 0">Ask: <b>"Are you ' + c.fullName + '?"</b></div>' +
                '<button type="button" class="pill" id="swaFillBtn" style="padding:4px 10px;font-size:12px;cursor:pointer;border:0;background:var(--card)">Prefill ' + (c.first || c.fullName) + '\'s info</button>';
              var btn = document.getElementById('swaFillBtn');
              if (btn) btn.onclick = function () { fill(c); };
            } else {
              box.innerHTML = '<div style="font-weight:600;display:flex;justify-content:space-between"><span>Multiple past names. Ask: "Are you…":</span><span id="swaPriorStatus" style="color:var(--green)"></span></div>' +
                '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">' +
                cands.map(function (c, idx) { return '<button type="button" class="pill swa-chip" data-idx="' + idx + '" style="padding:4px 10px;font-size:12px;cursor:pointer;border:0;background:var(--card)"><b>' + c.fullName + '</b> (' + c.count + ')</button>'; }).join('') +
                '</div>';
              box.querySelectorAll('.swa-chip').forEach(function (b) {
                b.onclick = function () { fill(cands[+b.dataset.idx]); };
              });
            }
          } catch (e) {}
        });
      }
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
      if (a.state === 'lost') say(a.first + "'s ride never made it into the sheet — is an Excel panel open with GroupMe sync on? Add it in Excel.", 'warn');
    });
  }
  function tick() { addButton(); pill(); post('/api/status').then(watchAdds).catch(function () {}); }
  document.addEventListener('DOMContentLoaded', function () { tick(); setInterval(tick, 5000); });
})();
