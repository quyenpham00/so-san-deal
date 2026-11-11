// Light mode by default; a visitor's choice of dark mode is remembered in this browser.
// Loaded as a classic script in <head> so the saved theme applies before the page paints.
(function () {
  var KEY = "ssd.theme";
  var root = document.documentElement;
  function saved() {
    try { return localStorage.getItem(KEY) === "dark" ? "dark" : "light"; } catch (e) { return "light"; }
  }
  function apply(theme) {
    root.setAttribute("data-theme", theme);
    var btn = document.getElementById("themeBtn");
    if (btn) {
      var dark = theme === "dark";
      btn.setAttribute("aria-pressed", String(dark));
      btn.setAttribute("aria-label", dark ? "Chuyển sang chế độ sáng" : "Chuyển sang chế độ tối");
      btn.title = btn.getAttribute("aria-label");
    }
  }
  apply(saved());
  document.addEventListener("DOMContentLoaded", function () { apply(saved()); });
  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("#themeBtn");
    if (!btn) return;
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    try { localStorage.setItem(KEY, next); } catch (err) {}
    apply(next);
  });
})();
