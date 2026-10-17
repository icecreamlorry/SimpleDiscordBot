// Builds the contact address at load time so it never appears in the page source,
// which keeps it away from simple spam scrapers.
(function () {
  var user = "0zy9rtl5j".split("").reverse().join("");
  var domain = "moc.liamzom".split("").reverse().join("");
  var address = user + "@" + domain;
  document.querySelectorAll(".contact-email").forEach(function (el) {
    var link = document.createElement("a");
    link.href = "mailto:" + address;
    link.textContent = address;
    el.replaceWith(link);
  });
})();
