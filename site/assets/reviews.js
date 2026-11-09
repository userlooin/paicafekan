/* แดชบอร์ดรวมรีวิว: ค้นหา / กรองย่าน / เรียงตามยอดวิว */
(function () {
  "use strict";

  var grid = document.getElementById("reviewGrid");
  if (!grid) return;

  var MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
    "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];

  var elInput = document.getElementById("reviewSearch");
  var elSort = document.getElementById("reviewSort");
  var elChips = document.getElementById("reviewChips");
  var elCount = document.getElementById("reviewCount");
  var elEmpty = document.getElementById("reviewEmpty");

  var posts = [];
  var views = {};
  var state = { q: "", zone: "all", sort: "new" };

  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function num(n) {
    try { return Number(n || 0).toLocaleString("th-TH"); } catch (e) { return String(n || 0); }
  }

  function thaiDate(iso) {
    var m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(iso || "");
    return parseInt(m[3], 10) + " " + MONTHS[parseInt(m[2], 10) - 1] + " " + (parseInt(m[1], 10) + 543);
  }

  function zoneOf(p) { return p.zone || "กรุงเทพฯ"; }
  function viewsOf(p) { return views[p.slug] || 0; }

  function haystack(p) {
    return [p.name, p.title, zoneOf(p), p.excerpt, (p.tags || []).join(" ")]
      .join(" ").toLowerCase();
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var list = posts.filter(function (p) {
      if (state.zone !== "all" && zoneOf(p) !== state.zone) return false;
      if (!q) return true;
      return haystack(p).indexOf(q) !== -1;
    });
    if (state.sort === "popular") {
      list.sort(function (a, b) {
        return (viewsOf(b) - viewsOf(a)) || String(b.date || "").localeCompare(String(a.date || ""));
      });
    } else if (state.sort === "name") {
      list.sort(function (a, b) { return String(a.title || "").localeCompare(String(b.title || ""), "th"); });
    } else {
      list.sort(function (a, b) { return String(b.date || "").localeCompare(String(a.date || "")); });
    }
    return list;
  }

  function cardHtml(p) {
    var href = "/posts/" + esc(p.slug) + "/";
    var img = p.photo
      ? '<img src="/' + esc(p.photo) + '" alt="' + esc(p.name) + '" loading="lazy" width="640" height="440">'
      : '<span class="card-auto"><strong>' + esc(p.name) + '</strong></span>';
    return '<article class="card">' +
      '<a class="card-photo' + (p.photo ? "" : " cover-auto") + '" href="' + href + '">' +
        '<span class="zone">' + esc(zoneOf(p)) + '</span>' + img + '</a>' +
      '<div class="card-body">' +
        '<h3><a href="' + href + '">' + esc(p.title) + '</a></h3>' +
        (p.excerpt ? '<p>' + esc(p.excerpt) + '</p>' : '') +
        '<div class="card-meta"><span>' + esc(thaiDate(p.date)) + '</span>' +
          '<span class="dot"></span><span class="views">👁 ' + num(viewsOf(p)) + '</span></div>' +
      '</div></article>';
  }

  function render() {
    var list = filtered();
    grid.innerHTML = list.map(cardHtml).join("");
    if (elCount) {
      elCount.textContent = "พบ " + list.length + " ร้าน" +
        (state.zone === "all" ? "" : " ในย่าน " + state.zone) +
        (state.q.trim() ? " ที่ตรงกับ “" + state.q.trim() + "”" : "");
    }
    if (elEmpty) elEmpty.hidden = list.length > 0;
  }

  function setZone(z) {
    state.zone = z || "all";
    var items = elChips ? elChips.querySelectorAll(".chip") : [];
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle("active", items[i].getAttribute("data-zone") === state.zone);
    }
    var navItems = document.querySelectorAll("#zoneFilter .zone-item");
    for (var j = 0; j < navItems.length; j++) {
      navItems[j].classList.toggle("active", navItems[j].getAttribute("data-zone") === state.zone);
    }
    render();
  }

  function buildChips() {
    if (!elChips) return;
    var zones = [];
    posts.forEach(function (p) {
      var z = zoneOf(p);
      if (zones.indexOf(z) === -1) zones.push(z);
    });
    zones.sort();
    elChips.innerHTML = '<button type="button" class="chip active" data-zone="all">ทั้งหมด</button>' +
      zones.map(function (z) {
        return '<button type="button" class="chip" data-zone="' + esc(z) + '">' + esc(z) + '</button>';
      }).join("");
    elChips.addEventListener("click", function (e) {
      var b = e.target && e.target.closest ? e.target.closest(".chip") : null;
      if (b) setZone(b.getAttribute("data-zone"));
    });
  }

  function stats() {
    var zoneSet = {};
    var total = 0;
    posts.forEach(function (p) { zoneSet[zoneOf(p)] = 1; total += viewsOf(p); });
    var a = document.getElementById("statPosts");
    var b = document.getElementById("statZones");
    var c = document.getElementById("statViews");
    if (a) a.textContent = num(posts.length);
    if (b) b.textContent = num(Object.keys(zoneSet).length);
    if (c) c.textContent = num(total);
  }

  function wireNav() {
    var zf = document.getElementById("zoneFilter");
    if (!zf) return;
    var btn = zf.querySelector(".zone-filter-btn");
    var items = zf.querySelectorAll(".zone-item");
    if (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var open = zf.classList.toggle("open");
        btn.setAttribute("aria-expanded", open ? "true" : "false");
      });
    }
    for (var i = 0; i < items.length; i++) {
      items[i].addEventListener("click", function (e) {
        e.stopPropagation();
        setZone(this.getAttribute("data-zone"));
        zf.classList.remove("open");
      });
    }
    document.addEventListener("click", function () { zf.classList.remove("open"); });
  }

  if (elInput) elInput.addEventListener("input", function () { state.q = elInput.value; render(); });
  if (elSort) elSort.addEventListener("change", function () { state.sort = elSort.value; render(); });

  var params = new URLSearchParams(location.search);
  var initialZone = params.get("zone") || "all";
  var initialQ = params.get("q") || "";
  if (initialQ) { state.q = initialQ; if (elInput) elInput.value = initialQ; }

  wireNav();

  fetch("/data/posts.json", { cache: "no-cache" })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      posts = Array.isArray(data) ? data : [];
      buildChips();
      stats();
      setZone(initialZone);
      render();
      return fetch("/api/views", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .catch(function () { return null; });
    })
    .then(function (v) {
      if (v && v.counts) { views = v.counts; stats(); render(); }
    })
    .catch(function () {
      if (elCount) elCount.textContent = "โหลดรายการรีวิวไม่สำเร็จ — ลองรีเฟรชอีกครั้ง";
    });
})();
