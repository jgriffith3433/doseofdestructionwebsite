var toggle = document.querySelector(".menu-toggle");
var menu = document.querySelector("#site-menu");

// Dev tools exist only on the local dev server, so only link to them there.
var host = window.location.hostname;
if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
  document.querySelectorAll("[data-dev-only]").forEach(function (el) {
    el.hidden = false;
  });
}

if (toggle && menu) {
  toggle.addEventListener("click", function () {
    var open = menu.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });
}

// Play hands off to the game with a fade into the brand colour, so nothing flashes between the pages.
(function () {
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href="/Game/"]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    var veil = document.createElement('div');
    veil.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;opacity:0;transition:opacity .25s ease;background:#1c0d06 radial-gradient(ellipse at 50% 45%,#8a3010 0%,#3a1608 45%,#100e0c 80%)');
    document.body.appendChild(veil);
    requestAnimationFrame(function () { veil.style.opacity = '1'; });
    setTimeout(function () { location.href = a.href; }, 260);
  });
})();
