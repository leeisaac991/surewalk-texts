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
        : 'GroupMe · ' + s.rides + ' rides' + (s.waiting ? ' · ' + s.waiting + ' to send' : '');
      b.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:' + dot + '"></span>';
      b.appendChild(document.createTextNode(txt));
      b.title = 'Sync chat: ' + (s.group || 'not set') + '\nLast from Excel: ' + ago(s.lastExcelAt) + '\nChecked: ' + ago(s.lastPollAt) + '\nClick for GroupMe sync settings';
    }).catch(function () { b.textContent = 'Texting server offline'; });
  }
  document.addEventListener('DOMContentLoaded', function () { pill(); setInterval(pill, 5000); });
})();
