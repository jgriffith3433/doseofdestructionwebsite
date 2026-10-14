var toggle = document.querySelector(".menu-toggle");
var menu = document.querySelector("#site-menu");

if (toggle && menu) {
  toggle.addEventListener("click", function () {
    var open = menu.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });
}
