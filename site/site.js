var toggle = document.querySelector(".menu-toggle");
var menu = document.querySelector("#site-menu");

if (toggle && menu) {
  toggle.addEventListener("click", function () {
    var open = menu.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });
}

var form = document.querySelector("#contact-form");
if (form) {
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var data = new FormData(form);
    var body = "Name: " + data.get("name") + "\nEmail: " + data.get("email") + "\n\n" + data.get("message");
    window.location.href = "mailto:jgriffith3433@gmail.com?subject=" + encodeURIComponent("Dose of Destruction") + "&body=" + encodeURIComponent(body);
  });
}
