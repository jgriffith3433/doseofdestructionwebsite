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
