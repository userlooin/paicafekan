(function () {
  var section = document.querySelector('.reviews-section');
  if (!section) return;
  var list = section.querySelector('#review-list');
  var summary = section.querySelector('#review-summary');
  var form = section.querySelector('#review-form');
  var note = section.querySelector('#review-note');
  var starButtons = Array.prototype.slice.call(section.querySelectorAll('[data-star]'));
  var starLabel = section.querySelector('.star-label');
  var rating = 0;
  var endpoint = section.getAttribute('data-endpoint') || '';
  var slug = section.getAttribute('data-slug') || '';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function starStr(n) {
    n = Math.max(0, Math.min(5, Number(n) || 0));
    return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
  }
  function fmtDate(iso) {
    try { return new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch (e) { return ''; }
  }
  function setNote(msg, ok) {
    if (!note) return;
    note.textContent = msg || '';
    note.className = 'review-note' + (ok === true ? ' ok' : ok === false ? ' err' : '');
  }
  function paintStars() {
    starButtons.forEach(function (b) {
      var v = Number(b.getAttribute('data-star'));
      b.classList.toggle('on', v <= rating);
      b.setAttribute('aria-pressed', v === rating ? 'true' : 'false');
    });
    if (starLabel) starLabel.textContent = rating ? rating + ' / 5 ดาว' : 'แตะเพื่อให้ดาว';
  }
  function render(data) {
    if (!data || !data.ok) {
      list.innerHTML = '<p class="review-muted">ยังโหลดรีวิวไม่ได้ในขณะนี้</p>';
      return;
    }
    if (!data.count) {
      summary.innerHTML = '';
      list.innerHTML = '<p class="review-muted">ยังไม่มีรีวิว — เป็นคนแรกที่แชร์ประสบการณ์ได้เลย</p>';
      return;
    }
    summary.innerHTML = '<div class="review-score">' + Number(data.average).toFixed(1) + '</div>' +
      '<div><div class="review-stars">' + starStr(Math.round(data.average)) + '</div>' +
      '<div class="review-muted">' + data.count + ' รีวิวจากคนที่ไปมาแล้ว</div></div>';
    list.innerHTML = data.reviews.map(function (r) {
      return '<article class="review-item">' +
        '<div class="review-item-head"><span class="review-name">' + esc(r.name) + '</span>' +
        '<span class="review-date">' + esc(fmtDate(r.date)) + '</span></div>' +
        '<div class="review-stars small">' + starStr(r.rating) + '</div>' +
        '<p class="review-text">' + esc(r.text) + '</p>' +
        '</article>';
    }).join('');
  }
  window.paicafekanReviewCallback = render;
  function load() {
    if (!endpoint) return;
    var s = document.createElement('script');
    s.src = endpoint + (endpoint.indexOf('?') === -1 ? '?' : '&') +
      'review=1&slug=' + encodeURIComponent(slug) +
      '&callback=paicafekanReviewCallback&_=' + Date.now();
    s.onerror = function () { list.innerHTML = '<p class="review-muted">โหลดรีวิวไม่สำเร็จ</p>'; };
    document.head.appendChild(s);
  }
  starButtons.forEach(function (b) {
    b.addEventListener('click', function () {
      rating = Number(b.getAttribute('data-star'));
      paintStars();
    });
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!rating) { setNote('กรุณาเลือกดาวก่อนส่งครับ', false); return; }
    var name = String(form.elements['name'].value || '').trim();
    var text = String(form.elements['comment'].value || '').trim();
    if (name.length < 2) { setNote('กรุณาใส่ชื่ออย่างน้อย 2 ตัวอักษร', false); return; }
    if (text.length < 5) { setNote('กรุณาเขียนข้อความอย่างน้อย 5 ตัวอักษร', false); return; }
    setNote('กำลังส่งรีวิว…');
    form.submit();
  });
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'paicafekan-review') return;
    var res = e.data.result || {};
    setNote(res.message || (res.ok ? 'ขอบคุณครับ' : 'ส่งไม่สำเร็จ กรุณาลองใหม่'), res.ok);
    if (res.ok) {
      form.reset();
      rating = 0;
      paintStars();
      window.setTimeout(load, 900);
    }
  });
  paintStars();
  load();
})();