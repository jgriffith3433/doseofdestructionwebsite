// Hawkes release notes on a product site: the version label and the "What's new" list, from the site's releases.json
// (written by Hawkes Studio at every go live: hawkesstudio/src/releases.ts). A copy of
// hawkesstudio/clients/web/hawkes-release.js; change it there and copy it again.
//
//   <script src="js/hawkes-release.js" data-releases="releases.json" defer></script>
//
//   [data-hawkes-version]   gets the current version: "v1.4.0" (with " · beta" on the beta site and locally);
//                           its title says the build and date. data-prefix replaces the "v" (e.g. "Version ").
//   [data-hawkes-releases]  gets every release, newest first: <section class="hawkes-release"> with an <h3> (version,
//                           title, date) and a <ul> of notes. data-limit shows only the newest n.
//   window.hawkesRelease    a promise of the releases file (or null), for games that show the version in their own menu.
//
// data-releases is relative to the page (a page in Game/ uses "../releases.json"). No dependencies; text only.
(function () {
  var script = document.currentScript;
  var src = (script && script.getAttribute('data-releases')) || 'releases.json';
  var host = location.hostname;
  var beta = /\.hawkesgen\.ai$/.test(host) || host === 'localhost' || host === '127.0.0.1' || location.protocol === 'file:';

  function date(d) {
    var t = Date.parse(d + 'T12:00:00Z');
    return isNaN(t) ? d || '' : new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function fill(data) {
    var top = data && data.releases && data.releases[0];
    var nodes = document.querySelectorAll('[data-hawkes-version]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!top) { n.hidden = true; continue; }
      var prefix = n.getAttribute('data-prefix');
      n.textContent = (prefix == null ? 'v' : prefix) + top.version + (beta ? ' · beta' : '');
      n.title = [top.build ? 'build ' + top.build : '', date(top.date)].filter(Boolean).join(' · ');
      n.hidden = false;
    }
    var lists = document.querySelectorAll('[data-hawkes-releases]');
    for (var j = 0; j < lists.length; j++) {
      var box = lists[j];
      var limit = parseInt(box.getAttribute('data-limit') || '0', 10);
      var rel = (data && data.releases) || [];
      if (limit > 0) rel = rel.slice(0, limit);
      box.textContent = '';
      if (!rel.length) { box.appendChild(el('p', 'hawkes-release-empty', 'Nothing here yet.')); continue; }
      for (var k = 0; k < rel.length; k++) {
        var r = rel[k];
        var sec = el('section', 'hawkes-release');
        var h = el('h3');
        h.appendChild(el('span', 'hawkes-release-version', 'v' + r.version));
        if (r.title) h.appendChild(el('span', 'hawkes-release-title', r.title));
        var t = el('time', 'hawkes-release-date', date(r.date));
        t.setAttribute('datetime', r.date || '');
        h.appendChild(t);
        sec.appendChild(h);
        var ul = el('ul');
        for (var m = 0; m < (r.notes || []).length; m++) ul.appendChild(el('li', null, r.notes[m]));
        sec.appendChild(ul);
        box.appendChild(sec);
      }
    }
  }

  window.hawkesRelease = fetch(src, { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; });
  function go() { window.hawkesRelease.then(fill); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
  else go();
})();
