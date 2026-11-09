/* นับยอดวิวบทความ (1 ครั้งต่อ session) + แสดงยอดวิวในหน้าโพสต์ */
(function () {
  "use strict";

  var m = location.pathname.match(/^\/posts\/([a-z0-9-]+)\//);
  if (!m) return;
  var slug = m[1];

  var meta = document.querySelector(".article-meta");
  var badge = null;
  if (meta) {
    badge = document.createElement("span");
    badge.className = "view-badge";
    badge.setAttribute("aria-live", "polite");
    badge.textContent = "👁 –";
    meta.appendChild(badge);
  }

  var key = "pv:" + slug;
  var seen = false;
  try { seen = sessionStorage.getItem(key) === "1"; } catch (e) {}

  var req = seen
    ? fetch("/api/views?slug=" + encodeURIComponent(slug), { cache: "no-store" })
    : fetch("/api/views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: slug }),
        keepalive: true
      });

  req.then(function (r) { return r.json(); }).then(function (d) {
    if (!d || d.disabled || typeof d.views !== "number") {
      if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
      return;
    }
    if (!seen) { try { sessionStorage.setItem(key, "1"); } catch (e) {} }
    if (badge) {
      var n;
      try { n = d.views.toLocaleString("th-TH"); } catch (e) { n = String(d.views); }
      badge.textContent = "👁 " + n;
    }
  }).catch(function () {
    if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
  });
})();
