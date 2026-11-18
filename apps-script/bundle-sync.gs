/* ============================================================
   BANGKOK CAFE BOT - ALL IN ONE (paste this single file)
   Sources live in apps-script/ - do not edit ALL-IN-ONE.gs by hand
   ============================================================ */

/* ---------------------- Code.gs ---------------------- */
/**
 * Bangkok Cafe Review — ท่ออัตโนมัติ
 * ชีต -> OpenStreetMap (ข้อมูลร้าน+รูป) -> Gemini -> Google Doc -> LINE (รออนุมัติ) -> GitHub -> Cloudflare Pages
 *
 * ทำงานวันละ 1 รอบ 06:50 (Asia/Bangkok) รวม 3 โพสต์
 * ผู้อนุมัติพิมพ์ "ok" ใน LINE เพื่อโพสต์จริง
 */

var COL = {
  NAME: 1,        // A: Cafe Name
  ZONE: 2,        // B: Zone
  STATUS: 3,      // C: Status
  TITLE: 4,       // D: Article Title
  DOC_URL: 5,     // E: Doc URL
  UPDATED_AT: 6,  // F: Updated At
  NOTE: 7,        // G: Note / Error
  POST_URL: 8,    // H: Post URL (เว็บจริง)
  SLUG: 9,        // I: Slug
  PHOTO_URL: 10,  // J: Photo URL
  PLACE_ID: 11,   // K: Place ID (osm:node/123)
  BATCH: 12,      // L: Batch date (yyyy-MM-dd)
  PHOTO_IN: 13    // M: รูปที่ใส่เอง (URL) — ถ้าไม่ใส่ ระบบสร้างปกอัตโนมัติ
};

var HEADERS = ['Cafe Name', 'Zone', 'Status', 'Article Title', 'Doc URL', 'Updated At', 'Note', 'Post URL', 'Slug', 'Photo URL', 'Place ID', 'Batch', 'Photo (ใส่เอง)'];

var STATUS = {
  READY: 'ready',
  PROCESSING: 'processing',
  PENDING: 'pending',
  SCHEDULED: 'scheduled',
  PUBLISHED: 'published',
  REJECTED: 'rejected',
  ERROR: 'error'
};

var DEFAULTS = {
  MODEL: 'gemini-3.8-flash',
  BATCH_SIZE: 3,
  SHEET_NAME: 'ชีต1',
  LOG_SHEET: 'Log',
  DOC_TITLE_PREFIX: '[Draft] '
};

/** เมนูใน Google Sheets */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('☕ Cafe Bot')
    .addItem('รันเลย 1 ชุด (Run batch)', 'runNow')
    .addItem('ติดตั้งตัวตั้งเวลา (06:50 ทุกวัน)', 'setupTriggers')
    .addItem('ลบตัวตั้งเวลาทั้งหมด', 'removeTriggers')
    .addSeparator()
    .addItem('เตรียมหัวตาราง (Header)', 'setupHeaders')
    .addItem('ตรวจสอบการตั้งค่า', 'checkSetup')
    .addItem('ทดสอบข้อมูลร้าน (OSM)', 'testPlaces')
    .addItem('ทดสอบ Gemini', 'testGemini')
    .addItem('ทดสอบ LINE (ส่งข้อความทดสอบ)', 'testLine')
    .addItem('ทดสอบ GitHub (อ่าน manifest)', 'testGitHub')
    .addSeparator()
    .addItem('หาลิงก์รูปให้ร้านที่ยังไม่มี (ดูผล)', 'showPhotoSuggest')
    .addItem('เติมลิงก์รูปลงคอลัมน์ M', 'fillPhotosMenu')
    .addItem('AI ช่วยเลือกลิงก์รูป (ดูผล)', 'showPhotoSuggestAi')
    .addItem('AI เติมลิงก์รูปลงคอลัมน์ M', 'fillPhotosAiMenu')
    .addItem('สถานะ AI (โควตา/ค่ายสำรอง)', 'showAiStatus')
    .addSeparator()
    .addItem('โพสต์ที่รออนุมัติทั้งหมด (ข้ามการกด ok)', 'publishAllPending')
    .addToUi();
}

/** รันทันที 1 ชุด (ใช้ทดสอบ) — มี lock กันรันซ้อน */
function runNow() {
  return withLock_(function () {
    var results = runDailyBatch_();
    return results;
  });
}

/** ตัวตั้งเวลาเรียกอันนี้ทุกเช้า 06:50 */
function runDailyBatch() {
  return withLock_(function () {
    return runDailyBatch_();
  });
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    log_('WARN', '-', '-', 'มีรอบอื่นกำลังทำงานอยู่ ข้ามรอบนี้');
    return { skipped: true, reason: 'locked' };
  }
  try {
    return fn();
  } catch (err) {
    log_('ERROR', '-', '-', 'ล้มเหลว: ' + (err && err.message ? err.message : err));
    throw err;
  } finally {
    lock.releaseLock();
  }
}

/**
 * เวลาทำงานสูงสุดต่อ 1 execution (Apps Script หมดเวลาที่ 360 วินาที)
 * เผื่อเวลาไว้ส่ง LINE + เขียนชีตช่วงท้าย
 */
var RUN_BUDGET_MS = 240 * 1000;

/**
 * แถว processing ที่ค้างเกินนี้ ถือว่าตายกลางทาง -> กลับไป ready
 * (เราเพิ่งได้ lock มาแล้ว จึงไม่มี execution อื่นทำงานอยู่จริง)
 */
var STALE_PROCESSING_MS = 60 * 1000;

/**
 * ตัวหลักของรอบเช้า: หาแถว ready -> สร้างร่าง -> ส่ง LINE รออนุมัติ
 *
 * ทำเป็น "ก้อน" (chunk): สร้างร้านละ ~4-5 นาที จึงสร้างได้ ~1 ร้านต่อ 1 execution
 * ถ้ายังมีร้าน ready เหลือ -> ตั้งทริกเกอร์ทำต่อใน 1 นาที (ไม่ต้องรอถึงพรุ่งนี้)
 * ส่งการ์ด LINE ครั้งเดียวตอนที่ไม่มีร้าน ready เหลือแล้วเท่านั้น
 */
function runDailyBatch_() {
  var cfg = getConfig_();
  var sheet = getSheet_(cfg.sheetName);
  var started = Date.now();

  var recovered = recoverStaleProcessing_(sheet);
  if (recovered) log_('WARN', '-', '-', 'รีเซ็ตแถวที่ค้างสถานะ processing: ' + recovered + ' แถว');

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { sent: 0, items: [] };

  var dateKey = Utilities.formatDate(new Date(), cfg.timezone, 'yyyy-MM-dd');
  var pendingToday = countPendingToday_(sheet, dateKey, lastRow);
  var slots = Math.max(0, cfg.batchSize - pendingToday);
  var built = [];
  var usedPlaceIds = [];

  if (slots > 0) {
    var rows = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
    var consecutiveModelErrs = 0;

    for (var i = 0; i < rows.length && built.length < slots; i++) {
      var row = rows[i];
      var status = String(row[COL.STATUS - 1] || '').trim().toLowerCase();
      if (status !== STATUS.READY) continue;

      // หมดเวลาแล้วแต่ยังมีร้านเหลือ -> ตั้งรอบถัดไปแล้วจบรอบนี้
      if (Date.now() - started > RUN_BUDGET_MS) {
        scheduleContinuation_();
        log_('INFO', '-', '-', 'ครบเวลา — เหลืออีกราว ' + (slots - built.length) + ' ร้าน จะทำต่อใน 1 นาที');
        return {
          partial: true,
          built: built.length,
          remaining: slots - built.length,
          items: briefItems_(built)
        };
      }

      var sheetRow = i + 2;
      var name = String(row[COL.NAME - 1] || '').trim();
      var zone = String(row[COL.ZONE - 1] || '').trim();
      if (!name && !zone) {
        setStatus_(sheet, sheetRow, STATUS.ERROR, 'ต้องใส่ชื่อร้านหรือโซนอย่างน้อย 1 อย่าง');
        continue;
      }

      try {
        var item = buildDraftForRow_(cfg, sheet, sheetRow, name, zone, usedPlaceIds, dateKey);
        consecutiveModelErrs = 0;
        usedPlaceIds.push(item.placeId);
        built.push(item);
      } catch (err) {
        var msg = String(err && err.message ? err.message : err).slice(0, 400);
        // ปัญหาชั่วคราว (Nominatim/Gemini 429/503/timeout) -> คืนเป็น ready ไม่ล็อคเป็น error
        var transient = /Nominatim error (429|428|408|5\d\d)|Gemini HTTP (429|5\d\d)|time out|timeout|temporarily|rate limit/i.test(msg);
        if (transient) {
          setStatus_(sheet, sheetRow, STATUS.READY, 'รอระบบพร้อม (วันนี้ไม่พร้อม) — ' + msg.slice(0, 120));
          log_('WARN', name, sheetRow, 'เลื่อนแบทช์ (ชั่วคราว): ' + msg.slice(0, 200));
          continue;
        }
        setStatus_(sheet, sheetRow, STATUS.ERROR, msg);
        log_('ERROR', name, sheetRow, msg);
        // Gemini/Nominatim ล่ม/โควตาหมด ติดกัน 2 ร้าน -> หยุดแบทช์นี้เลย (ไม่ตั้ง continuation)
        if (/HTTP\s*(429|5\d\d)|overloaded|high demand|quota|timeout|time out|exhausted|UNAVAILABLE/i.test(msg)) {
          consecutiveModelErrs++;
          if (consecutiveModelErrs >= 2) {
            log_('WARN', '-', '-', 'Gemini ล่ม/โหลดหนัก 2 ร้านติดกัน — หยุดแบทช์รอบนี้ (แถว ready เหลือไว้รอบหน้า)');
            try {
              Line.push_([Line.text('⚠️ Gemini โหลดหนัก/ล่ม 2 ร้านติดกัน\nหยุดแบทช์รอบนี้ไว้ก่อน (แถว ready ที่เหลือจะไม่ถูกสร้าง)\nลองใหม่พรุ่งนี้เช้า — ถ้าอยากให้ลองตอนนี้ พิมพ์ "รันใหม่" มาได้')]);
            } catch (e) {}
            return { aborted: true, reason: 'model-outage', items: briefItems_(built) };
          }
        } else {
          consecutiveModelErrs = 0;
        }
        try {
          Line.push_([Line.text('⚠️ สร้างร่างไม่สำเร็จ แถว ' + sheetRow + ' (' + (name || '-') + '):\n' + msg)]);
        } catch (e) {}
      }
    }
  }

  return finishBatch_(cfg, sheet, dateKey, started, built);
}

function briefItems_(items) {
  return items.map(function (it) { return { row: it.row, name: it.name, slug: it.slug }; });
}

/** ส่งการ์ด LINE เมื่อไม่มีร้าน ready เหลือแล้ว และยังไม่เคยส่งของรอบนี้ */
function finishBatch_(cfg, sheet, dateKey, started, built) {
  var lastRow = sheet.getLastRow();

  // ยังมีร้าน ready ที่ยังสร้างได้ (ไม่เกินโควตาวันนี้) -> ทำต่อก่อน ยังไม่ส่ง LINE
  var pendingToday = countPendingToday_(sheet, dateKey, lastRow);
  if (cfg.batchSize - pendingToday > 0 && hasReadyRows_(sheet, lastRow)) {
    scheduleContinuation_();
    log_('INFO', '-', '-', 'ยังมีร้าน ready เหลือ — ทำต่อใน 1 นาที (ยังไม่ส่ง LINE)');
    return { deferred: true, waiting: true, items: briefItems_(built) };
  }

  syncPendingIndex_(cfg, sheet);
  var items = Approve.pendingItems_(cfg);

  if (!items.length) {
    log_('INFO', '-', '-', 'ไม่มีแถว ready — ไม่ส่ง LINE');
    return { sent: 0, items: briefItems_(built) };
  }

  var props = PropertiesService.getScriptProperties();
  var sig = items.map(function (it) { return it.row; }).join(',') + '@' + dateKey;
  var prevSig = props.getProperty('PUSHED_SIG');
  // ส่ง carousel รวม pending ทั้งหมดเมื่อมีร่างใหม่ถูกสร้างในรอบนี้ (built ไม่ว่าง)
  // ถ้าไม่มีร่างใหม่ และ sig เดิม → ข้าม (กันส่งซ้ำบ่อยเกินไป)
  if (!built.length && prevSig === sig) {
    log_('INFO', '-', '-', 'ไม่มีร่างใหม่เพิ่มและส่ง carousel รอบนี้แล้ว — ข้าม');
    return { sent: 0, alreadyPushed: true, items: briefItems_(built) };
  }

  // เวลาจะไม่พอส่งการ์ด -> ยกไปรอบถัดไป
  if (Date.now() - started > RUN_BUDGET_MS + 60 * 1000) {
    scheduleContinuation_();
    log_('INFO', '-', '-', 'เวลาใกล้หมด — ส่ง LINE รอบถัดไป');
    return { deferred: true, items: briefItems_(built) };
  }

  Line.pushBatchApproval(items);
  props.setProperty('PUSHED_SIG', sig);
  props.setProperty('PUSHED_AT', String(Date.now()));

  log_('OK', '-', '-', 'ส่ง LINE รออนุมัติ ' + items.length + ' ร้าน');
  return { sent: items.length, items: briefItems_(built) };
}

/** ยังมีแถว ready ที่รอสร้างอยู่ไหม */
function hasReadyRows_(sheet, lastRow) {
  lastRow = lastRow || sheet.getLastRow();
  if (lastRow < 2) return false;
  var vals = sheet.getRange(2, COL.STATUS, lastRow - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0] || '').trim().toLowerCase() === STATUS.READY) return true;
  }
  return false;
}

/** แปลงค่าในคอลัมน์ BATCH (Date หรือสตริง) -> 'yyyy-MM-dd' (โซน Asia/Bangkok) */
function batchDateKey_(v, tz) {
  if (!v) return '';
  try {
    if (Object.prototype.toString.call(v) === '[object Date]') {
      return Utilities.formatDate(v, tz || 'Asia/Bangkok', 'yyyy-MM-dd');
    }
    var s = String(v).trim();
    var d = new Date(s);
    return isNaN(d.getTime()) ? s.slice(0, 10) : Utilities.formatDate(d, tz || 'Asia/Bangkok', 'yyyy-MM-dd');
  } catch (e) {
    return '';
  }
}

/** นับร่างของวันนี้ที่ใช้โควตาไปแล้ว (รออนุมัติ/กำลังสร้าง/ตั้งคิวแล้ว/โพสต์แล้ว) */
function countPendingToday_(sheet, dateKey, lastRow) {
  if (lastRow < 2) return 0;
  var tz = getConfig_().timezone;
  var vals = sheet.getRange(2, COL.STATUS, lastRow - 1, COL.BATCH - COL.STATUS + 1).getValues();
  var n = 0;
  for (var i = 0; i < vals.length; i++) {
    var st = String(vals[i][0] || '').trim().toLowerCase();
    var batch = batchDateKey_(vals[i][COL.BATCH - COL.STATUS], tz);
    if (batch !== dateKey) continue;
    if (st === STATUS.PENDING || st === STATUS.PROCESSING ||
        st === STATUS.SCHEDULED || st === STATUS.PUBLISHED) n++;
  }
  return n;
}

/** แถวที่ค้าง processing นานเกินกำหนด (execution ตายกลางทาง) -> คืนเป็น ready */
function recoverStaleProcessing_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var rows = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  var now = Date.now();
  var n = 0;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][COL.STATUS - 1] || '').trim().toLowerCase() !== STATUS.PROCESSING) continue;
    var upd = rows[i][COL.UPDATED_AT - 1];
    var ts = upd instanceof Date ? upd.getTime() : (upd ? new Date(upd).getTime() : 0);
    if (ts && now - ts < STALE_PROCESSING_MS) continue;
    setStatus_(sheet, i + 2, STATUS.READY, 'รีเซ็ตจากสถานะ processing ที่ค้างอยู่');
    n++;
  }
  return n;
}

/** ตั้ง trigger ทำงานต่อใน 1 นาที (ลบของเก่าที่ค้างก่อน) */
function scheduleContinuation_() {
  var props = PropertiesService.getScriptProperties();
  var old = props.getProperty('NEXT_TRIGGER_ID');
  if (old) {
    try {
      ScriptApp.getProjectTriggers().forEach(function (t) {
        if (t.getUniqueId() === old) ScriptApp.deleteTrigger(t);
      });
    } catch (e) {}
    props.deleteProperty('NEXT_TRIGGER_ID');
  }
  try {
    var trig = ScriptApp.newTrigger('runDailyBatch').timeBased().after(60 * 1000).create();
    props.setProperty('NEXT_TRIGGER_ID', trig.getUniqueId());
    return trig.getUniqueId();
  } catch (e) {
    log_('ERROR', '-', '-', 'ตั้งรอบทำต่อไม่สำเร็จ: ' + e.message);
    return '';
  }
}

/** อัปเดต index ของร่างที่รออนุมัติให้ตรงกับชีตทั้งหมด */
function syncPendingIndex_(cfg, sheet) {
  var lastRow = sheet.getLastRow();
  var props = PropertiesService.getScriptProperties();
  if (lastRow < 2) {
    props.deleteProperty('PENDING_ROWS');
    return;
  }
  var vals = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  var rows = [];
  var slots = [];
  var dateKey = '';
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][COL.STATUS - 1] || '').trim().toLowerCase() !== STATUS.PENDING) continue;
    rows.push(i + 2);
    slots.push({
      n: i + 2,
      name: String(vals[i][COL.NAME - 1] || ''),
      zone: String(vals[i][COL.ZONE - 1] || ''),
      title: String(vals[i][COL.TITLE - 1] || '')
    });
    if (!dateKey) dateKey = String(vals[i][COL.BATCH - 1] || '');
  }
  props.setProperty('PENDING_ROWS', rows.join(','));
  if (dateKey) props.setProperty('PENDING_DATE', dateKey);
  props.setProperty('PENDING_SLOTS', JSON.stringify(slots));
}

/**
 * สร้างร่าง 1 แถว: Places -> Gemini -> Doc -> เก็บ pending
 */
function buildDraftForRow_(cfg, sheet, sheetRow, name, zone, usedPlaceIds, dateKey) {
  setStatus_(sheet, sheetRow, STATUS.PROCESSING, 'กำลังค้นข้อมูลร้าน...');

  var place = Places.resolve(name, zone, usedPlaceIds);
  if (!place) throw new Error('หาไม่เจอใน OpenStreetMap: ' + (name || zone) + ' — ลองใส่ชื่อให้ตรงขึ้น หรือเพิ่มโซน');

  // ตรวจลิงก์รูปก่อนยิง Gemini (ถ้าลิงก์รูปทั้งหมดโหลดไม่ได้ = error ทันที ไม่เสีย token)
  var manualPhotos = parsePhotoUrls_(sheet.getRange(sheetRow, COL.PHOTO_IN).getValue());
  var photoCheck = null;
  if (manualPhotos.length) {
    photoCheck = preflightPhotos_(cfg, manualPhotos);
    if (!photoCheck.ok.length) {
      throw new Error('รูป ' + manualPhotos.length + ' ลิงก์โหลดไม่ได้เลย — ต้องเป็นลิงก์รูปตรง ๆ ที่แชร์ "ทุกคนที่มีลิงก์" (หรือรูปจาก Google Drive) ตรวจคอลัมน์ M แล้วใส่ ready ใหม่');
    }
  }

  sheet.getRange(sheetRow, COL.NAME).setValue(place.name);
  sheet.getRange(sheetRow, COL.ZONE).setValue(zone || place.zone || '');
  sheet.getRange(sheetRow, COL.PLACE_ID).setValue(place.placeId);

  setStatus_(sheet, sheetRow, STATUS.PROCESSING, 'กำลังเขียนบทความ...');

  // กันชื่อ/มุมซ้ำ: ส่งชื่อบทความล่าสุดให้ AI หลีกเลี่ยง
  var recentTitles = [];
  try {
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      recentTitles = sheet.getRange(2, COL.TITLE, lastRow - 1, 1).getValues()
        .map(function (r) { return String(r[0] || '').trim(); })
        .filter(Boolean)
        .slice(-10);
    }
  } catch (e) {}

  var article = askGemini_(buildPrompt_(place.name, zone || place.zone, place, recentTitles), cfg);
  article = normalizeArticleSeo_(article, place.name, zone || place.zone);
  article.body = sanitizeArticleBody_(article.body, place, zone || place.zone);
  article = ensureFaq_(article, place.name, zone || place.zone, place);
  var title = article.title || place.name;
  var slug = makeSlug_(place.name, place.placeId);

  var doc = createDraftDoc_(place.name, zone || place.zone, article, cfg);

  var usablePhotos = (photoCheck && photoCheck.ok.length) ? photoCheck.ok : manualPhotos;

  var item = {
    row: sheetRow,
    dateKey: dateKey,
    name: place.name,
    zone: zone || place.zone || 'กรุงเทพฯ',
    slug: slug,
    title: title,
    metaDescription: article.metaDescription || article.excerpt || '',
    excerpt: article.excerpt || '',
    body: article.body,
    faq: article.faq || [],
    tags: article.tags || [],
    placeId: place.placeId,
    address: place.address || '',
    mapsUrl: place.mapsUrl || '',
    hours: place.hours || '',
    rating: place.rating || '',
    lat: place.lat || '',
    lon: place.lon || '',
    website: place.website || '',
    photoRefs: usablePhotos.length ? usablePhotos : (place.photoRef ? [place.photoRef] : []),
    photoRef: usablePhotos[0] || place.photoRef || '',
    photoUrl: usablePhotos[0] || place.photoUrl || '',
    photoManual: usablePhotos.length > 0,
    docUrl: doc.url
  };

  savePending_(cfg, item);

  sheet.getRange(sheetRow, COL.TITLE).setValue(title);
  sheet.getRange(sheetRow, COL.DOC_URL).setValue(doc.url);
  sheet.getRange(sheetRow, COL.SLUG).setValue(slug);
  sheet.getRange(sheetRow, COL.PHOTO_URL).setValue(item.photoUrl);
  sheet.getRange(sheetRow, COL.BATCH).setValue(dateKey);
  setStatus_(sheet, sheetRow, STATUS.PENDING, 'รออนุมัติใน LINE');

  return item;
}

/** เก็บร่างไว้รออนุมัติ (ไฟล์ JSON เล็ก ๆ ใน Drive) */
function savePending_(cfg, item) {
  var name = 'pending-' + item.row + '.json';
  var json = JSON.stringify(item);
  var folder = cfg.folderId ? DriveApp.getFolderById(cfg.folderId) : DriveApp.getRootFolder();
  var files = folder.getFilesByName(name);
  while (files.hasNext()) {
    files.next().setTrashed(true);
  }
  folder.createFile(name, json, MimeType.PLAIN_TEXT);
}

/** โหลดร่างที่รออนุมัติของแถวหนึ่ง */
function loadPending_(cfg, row) {
  var folder = cfg.folderId ? DriveApp.getFolderById(cfg.folderId) : DriveApp.getRootFolder();
  var files = folder.getFilesByName('pending-' + row + '.json');
  if (!files.hasNext()) return null;
  return JSON.parse(files.next().getBlob().getDataAsString('UTF-8'));
}

function deletePending_(cfg, row) {
  try {
    var folder = cfg.folderId ? DriveApp.getFolderById(cfg.folderId) : DriveApp.getRootFolder();
    var files = folder.getFilesByName('pending-' + row + '.json');
    while (files.hasNext()) files.next().setTrashed(true);
  } catch (e) {
    log_('WARN', '-', row, 'ลบไฟล์ pending ไม่สำเร็จ: ' + e.message);
  }
}

/** เก็บ index ของร่างที่รออนุมัติ (ไว้ให้ webhook หาเจอ) */
function fixPendingIndex_(cfg, items) {
  var props = PropertiesService.getScriptProperties();
  var rows = items.map(function (it) { return it.row; });
  props.setProperty('PENDING_ROWS', rows.join(','));
  props.setProperty('PENDING_DATE', items[0].dateKey);
  props.setProperty('PENDING_SLOTS', JSON.stringify(items.map(function (it) { return { n: it.row, name: it.name, zone: it.zone, title: it.title }; })));
}

/** เปลี่ยนสถานะ + สีพื้นหลังให้ดูง่าย */
function setStatus_(sheet, row, status, note) {
  sheet.getRange(row, COL.STATUS).setValue(status);

  var colors = {
    ready: '#FFF2CC',
    processing: '#D9E7FD',
    pending: '#FCE8B2',
    scheduled: '#D9EAD3',
    published: '#C9DAF8',
    rejected: '#EAD1DC',
    error: '#F4CCCC'
  };
  var color = colors[String(status).toLowerCase()];
  if (color) sheet.getRange(row, COL.STATUS).setBackground(color);

  sheet.getRange(row, COL.UPDATED_AT).setValue(new Date());
  if (note !== undefined && note !== null && note !== '') {
    sheet.getRange(row, COL.NOTE).setValue(note);
  }
}

/** ADMIN: คืนแถวที่ error ตั้งแต่แถว 15 เป็นต้นไปกลับเป็น ready (ล้าง error รอบ Gemini โหลด) */
function resetErrorToReady() {
  var cfg = getConfig_();
  var sheet = getSheet_(cfg.sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 15) return { reset: 0 };
  var vals = sheet.getRange(15, 1, lastRow - 14, HEADERS.length).getValues();
  var n = 0;
  var resetRows = [];
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][COL.STATUS - 1] || '').trim().toLowerCase() !== 'error') continue;
    setStatus_(sheet, i + 15, STATUS.READY, 'รีเซ็ต รอสร้างใหม่');
    resetRows.push(i + 15);
    n++;
  }
  log_('INFO', '-', '-', 'รีเซ็ต error->ready แถว: ' + resetRows.join(', '));
  return { reset: n, rows: resetRows };
}

/** อ่านข้อมูลในชีตแบบสรุป (เรียกผ่าน ?run=dumpSheet เพื่อตรวจงาน) */
function dumpSheet() {
  var cfg = getConfig_();
  var ss = getSpreadsheet_();
  var sheet = getSheet_(cfg.sheetName);
  var last = Math.max(sheet.getLastRow(), 1);
  var n = Math.min(last, 120);
  var rows = sheet.getRange(1, 1, n, HEADERS.length).getValues();
  var out = rows.map(function (r, i) {
    var photos = String(r[COL.PHOTO_IN - 1] || '').replace(/\s+/g, ' ').trim();
    var upd = r[COL.UPDATED_AT - 1];
    return {
      row: i + 1,
      name: String(r[COL.NAME - 1] || ''),
      zone: String(r[COL.ZONE - 1] || ''),
      status: String(r[COL.STATUS - 1] || ''),
      slug: String(r[COL.SLUG - 1] || ''),
      batch: String(r[COL.BATCH - 1] || ''),
      updated: upd instanceof Date ? upd.toISOString() : String(upd || ''),
      note: String(r[COL.NOTE - 1] || '').slice(0, 120),
      photoCount: parsePhotoUrls_(photos).length,
      photos: photos.slice(0, 240)
    };
  });
  return { ssId: ss.getId(), ssName: ss.getName(), sheet: sheet.getName(), lastRow: last, rows: out };
}

/** DEBUG: อ่าน log ล่าสุด (เรียกผ่าน ?run=dumpLog) */
function dumpLog() {
  var cfg = getConfig_();
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(cfg.logSheet);
  if (!sh) return { rows: [] };
  var last = sh.getLastRow();
  if (last < 2) return { rows: [] };
  var n = Math.min(last - 1, 60);
  var vals = sh.getRange(last - n + 1, 1, n, 5).getValues();
  return {
    rows: vals.map(function (r) {
      return {
        time: r[0] instanceof Date ? Utilities.formatDate(r[0], cfg.timezone, 'yyyy-MM-dd HH:mm:ss') : String(r[0]),
        level: String(r[1]),
        cafe: String(r[2]),
        row: String(r[3]),
        msg: String(r[4]).slice(0, 220)
      };
    })
  };
}

/** ตั้งหัวตารางให้ตรงกับที่โค้ดต้องการ */
function setupHeaders() {
  var cfg = getConfig_();
  var sheet = getSheet_(cfg.sheetName);
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold').setBackground('#CFE2F3');
  sheet.setFrozenRows(1);

  var widths = [200, 120, 105, 300, 300, 130, 300, 300, 200, 220, 200, 100, 300];
  for (var i = 0; i < widths.length; i++) sheet.setColumnWidth(i + 1, widths[i]);

  sheet.getRange(1, COL.PHOTO_IN).setNote(
    'ไม่บังคับ: วางลิงก์รูปของร้านได้ 1–5 รูป (ขึ้นบรรทัดใหม่ หรือคั่นด้วยจุลภาค)\n' +
    'รองรับ Google Drive ที่แชร์เป็น "ทุกคนที่มีลิงก์" และลิงก์รูปตรง ๆ\n' +
    'ถ้าเว้นว่าง ระบบจะสร้างปกอัตโนมัติให้'
  );

  // แถวว่างที่ยังไม่มีข้อมูล -> ใส่ตัวอย่างไว้ให้กรอกง่าย
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    sheet.getRange(2, 1, 3, 2).setValues([['', ''], ['', ''], ['', '']]);
  }

  log_('INFO', '-', '-', 'ตั้งหัวตารางเรียบร้อย');
  return HEADERS;
}

/** แปลงลิงก์รูปที่ผู้ใช้ใส่ → URL ที่ดาวน์โหลดได้จริง */
function normalizePhotoUrl_(u) {
  var s = String(u || '').trim();
  if (!s) return '';
  // Google Drive share link -> direct download
  var m = s.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=)([-\w]{10,})/i);
  if (m) return 'https://drive.google.com/uc?export=download&id=' + m[1];
  if (/^https?:\/\//i.test(s)) return s;  // ตรวจ content-type ตอนดาวน์โหลดอีกที
  return '';
}

/** ตรวจลิงก์รูปตอนสร้างร่าง (ลามก่อนยิง Gemini) */
function preflightPhotos_(cfg, urls) {
  var ok = [], failed = [];
  for (var i = 0; i < urls.length; i++) {
    var f = Places.photoFile_(cfg, urls[i], 1600);
    if (f) ok.push(urls[i]); else failed.push(urls[i]);
  }
  if (failed.length) {
    log_('WARN', '-', '-', 'โหลดรูปไม่ได้ ' + failed.length + ' ลิงก์: ' + failed.join(' | '));
  }
  return { ok: ok, failed: failed };
}

/** แยกช่อง M ที่อาจมีหลายลิงก์ (ขึ้นบรรทัดใหม่ / คั่นด้วย , หรือเว้นวรรค) */
function parsePhotoUrls_(raw) {
  var parts = String(raw || '').split(/[\s,]+/);
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var u = normalizePhotoUrl_(parts[i]);
    if (u && out.indexOf(u) === -1) out.push(u);
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * สเปรดชีตหลัก — ใช้ SHEET_ID จาก Script Properties ก่อน
 * (ทำให้สคริปต์แบบ standalone ทำงานได้ ไม่ต้องผูกกับชีต)
 */
function getSpreadsheet_() {
  var id = '';
  try { id = PropertiesService.getScriptProperties().getProperty('SHEET_ID') || ''; } catch (e) {}
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('ยังไม่ได้ตั้งค่า SHEET_ID ใน Script Properties');
  return active;
}

/** อ่าน/สร้างชีต */
function getSheet_(name) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

/** เขียน log ลงชีต Log */
function log_(level, cafe, row, message) {
  try {
    var cfg = getConfig_();
    var ss = getSpreadsheet_();
    var logSheet = ss.getSheetByName(cfg.logSheet);
    if (!logSheet) {
      logSheet = ss.insertSheet(cfg.logSheet);
      logSheet.getRange(1, 1, 1, 5)
        .setValues([['Time', 'Level', 'Cafe', 'Row', 'Message']])
        .setFontWeight('bold');
    }
    logSheet.appendRow([new Date(), level, cafe, row, message]);
  } catch (e) {
    Logger.log('log_ failed: ' + e.message);
  }
}

/** อ่านค่าตั้งค่าจาก Script Properties พร้อมค่า default */
function getConfig_() {
  var p = PropertiesService.getScriptProperties();
  var batch = parseInt(p.getProperty('BATCH_SIZE') || DEFAULTS.BATCH_SIZE, 10);
  return {
    apiKey: p.getProperty('GEMINI_API_KEY') || '',
    model: p.getProperty('GEMINI_MODEL') || DEFAULTS.MODEL,
    groqKey: p.getProperty('GROQ_API_KEY') || '',
    groqModel: p.getProperty('GROQ_MODEL') || 'openai/gpt-oss-120b',
    folderId: p.getProperty('DOC_FOLDER_ID') || '',
    sheetName: p.getProperty('SHEET_NAME') || DEFAULTS.SHEET_NAME,
    logSheet: p.getProperty('LOG_SHEET') || DEFAULTS.LOG_SHEET,
    titlePrefix: p.getProperty('DOC_TITLE_PREFIX') || DEFAULTS.DOC_TITLE_PREFIX,
    batchSize: (isNaN(batch) || batch < 1) ? DEFAULTS.BATCH_SIZE : batch,
    temperature: parseFloat(p.getProperty('TEMPERATURE') || '0.8'),
    thinkingBudget: p.getProperty('GEMINI_THINKING_BUDGET'),
    timezone: p.getProperty('TIMEZONE') || 'Asia/Bangkok',

    placesKey: p.getProperty('PLACES_API_KEY') || '',

    lineToken: p.getProperty('LINE_CHANNEL_ACCESS_TOKEN') || '',
    lineSecret: p.getProperty('LINE_CHANNEL_SECRET') || '',
    lineAdmin: p.getProperty('LINE_ADMIN_USER_ID') || '',
    lineWebhookToken: p.getProperty('LINE_WEBHOOK_TOKEN') || '',

    ghToken: p.getProperty('GITHUB_TOKEN') || '',
    ghOwner: p.getProperty('GITHUB_OWNER') || '',
    ghRepo: p.getProperty('GITHUB_REPO') || 'paicafekan',
    ghBranch: p.getProperty('GITHUB_BRANCH') || 'main',

    siteBase: p.getProperty('SITE_BASE_URL') || 'https://paicafekan.com'
  };
}

/* ---------------------- Places.gs ---------------------- */
/**
 * Places: ค้นข้อมูลร้านจาก OpenStreetMap (Nominatim + OSM API)
 * ไม่ใช้ API key และไม่ต้องผูกบัตร · รูปจาก og:image ของเว็บร้าน
 *
 * คืนค่ารูปแบบเดิมเหมือนเวอร์ชัน Google Places เพื่อให้ส่วนอื่นใช้ต่อได้:
 * { name, zone, address, mapsUrl, hours, rating, ratingCount, website,
 *   summary, photoRef, photoUrl, placeId, lat, lon }
 */

var NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
var OSM_API_URL = 'https://api.openstreetmap.org/api/0.6';
var OSM_UA = 'paicafekan-bot/1.0 (+https://paicafekan.com)';
var PHOTO_MAX_BYTES = 6 * 1024 * 1024;

var Places = {

  /** ค้นหาร้าน แล้วคืนข้อมูลที่ใช้เขียนบทความได้ */
  resolve: function (name, zone, excludePlaceIds) {
    var queries = [];
    if (name) {
      queries.push([name, zone, 'กรุงเทพ'].filter(Boolean).join(' '));
      if (zone) queries.push([name, 'กรุงเทพ'].filter(Boolean).join(' '));
    } else {
      queries.push(['คาเฟ่', zone, 'กรุงเทพ'].filter(Boolean).join(' '));
    }

    var exclude = excludePlaceIds || [];
    for (var q = 0; q < queries.length; q++) {
      // มารยาทกับ Nominatim: ไม่เกิน 1 คำขอ/วินาที
      if (q > 0) Utilities.sleep(1200);
      var results = Places.search_(queries[q]);
      var best = Places.pickBest_(results, name, exclude);
      if (best) return Places.toItem_(best, zone);
    }
    return null;
  },

  /** เรียก UrlFetch แบบมี User-Agent (Nominatim บังคับ) */
  fetch_: function (url, extra) {
    var opts = {
      muteHttpExceptions: true,
      headers: { 'User-Agent': OSM_UA, 'Accept-Language': 'th,en' },
      followRedirects: true
    };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) opts[k] = extra[k];
      }
    }
    try {
      return UrlFetchApp.fetch(url, opts);
    } catch (e) {
      // เผื่อ Apps Script ไม่ยอมให้ตั้ง User-Agent
      log_('WARN', '-', '-', 'fetch แบบมี User-Agent ไม่ได้: ' + e.message);
      return UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    }
  },

  /** ค้นด้วย Nominatim */
  search_: function (query) {
    var url = NOMINATIM_URL +
      '?format=jsonv2&limit=8&addressdetails=1&extratags=1&namedetails=1' +
      '&accept-language=th&countrycodes=th&q=' + encodeURIComponent(query);

    var res = Places.fetch_(url);
    var code = res.getResponseCode();
    if (code !== 200) {
      throw new Error('Nominatim error ' + code + ': ' + res.getContentText().slice(0, 200));
    }
    var list = JSON.parse(res.getContentText() || '[]');
    return Array.isArray(list) ? list : [];
  },

  /** เลือกผลลัพธ์ที่ตรงชื่อที่สุด (ให้ความสำคัญกับ amenity=cafe ก่อน) */
  pickBest_: function (results, name, exclude) {
    if (!results || !results.length) return null;

    var list = results.filter(function (r) {
      var id = Places.idOf_(r);
      return !id || exclude.indexOf(id) === -1;
    });
    if (!list.length) list = results;

    var cafes = list.filter(function (r) {
      return r.category === 'amenity' && /^(cafe|coffee)$/.test(String(r.type || ''));
    });
    var pool = cafes.slice();
    for (var k = 0; k < list.length; k++) {
      if (pool.indexOf(list[k]) === -1) pool.push(list[k]);
    }

    var target = normalize_(name);
    if (target) {
      for (var i = 0; i < pool.length; i++) {
        var n = normalize_(Places.nameOf_(pool[i]));
        if (n && (n.indexOf(target) !== -1 || target.indexOf(n) !== -1)) return pool[i];
      }
    }
    return pool[0];
  },

  nameOf_: function (r) {
    return r.name ||
      (r.namedetails && r.namedetails.name) ||
      (r.address && (r.address.amenity || r.address.shop || r.address.office)) ||
      '';
  },

  idOf_: function (r) {
    return (r.osm_type && r.osm_id) ? 'osm:' + r.osm_type + '/' + r.osm_id : '';
  },

  /** ดึง tags เต็มจาก OSM API (เวลาเปิด-ปิด, เว็บ, เบอร์โทร ฯลฯ) */
  tags_: function (r) {
    var type = r.osm_type;
    var id = r.osm_id;
    if (!type || !id) return {};

    var suffix = type === 'node' ? '.json' : '/full.json';
    var url = OSM_API_URL + '/' + type + '/' + id + suffix;
    try {
      var res = Places.fetch_(url);
      if (res.getResponseCode() !== 200) return {};
      var json = JSON.parse(res.getContentText() || '{}');
      var els = json.elements || [];
      for (var i = 0; i < els.length; i++) {
        if (els[i].type === type && String(els[i].id) === String(id) && els[i].tags) return els[i].tags;
      }
      for (var j = 0; j < els.length; j++) {
        if (els[j].tags) return els[j].tags;
      }
    } catch (e) {
      log_('WARN', '-', '-', 'อ่าน tags จาก OSM ไม่ได้: ' + e.message);
    }
    return {};
  },

  /** แปลงผลลัพธ์ -> ข้อมูลที่ใช้ต่อ */
  toItem_: function (r, zone) {
    var tags = Places.tags_(r);
    var ex = r.extratags || {};

    var name = Places.nameOf_(r) || r.display_name || '';
    var address = r.display_name || '';
    var website = tags.website || tags['contact:website'] || ex.website || '';

    var hours = String(tags.opening_hours || ex.opening_hours || '').replace(/\s*;\s*/g, ' · ');

    var photoRef = Places.photoFromTags_(tags, ex);
    if (!photoRef && website) {
      Utilities.sleep(300);
      photoRef = Places.photoFromWebsite_(website);
    }

    var mapsUrl = (r.lat && r.lon)
      ? 'https://www.google.com/maps/search/?api=1&query=' + r.lat + ',' + r.lon
      : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(name);

    return {
      name: name,
      zone: zone || guessZone_(address),
      address: address,
      mapsUrl: mapsUrl,
      hours: hours,
      rating: '',
      ratingCount: 0,
      website: website,
      summary: Places.summary_(tags, ex),
      photoRef: photoRef,
      photoUrl: photoRef,
      placeId: Places.idOf_(r),
      lat: r.lat || '',
      lon: r.lon || ''
    };
  },

  /** สรุปข้อมูลที่มีใน OSM แบบสั้น ๆ ให้ Gemini ใช้ */
  summary_: function (tags, ex) {
    var bits = [];
    var cuisine = tags.cuisine || ex.cuisine;
    if (cuisine) bits.push('ประเภท: ' + String(cuisine).replace(/_/g, ' '));
    if (tags.outdoor_seating === 'yes') bits.push('มีที่นั่งกลางแจ้ง');
    if (tags.indoor_seating === 'yes') bits.push('มีที่นั่งในร้าน');
    if (tags.wheelchair === 'yes') bits.push('รองรับรถเข็น');
    if (tags['internet_access'] === 'wlan' || tags['internet_access'] === 'yes') bits.push('มี Wi-Fi');
    if (tags.takeaway === 'yes') bits.push('มีกลับบ้าน');
    if (tags.rooftop === 'yes') bits.push('ดาดฟ้า');
    var phone = tags.phone || tags['contact:phone'];
    if (phone) bits.push('โทร ' + phone);
    return bits.join(' · ');
  },

  /** รูปจาก tag ของ OSM (ถ้ามี) */
  photoFromTags_: function (tags, ex) {
    var cands = [tags.image, ex.image, tags['image:0']];
    for (var i = 0; i < cands.length; i++) {
      var u = String(cands[i] || '');
      if (/^https?:\/\//i.test(u) && /\.(jpg|jpeg|png|webp)(\?|$)/i.test(u)) return u;
    }
    return '';
  },

  /** หา og:image จากเว็บร้าน */
  photoFromWebsite_: function (website) {
    try {
      var res = Places.fetch_(website);
      if (res.getResponseCode() !== 200) return '';
      var html = String(res.getContentText() || '').slice(0, 400000);
      if (!html) return '';

      var patterns = [
        /<meta[^>]+(?:property|name)=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/i,
        /<meta[^>]+(?:property|name)=["']twitter:image["'][^>]+content=["']([^"']+)["']/i
      ];

      var found = '';
      for (var i = 0; i < patterns.length && !found; i++) {
        var m = html.match(patterns[i]);
        if (m && m[1]) found = m[1];
      }
      if (!found) return '';
      return Places.absoluteUrl_(found, website);
    } catch (e) {
      log_('WARN', '-', '-', 'อ่าน og:image ไม่ได้: ' + e.message);
      return '';
    }
  },

  absoluteUrl_: function (u, base) {
    u = String(u || '').trim();
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (u.indexOf('//') === 0) return 'https:' + u;
    var m = String(base || '').match(/^(https?:\/\/[^\/]+)/i);
    var root = m ? m[1] : '';
    if (u.charAt(0) === '/') return root + u;
    return root + '/' + u.replace(/^\.?\//, '');
  },

  /** URL ของรูป (ใช้ส่ง LINE + แสดงตัวอย่าง) */
  photoUrl_: function (cfg, photoRef, width) {
    return photoRef || '';
  },

  /** ดาวน์โหลดรูป -> { b64, ext } ; ext = jpg/png/gif/webp (ตรวจจาก magic bytes) */
  photoFile_: function (cfg, photoRef, width) {
    if (!photoRef) return null;
    var base = String((cfg && cfg.siteBase) || '').replace(/\/+$/, '');
    var tries = [photoRef];
    // ถ้าดาวน์โหลดตรงไม่ได้ (เว็บต้นทางบล็อก) -> ลองผ่าน image proxy ของเว็บเรา
    if (base && String(photoRef).indexOf(base + '/api/img') !== 0) {
      tries.push(base + '/api/img?u=' + encodeURIComponent(photoRef));
    }
    for (var i = 0; i < tries.length; i++) {
      var f = Places.downloadImage_(tries[i]);
      if (f) return f;
    }
    return null;
  },

  /** ดาวน์โหลด + ตรวจว่าเป็นไฟล์ภาพจริง */
  downloadImage_: function (url) {
    try {
      var res = Places.fetch_(url);
      var code = res.getResponseCode();
      if (code !== 200) {
        log_('WARN', '-', '-', 'โหลดรูปไม่สำเร็จ (' + code + '): ' + String(url).slice(0, 120));
        return null;
      }
      var bytes = res.getBlob().getBytes();
      if (!bytes.length || bytes.length > PHOTO_MAX_BYTES) {
        log_('WARN', '-', '-', 'รูปว่างหรือใหญ่เกิน: ' + String(url).slice(0, 120));
        return null;
      }
      var ext = imageType_(bytes);
      if (!ext) {
        log_('WARN', '-', '-', 'ลิงก์ไม่ใช่ไฟล์ภาพ: ' + String(url).slice(0, 120));
        return null;
      }
      return { b64: Utilities.base64Encode(bytes), ext: ext };
    } catch (e) {
      log_('WARN', '-', '-', 'ดาวน์โหลดรูปไม่ได้: ' + e.message + ' | ' + String(url).slice(0, 100));
      return null;
    }
  },

  /** ดาวน์โหลดรูปเป็น base64 (เอาไป commit ขึ้นเว็บ) */
  photoBase64_: function (cfg, photoRef, width) {
    var f = Places.photoFile_(cfg, photoRef, width);
    return f ? f.b64 : '';
  },

  /** หาโซนจากที่อยู่แบบหยาบ ๆ */
  zoneOf_: function (address) {
    return guessZone_(address || '');
  }
};

/**
 * รวมแหล่งรูปฟรีของร้าน: OSM image tag + og:image จากเว็บร้าน
 * (ไม่ใช้ Google Places API ที่ต้องผูกบัตร)
 */
function photoCandidates_(name, zone, website) {
  var urls = [];
  function add(u) {
    u = normalizePhotoUrl_(u);
    if (u && urls.indexOf(u) === -1) urls.push(u);
  }
  var place = null;
  try { place = Places.resolve(name, zone); } catch (e) { log_('WARN', '-', '-', 'หาร้านไม่สำเร็จ: ' + e.message); }
  if (place) {
    add(place.photoRef);
    if (!website && place.website) website = place.website;
  }
  if (website) add(Places.photoFromWebsite_(website));
  if (place && place.website && place.website !== website) add(Places.photoFromWebsite_(place.website));
  return { place: place, website: website || '', urls: urls };
}

/** ตรวจว่ารูปโหลดได้จริงและเป็นไฟล์ภาพ (ช้าประมาณ 1–2 วินาที/รูป) */
function validPhotoUrls_(cfg, urls, max) {
  var ok = [];
  for (var i = 0; i < urls.length && ok.length < (max || 3); i++) {
    if (Places.photoFile_(cfg, urls[i], 1200)) ok.push(urls[i]);
  }
  return ok;
}

/**
 * ADMIN: หา "ลิงก์รูป" ให้แถวที่ยังไม่มีรูปในคอลัมน์ M
 * คืนรายการให้ดูก่อน ไม่เขียนลงชีต
 */
function photoSuggest(limit) {
  var cfg = getConfig_();
  var sheet = getSheet_(cfg.sheetName);
  var last = sheet.getLastRow();
  var out = [];
  if (last < 2) return out;
  var rows = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var max = Number(limit || 5);
  for (var i = 0; i < rows.length && out.length < max; i++) {
    var name = String(rows[i][COL.NAME - 1] || '').trim();
    var zone = String(rows[i][COL.ZONE - 1] || '').trim();
    var status = String(rows[i][COL.STATUS - 1] || '').trim().toLowerCase();
    var manual = String(rows[i][COL.PHOTO_IN - 1] || '').trim();
    if (!name || manual) continue;
    if (status === STATUS.PUBLISHED || status === STATUS.REJECTED) continue;
    var found = photoCandidates_(name, zone, '');
    var ok = validPhotoUrls_(cfg, found.urls, 3);
    if (!ok.length) { log_('WARN', '-', '-', 'ไม่พบรูปที่ใช้ได้: ' + name); continue; }
    out.push({ row: i + 2, name: name, zone: zone, website: found.website, urls: ok });
    Utilities.sleep(600);
  }
  log_('INFO', '-', '-', 'PHOTO SUGGEST ' + out.map(function (o) {
    return o.row + ':' + o.name + '(' + o.urls.length + ')';
  }).join(' | '));
  return out;
}

/** ADMIN: เติมลิงก์รูปที่ตรวจแล้วลงคอลัมน์ M (ให้ผู้ใช้ตรวจซ้ำก่อนกด ready) */
function autoFillPhotos(limit) {
  var cfg = getConfig_();
  var sheet = getSheet_(cfg.sheetName);
  var list = photoSuggest(limit || 5);
  list.forEach(function (o) {
    sheet.getRange(o.row, COL.PHOTO_IN).setValue(o.urls.join('\n'));
    sheet.getRange(o.row, COL.NOTE).setValue('เติมรูปอัตโนมัติ ' + o.urls.length + ' รูป — ตรวจก่อนโพสต์');
    log_('INFO', o.name, o.row, 'PHOTO FILL ' + o.urls.length + ': ' + o.urls.join(' '));
  });
  if (list.length) SpreadsheetApp.flush();
  return { filled: list.length, rows: list.map(function (o) { return o.row + ':' + o.name; }) };
}

/** เมนูชีต: ดูลิงก์รูปที่หาเจอ (ไม่เขียนลงชีต) */
function showPhotoSuggest() {
  var list = photoSuggest(5);
  var msg = list.length
    ? list.map(function (o) {
        return 'แถว ' + o.row + ' · ' + o.name + ' (' + o.zone + ')\n' + o.urls.join('\n');
      }).join('\n\n')
    : 'ไม่มีร้านที่ต้องเติมรูป (หรือหารูปไม่เจอ)';
  SpreadsheetApp.getUi().alert('ลิงก์รูปที่หาเจอ · ' + list.length + ' ร้าน', msg.slice(0, 1800), SpreadsheetApp.getUi().ButtonSet.OK);
  return list;
}

/** เมนูชีต: เติมลิงก์รูปลงคอลัมน์ M */
function fillPhotosMenu() {
  var r = autoFillPhotos(5);
  SpreadsheetApp.getUi().alert(
    'เติมรูปแล้ว ' + r.filled + ' ร้าน',
    r.rows.join('\n') || 'ไม่มีอะไรต้องเติม — ตรวจคอลัมน์ M แล้วกด ready ได้เลย',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
  return r;
}

/* ---------------- AI ช่วยเลือกลิงก์รูป (ใช้ห่วงโซ่ AI สำรอง) ---------------- */

/** หา URL รูปจากผลค้นหาเว็บฟรี (DuckDuckGo HTML) — ไม่ต้องใช้ API key */
function webImageCandidates_(name, zone) {
  var urls = [];
  var q = '"' + name + '" ' + (zone ? zone + ' ' : '') + 'cafe Bangkok';
  var url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q);
  var html = '';
  try {
    var res = Places.fetch_(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36', 'Accept-Language': 'th,en;q=0.8' },
      deadline: 20000
    });
    if (res.getResponseCode() === 200) html = res.getContentText();
  } catch (e) {
    log_('WARN', '-', '-', 'ค้นหารูปจากเว็บไม่ได้: ' + String(e && e.message ? e.message : e).slice(0, 160));
  }
  if (!html) return urls;

  // ภาพตัวอย่างของ DuckDuckGo เป็น proxy: /iu/?u=<url ต้นฉบับ>
  var re = /https?:\/\/external-content\.duckduckgo\.com\/iu\/\?u=([^&"'<>\s]+)/gi;
  var m;
  while ((m = re.exec(html))) {
    var u = m[1];
    try { u = decodeURIComponent(u); } catch (e) {}
    if (urls.indexOf(u) === -1) urls.push(u);
    if (urls.length >= 12) break;
  }
  // ลิงก์รูปตรง ๆ ที่โผล่ในผลค้นหา
  var re2 = /https?:\/\/[^"'<>\s]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"'<>\s]*)?/gi;
  while ((m = re2.exec(html))) {
    var u2 = String(m[0]).replace(/&amp;/g, '&');
    if (urls.indexOf(u2) === -1) urls.push(u2);
    if (urls.length >= 20) break;
  }
  return urls.slice(0, 20).map(normalizePhotoUrl_).filter(Boolean);
}

/**
 * ให้ AI เลือกลิงก์รูปที่น่าจะเป็นของร้านจริงจาก "รายการที่เราหามาแล้วเท่านั้น"
 * ห้าม AI แต่ง URL ขึ้นมาใหม่ — ผลที่ได้จะถูกกรองด้วยรายการเดิมอีกชั้น
 */
function aiPickPhotoUrls_(name, zone, candidates) {
  var uniq = [];
  candidates.forEach(function (u) { if (u && uniq.indexOf(u) === -1) uniq.push(u); });
  uniq = uniq.slice(0, 14);
  if (!uniq.length) return { provider: '-', urls: [] };

  var prompt = [
    'คุณเป็นผู้ช่วยจัดหาภาพประกอบบทความคาเฟ่ของเว็บ paicafekan.com',
    'ร้าน: ' + name + ' | ย่าน: ' + zone + ' กรุงเทพฯ',
    'ด้านล่างคือลิงก์รูปที่ระบบค้นหาเว็บเจอมาจริง (อาจมีรูปที่ไม่เกี่ยวข้องปนอยู่)',
    'เลือกเฉพาะลิงก์ที่น่าจะเป็นรูปของร้านนี้หรือบรรยากาศร้านจริง จากรายการด้านล่างเท่านั้น',
    'ห้ามแต่งลิงก์ใหม่ ห้ามเดาชื่อไฟล์ ห้ามเปลี่ยนตัวอักษรในลิงก์ ถ้าไม่แน่ใจให้ไม่เลือก',
    'ตอบ JSON เท่านั้น ในรูปแบบ: {"urls":["ลิงก์จากรายการ","ลิงก์จากรายการ"]} (สูงสุด 3 ลิงก์)',
    '',
    'รายการลิงก์:',
    uniq.map(function (u, i) { return (i + 1) + '. ' + u; }).join('\n')
  ].join('\n');

  var ans = aiAskText_(prompt, getConfig_());
  var data = null;
  try {
    data = JSON.parse(ans.text);
  } catch (e) {
    var m = String(ans.text).match(/\{[\s\S]*\}/);
    if (m) { try { data = JSON.parse(m[0]); } catch (e2) {} }
  }
  var picked = (data && data.urls) || (data && data.links) || [];
  if (!Array.isArray(picked)) picked = [];
  var clean = picked.map(function (u) { return String(u || '').trim(); })
    .filter(function (u) { return uniq.indexOf(u) !== -1; });
  return { provider: ans.provider, urls: clean.slice(0, 3) };
}

/**
 * ADMIN: หาลิงก์รูปด้วย AI (OSM + og:image + ผลค้นหาเว็บ -> AI เลือก -> ตรวจว่าโหลดได้จริง)
 * คืนรายการให้ดูก่อน ไม่เขียนลงชีต
 */
function photoSuggestAi_(limit) {
  var cfg = getConfig_();
  var sheet = getSheet_(cfg.sheetName);
  var last = sheet.getLastRow();
  var out = [];
  if (last < 2) return out;
  var rows = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var max = Number(limit || 3);

  for (var i = 0; i < rows.length && out.length < max; i++) {
    var name = String(rows[i][COL.NAME - 1] || '').trim();
    var zone = String(rows[i][COL.ZONE - 1] || '').trim();
    var status = String(rows[i][COL.STATUS - 1] || '').trim().toLowerCase();
    var manual = String(rows[i][COL.PHOTO_IN - 1] || '').trim();
    if (!name || manual || status === STATUS.PUBLISHED || status === STATUS.REJECTED) continue;

    var base = photoCandidates_(name, zone, '');
    var web = webImageCandidates_(name, zone);
    var all = [];
    base.urls.concat(web).forEach(function (u) { if (u && all.indexOf(u) === -1) all.push(u); });
    if (!all.length) { log_('WARN', '-', '-', 'AI ลิงก์รูป: ไม่พบตัวเลือกสำหรับ ' + name); continue; }

    var picked = [];
    var provider = '-';
    try {
      var ai = aiPickPhotoUrls_(name, zone, all);
      picked = ai.urls;
      provider = ai.provider;
    } catch (e) {
      // AI ใช้ไม่ได้ทั้งห่วงโซ่ -> ยังตรวจลิงก์ที่หาได้ตามลำดับเดิม
      log_('WARN', '-', '-', 'AI เลือกลิงก์รูปไม่สำเร็จ ใช้ลำดับเดิม: ' + String(e && e.message ? e.message : e).slice(0, 200));
    }
    var ordered = picked.concat(all.filter(function (u) { return picked.indexOf(u) === -1; }));
    var ok = validPhotoUrls_(cfg, ordered, 3);
    if (!ok.length) { log_('WARN', '-', '-', 'AI ลิงก์รูป: โหลดรูปไม่ได้เลยสำหรับ ' + name); continue; }

    out.push({ row: i + 2, name: name, zone: zone, urls: ok, provider: provider, aiPicked: picked });
    Utilities.sleep(400);
  }
  log_('INFO', '-', '-', 'AI PHOTO SUGGEST ' + out.map(function (o) {
    return o.row + ':' + o.name + '(' + o.provider + ',' + o.urls.length + ')';
  }).join(' | '));
  return out;
}

/** ADMIN: เติมลิงก์รูปที่ AI เลือกแล้วลงคอลัมน์ M (ผู้ใช้ตรวจก่อนกด ready เสมอ) */
function autoFillPhotosAi_(limit) {
  var cfg = getConfig_();
  var sheet = getSheet_(cfg.sheetName);
  var list = photoSuggestAi_(limit || 3);
  list.forEach(function (o) {
    sheet.getRange(o.row, COL.PHOTO_IN).setValue(o.urls.join('\n'));
    sheet.getRange(o.row, COL.NOTE).setValue('AI เลือกลิงก์รูป (' + o.provider + ') ' + o.urls.length + ' รูป — ตรวจก่อนโพสต์');
    log_('INFO', o.name, o.row, 'AI PHOTO FILL ' + o.urls.length + ': ' + o.urls.join(' '));
  });
  if (list.length) SpreadsheetApp.flush();
  return { filled: list.length, rows: list.map(function (o) { return o.row + ':' + o.name; }) };
}

/** เมนูชีต: ดูลิงก์รูปที่ AI เลือก (ไม่เขียนลงชีต) */
function showPhotoSuggestAi() {
  var list = photoSuggestAi_(3);
  var msg = list.length
    ? list.map(function (o) {
        return 'แถว ' + o.row + ' · ' + o.name + ' (' + o.zone + ') [' + o.provider + ']\n' + o.urls.join('\n');
      }).join('\n\n')
    : 'AI หาลิงก์รูปไม่เจอ (หรือทุกแถวมีรูปในคอลัมน์ M แล้ว)';
  SpreadsheetApp.getUi().alert('AI ช่วยหาลิงก์รูป · ' + list.length + ' ร้าน', msg.slice(0, 1800), SpreadsheetApp.getUi().ButtonSet.OK);
  return list;
}

/** เมนูชีต: เติมลิงก์รูปจาก AI ลงคอลัมน์ M */
function fillPhotosAiMenu() {
  var r = autoFillPhotosAi_(3);
  SpreadsheetApp.getUi().alert(
    'AI เติมลิงก์รูปแล้ว ' + r.filled + ' ร้าน',
    r.rows.join('\n') || 'ไม่มีอะไรต้องเติม — ตรวจคอลัมน์ M แล้วกด ready ได้เลย',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
  return r;
}

/** เดาโซนจากที่อยู่ (ใช้แค่แสดงผล) */
function guessZone_(address) {
  var zones = ['อารีย์', 'ทองหล่อ', 'เอกมัย', 'สาทร', 'สีลม', 'อโศก', 'พร้อมพงษ์', 'จตุจักร', 'บางรัก', 'พระโขนง', 'อ่อนนุช', 'ลาดพร้าว', 'รามคำแหง', 'บางนา', 'ตลาดพลู', 'เจริญกรุง', 'เยาวราช', 'สะพานควาย', 'พญาไท', 'ราชเทวี', 'ดินแดง', 'ห้วยขวาง', 'รัชดา', 'บางกะปิ', 'บางเขน', 'ดอนเมือง', 'หลักสี่', 'มีนบุรี', 'หนองจอก', 'คลองสาน', 'ธนบุรี', 'บางกอกน้อย', 'บางกอกใหญ่', 'ภาษีเจริญ', 'ตลิ่งชัน', 'บางแค', 'จอมทอง', 'บางขุนเทียน', 'ราษฎร์บูรณะ', 'ทุ่งครุ', 'สวนหลวง', 'ประเวศ', 'คันนายาว', 'บึงกุ่ม', 'วังทองหลาง', 'สายไหม', 'บางซื่อ', 'ดุสิต', 'ป้อมปราบ', 'สัมพันธวงศ์', 'ปทุมวัน', 'วัฒนา', 'คลองเตย'];
  for (var i = 0; i < zones.length; i++) {
    if (address.indexOf(zones[i]) !== -1) return zones[i];
  }
  return 'กรุงเทพฯ';
}

/** ย่อเวลาเปิดร้านให้สั้นลง (เก็บไว้ใช้กับข้อมูลรูปแบบเก่า) */
function compressHours_(days) {
  if (!days || !days.length) return '';
  var times = {};
  var order = [];
  for (var i = 0; i < days.length; i++) {
    var line = String(days[i]);
    var m = line.match(/^(.+?):\s*(.+)$/);
    if (!m) continue;
    var t = m[2].trim();
    if (!times[t]) { times[t] = []; order.push(t); }
    times[t].push(m[1].trim());
  }
  if (order.length === 1) {
    return (order[0].indexOf('ปิด') === 0 ? order[0] : 'ทุกวัน ' + order[0]);
  }
  return days.join(' · ');
}

/** เดาชนิดไฟล์จาก magic bytes (กันลิงก์ที่ดาวน์โหลดได้เป็น HTML) */
function imageType_(b) {
  if (!b || b.length < 12) return '';
  if (b[0] === 0xFF && b[1] === 0xD8) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (String.fromCharCode(b[0], b[1], b[2], b[3]) === 'RIFF' &&
      String.fromCharCode(b[8], b[9], b[10], b[11]) === 'WEBP') return 'webp';
  return '';
}

function isImageBytes_(b) {
  return !!imageType_(b);
}

/** normalize ชื่อร้านเพื่อเทียบ */
function normalize_(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\-_.·'"’()\[\]&,]/g, '')
    .replace(/(คอฟฟี่|coffee|cafe|คาเฟ่|เดอะ|the)/g, '');
}

/** ทดสอบจากเมนู */
function testPlaces() {
  var cfg = getConfig_();
  var out = [];
  try {
    var place = Places.resolve('Nana Coffee Roasters', 'อารีย์', []);
    if (!place) throw new Error('ไม่พบร้าน');
    out.push('ชื่อ: ' + place.name);
    out.push('ที่อยู่: ' + place.address);
    out.push('โซน: ' + place.zone);
    out.push('เวลา: ' + (place.hours || '-'));
    out.push('เว็บ: ' + (place.website || '-'));
    out.push('Place ID: ' + place.placeId);
    out.push('มีรูป: ' + (place.photoRef ? place.photoRef.slice(0, 80) : 'ไม่'));
    if (place.photoRef) {
      var b64 = Places.photoBase64_(cfg, place.photoRef, 400);
      out.push('ดาวน์โหลดรูปได้: ' + (b64 ? (Math.round(b64.length / 1024) + ' KB (base64)') : 'ไม่'));
    }
  } catch (err) {
    out.push('ผิดพลาด: ' + (err && err.message ? err.message : err));
  }
  var msg = out.join('\n');
  log_('INFO', 'TEST', '-', 'testPlaces: ' + msg.replace(/\n/g, ' | '));
  try { SpreadsheetApp.getUi().alert('ทดสอบ Places (OSM)\n\n' + msg); } catch (e) {}
  return msg;
}

/* ---------------------- AI.gs ---------------------- */
/**
 * AI: ห่วงโซ่ผู้ให้บริการ AI ฟรี (Gemini → Groq → Cerebras → OpenRouter → Mistral → GitHub Models)
 * - ถ้าเจ้าหนึ่งหมดโควตา/ล่ม/คีย์ผิด จะพักเจ้าตัวนั้นและส่งงานต่อให้เจ้าถัดไปทันที
 * - จำสถานะไว้ใน Script Properties (AI_COOL_<id>, AI_LAST_OK) เพื่อไม่ต้องลองซ้ำทุกครั้ง
 * - ใช้ร่วมกับ askGemini_() เดิมได้เลย (ชื่อฟังก์ชันคงเดิม)
 */

var AI_PROVIDERS = [
  { id: 'gemini', label: 'Google Gemini', kind: 'gemini',
    keyProp: 'GEMINI_API_KEY', modelProp: 'GEMINI_MODEL', defaultModel: 'gemini-3.8-flash' },
  { id: 'groq', label: 'Groq', kind: 'openai',
    keyProp: 'GROQ_API_KEY', modelProp: 'GROQ_MODEL', defaultModel: 'openai/gpt-oss-120b',
    base: 'https://api.groq.com/openai/v1' },
  { id: 'cerebras', label: 'Cerebras', kind: 'openai',
    keyProp: 'CEREBRAS_API_KEY', modelProp: 'CEREBRAS_MODEL', defaultModel: 'gpt-oss-120b',
    base: 'https://api.cerebras.ai/v1' },
  { id: 'openrouter', label: 'OpenRouter', kind: 'openai',
    keyProp: 'OPENROUTER_API_KEY', modelProp: 'OPENROUTER_MODEL', defaultModel: 'z-ai/glm-4.5-air:free',
    base: 'https://openrouter.ai/api/v1' },
  { id: 'mistral', label: 'Mistral', kind: 'openai',
    keyProp: 'MISTRAL_API_KEY', modelProp: 'MISTRAL_MODEL', defaultModel: 'mistral-small-latest',
    base: 'https://api.mistral.ai/v1' },
  { id: 'github', label: 'GitHub Models', kind: 'openai',
    keyProp: 'GH_MODELS_KEY', modelProp: 'GH_MODELS_MODEL', defaultModel: 'openai/gpt-4.1-mini',
    base: 'https://models.github.ai/inference' }
];

/** ระยะพักของแต่ละอาการ (มิลลิวินาที) */
var AI_COOLDOWN_MS = {
  quota: 30 * 60 * 1000,     // 429 / หมดโควตา
  auth: 6 * 60 * 60 * 1000,  // คีย์ผิด / ไม่มีสิทธิ์
  server: 5 * 60 * 1000,     // 5xx / timeout
  other: 2 * 60 * 1000
};

function aiProps_() { return PropertiesService.getScriptProperties(); }

function aiFind_(id) {
  for (var i = 0; i < AI_PROVIDERS.length; i++) if (AI_PROVIDERS[i].id === id) return AI_PROVIDERS[i];
  return null;
}

function aiKey_(p) { return String(aiProps_().getProperty(p.keyProp) || '').trim(); }

function aiModel_(p) { return String(aiProps_().getProperty(p.modelProp) || p.defaultModel || '').trim(); }

function aiCooldownLeft_(id) {
  var until = Number(aiProps_().getProperty('AI_COOL_' + id) || 0);
  var left = until - Date.now();
  return left > 0 ? left : 0;
}

function aiSetCooldown_(id, ms) {
  aiProps_().setProperty('AI_COOL_' + id, String(Date.now() + ms));
}

/** แยกประเภทความล้มเหลว เพื่อเลือกเวลาพักให้เหมาะ */
function aiClassify_(msg) {
  var m = String(msg || '');
  if (/HTTP\s*(429|402)|quota|rate.?limit|insufficient|exceeded|too many/i.test(m)) return 'quota';
  if (/HTTP\s*(401|403)|unauthorized|invalid.?api.?key|permission|forbidden/i.test(m)) return 'auth';
  if (/HTTP\s*5\d\d|overloaded|unavailable|timeout|timed out|ETIMEDOUT|high demand|HTTP\s*404/i.test(m)) return 'server';
  return 'other';
}

/**
 * เรียก AI ตามลำดับเจ้าที่พร้อมใช้ — คืน { provider, label, model, article }
 * opts.skip = ['groq'] เพื่อข้ามบางเจ้า
 */
function aiGenerate_(prompt, cfg, opts) {
  cfg = cfg || getConfig_();
  opts = opts || {};
  var skip = opts.skip || [];
  var errors = [];
  var last = aiProps_().getProperty('AI_LAST_OK') || '';

  // เจ้าที่เพิ่งใช้ได้ มาก่อน (sticky) เพื่อลดการสลับไปมา
  var order = AI_PROVIDERS.slice().sort(function (a, b) {
    return (a.id === last ? 0 : 1) - (b.id === last ? 0 : 1);
  });

  for (var i = 0; i < order.length; i++) {
    var p = order[i];
    if (skip.indexOf(p.id) !== -1) continue;
    if (!aiKey_(p)) continue;

    var left = aiCooldownLeft_(p.id);
    if (left > 0) {
      errors.push(p.id + ': พักอยู่ ' + Math.ceil(left / 60000) + ' นาที');
      continue;
    }

    try {
      var article = (p.kind === 'gemini')
        ? askGeminiCore_(prompt, cfg)
        : aiOpenAiCompat_(p, prompt, cfg);
      if (!article || !article.body) throw new Error('ได้เนื้อหาว่างจาก ' + p.label);

      aiProps_().setProperty('AI_LAST_OK', p.id);
      aiProps_().setProperty('AI_LAST_AT', String(Date.now()));
      aiProps_().deleteProperty('AI_COOL_' + p.id);
      if (p.id !== 'gemini') {
        log_('INFO', '-', '-', 'AI ใช้ ' + p.label + ' (' + aiModel_(p) + ') แทน Gemini');
      }
      return { provider: p.id, label: p.label, model: aiModel_(p), article: article };
    } catch (err) {
      var msg = String(err && err.message ? err.message : err);
      var kind = aiClassify_(msg);
      aiSetCooldown_(p.id, AI_COOLDOWN_MS[kind] || AI_COOLDOWN_MS.other);
      errors.push(p.id + ' [' + kind + ']: ' + msg.slice(0, 160));
      log_('WARN', '-', '-', 'AI ' + p.label + ' ใช้ไม่ได้ (' + kind + ') → ต่อเจ้าถัดไป: ' + msg.slice(0, 160));
    }
  }

  throw new Error('AI ทุกเจ้าใช้งานไม่ได้ตอนนี้:\n' + errors.join('\n'));
}

/**
 * เรียกผู้ให้บริการแบบ OpenAI-compatible แล้วคืนข้อความ content
 * ใช้ได้ทั้งงานเขียนบทความ (jsonMode=true) และงานช่วยเลือก/linking (jsonMode=false)
 */
function aiChatContent_(p, prompt, cfg, jsonMode) {
  var url = String(p.base).replace(/\/+$/, '') + '/chat/completions';
  var headers = { Authorization: 'Bearer ' + aiKey_(p) };
  if (p.id === 'openrouter') {
    headers['HTTP-Referer'] = 'https://paicafekan.com';
    headers['X-Title'] = 'ไปคาเฟ่กัน';
  }

  function payload(mode) {
    var body = {
      model: aiModel_(p),
      messages: [
        { role: 'system', content: mode ? 'ตอบเป็น JSON อย่างเดียวเท่านั้น ห้ามมีข้อความอื่นนอก JSON' : 'ตอบตามที่ถูกถาม กระชับและไม่แต่งข้อมูล' },
        { role: 'user', content: prompt }
      ],
      temperature: cfg.temperature || 0.8,
      max_tokens: 8192
    };
    if (mode) body.response_format = { type: 'json_object' };
    return body;
  }

  function call(mode) {
    var options = {
      method: 'post',
      contentType: 'application/json',
      headers: headers,
      payload: JSON.stringify(payload(mode)),
      muteHttpExceptions: true
    };
    for (var attempt = 1; attempt <= 2; attempt++) {
      var res = UrlFetchApp.fetch(url, options);
      var code = res.getResponseCode();
      var text = res.getContentText();
      if (code === 200) return text;
      if (code === 429 || code >= 500) { Utilities.sleep(Math.pow(2, attempt) * 1500); continue; }
      if (code === 400 && /response_format/i.test(text) && mode) return { retryNoJson: true };
      throw new Error(p.id + ' HTTP ' + code + ': ' + text.slice(0, 300));
    }
    throw new Error(p.id + ' ล่มติดต่อกัน (429/5xx)');
  }

  var text = call(jsonMode !== false);
  if (text && text.retryNoJson) text = call(false);
  if (!text || typeof text !== 'string') throw new Error(p.id + ' ไม่ตอบกลับ');

  var data = {};
  try { data = JSON.parse(text); } catch (e) { throw new Error('อ่าน response ของ ' + p.label + ' ไม่ได้: ' + text.slice(0, 200)); }
  var raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  if (!raw) throw new Error(p.label + ' คืนข้อความว่าง');
  return String(raw).trim();
}

/** เรียกผู้ให้บริการแบบ OpenAI-compatible (Groq/Cerebras/OpenRouter/Mistral/GitHub Models) */
function aiOpenAiCompat_(p, prompt, cfg) {
  var raw = aiChatContent_(p, prompt, cfg, true);
  var article = parseArticleRaw_(raw);
  article.raw = raw;
  return article;
}

/**
 * ถาม AI แบบข้อความทั่วไป (ไม่ใช่บทความ) — ใช้ห่วงโซ่สำรองเหมือนกัน
 * คืน { provider, label, text }
 */
function aiAskText_(prompt, cfg, opts) {
  cfg = cfg || getConfig_();
  opts = opts || {};
  var skip = opts.skip || [];
  var errors = [];
  var last = aiProps_().getProperty('AI_LAST_OK') || '';
  var order = AI_PROVIDERS.slice().sort(function (a, b) {
    return (a.id === last ? 0 : 1) - (b.id === last ? 0 : 1);
  });

  for (var i = 0; i < order.length; i++) {
    var p = order[i];
    if (skip.indexOf(p.id) !== -1 || !aiKey_(p)) continue;
    var left = aiCooldownLeft_(p.id);
    if (left > 0) { errors.push(p.id + ': พักอยู่ ' + Math.ceil(left / 60000) + ' นาที'); continue; }

    try {
      var text = (p.kind === 'gemini')
        ? askGeminiText_(prompt, cfg)
        : aiChatContent_(p, prompt, cfg, true);
      if (!text) throw new Error('ได้ข้อความว่างจาก ' + p.label);
      aiProps_().deleteProperty('AI_COOL_' + p.id);
      return { provider: p.id, label: p.label, text: text };
    } catch (err) {
      var msg = String(err && err.message ? err.message : err);
      var kind = aiClassify_(msg);
      aiSetCooldown_(p.id, AI_COOLDOWN_MS[kind] || AI_COOLDOWN_MS.other);
      errors.push(p.id + ' [' + kind + ']: ' + msg.slice(0, 160));
      log_('WARN', '-', '-', 'AI ' + p.label + ' (งานลิงก์รูป) ใช้ไม่ได้ → ต่อเจ้าถัดไป: ' + msg.slice(0, 160));
    }
  }
  throw new Error('AI ทุกเจ้าใช้ไม่ได้ตอนนี้ (งานลิงก์รูป):\n' + errors.join('\n'));
}

/** ADMIN: ดูสถานะ AI ทุกเจ้าว่าพร้อมใช้/พักอยู่/ยังไม่มีคีย์ */
function aiStatus() {
  var lastOk = aiProps_().getProperty('AI_LAST_OK') || '-';
  var rows = AI_PROVIDERS.map(function (p) {
    var key = aiKey_(p);
    var left = aiCooldownLeft_(p.id);
    return {
      id: p.id,
      label: p.label,
      model: aiModel_(p),
      key: key ? (key.slice(0, 6) + '…' + key.slice(-4)) : '— ไม่มี —',
      ready: !!key && left === 0,
      cooldownMin: left ? Math.ceil(left / 60000) : 0
    };
  });
  log_('INFO', '-', '-', 'AI STATUS ' + JSON.stringify({ lastOk: lastOk, rows: rows }));
  return { lastOk: lastOk, providers: rows };
}

/** ADMIN: ทดสอบยิงทุกเจ้าที่ยังมีคีย์ (ใช้ prompt สั้น ๆ) */
function aiTestAll() {
  var out = [];
  AI_PROVIDERS.forEach(function (p) {
    if (!aiKey_(p)) { out.push(p.id + ': ไม่มีคีย์'); return; }
    try {
      var r = (p.kind === 'gemini')
        ? askGeminiCore_('ตอบ JSON: {"title":"ทดสอบ","body":"สวัสดี"}', getConfig_())
        : aiOpenAiCompat_(p, 'ตอบ JSON: {"title":"ทดสอบ","body":"สวัสดี"}', getConfig_());
      aiProps_().deleteProperty('AI_COOL_' + p.id);
      out.push(p.id + ': OK — ' + String(r.body || '').slice(0, 40));
    } catch (e) {
      out.push(p.id + ': FAIL — ' + String(e.message || e).slice(0, 120));
    }
  });
  log_('INFO', '-', '-', 'AI TEST ' + out.join(' | '));
  return out;
}

/** ADMIN: ล้างสถานะพักทั้งหมด (ใช้เมื่อเพิ่งเติมโควตา/เปลี่ยนคีย์) */
function aiResetCooldowns() {
  var props = aiProps_();
  AI_PROVIDERS.forEach(function (p) { props.deleteProperty('AI_COOL_' + p.id); });
  props.deleteProperty('AI_LAST_OK');
  log_('INFO', '-', '-', 'AI RESET cooldowns');
  return 'ล้างสถานะพักของ AI ทุกเจ้าแล้ว';
}

/** ADMIN: ตั้งคีย์ของผู้ให้บริการ (เรียกจาก editor) */
function aiSetKey(provider, key) {
  var p = aiFind_(provider);
  if (!p) throw new Error('ไม่รู้จักผู้ให้บริการ: ' + provider);
  aiProps_().setProperty(p.keyProp, String(key || '').trim());
  aiProps_().deleteProperty('AI_COOL_' + p.id);
  log_('INFO', '-', '-', 'ตั้งคีย์ AI ' + p.id + ' แล้ว');
  return 'บันทึก ' + p.keyProp + ' แล้ว';
}

/** ADMIN: ตั้งโมเดลของผู้ให้บริการ */
function aiSetModel(provider, model) {
  var p = aiFind_(provider);
  if (!p) throw new Error('ไม่รู้จักผู้ให้บริการ: ' + provider);
  aiProps_().setProperty(p.modelProp, String(model || '').trim());
  return 'ตั้ง ' + p.modelProp + ' = ' + model;
}

/**
 * งานยาวที่ควรมีคนช่วยทำต่อ: สรุปสถานะปัจจุบันไว้ใน Log
 * ให้ AI/คนถัดไปอ่านแล้วทำงานต่อได้ทันที (ส่งทอดงาน)
 */
function aiHandoff() {
  var cfg = getConfig_();
  var sheet = getSheet_(cfg.sheetName);
  var last = sheet.getLastRow();
  var rows = last > 1 ? sheet.getRange(2, 1, last - 1, 7).getValues() : [];
  var count = { total: rows.length, draft: 0, scheduled: 0, published: 0, other: 0 };
  var next = [];
  rows.forEach(function (r, i) {
    var st = String(r[2] || '').toLowerCase();
    if (st === 'published') count.published++;
    else if (st === 'scheduled') { count.scheduled++; if (next.length < 5) next.push((i + 2) + ':' + r[0]); }
    else if (st === 'draft' || st === 'ready' || st === 'approved') count.draft++;
    else count.other++;
  });
  var status = aiStatus();
  var report = {
    at: new Date().toISOString(),
    sheetRows: count,
    nextScheduled: next,
    aiLastOk: status.lastOk,
    aiProviders: status.providers.map(function (p) { return p.id + '=' + (p.ready ? 'ready' : (p.cooldownMin ? 'cool' + p.cooldownMin + 'm' : 'nokey')); }),
    queue: (function () { try { return readQueue_().length; } catch (e) { return 'n/a'; } })()
  };
  log_('INFO', '-', '-', 'HANDOFF ' + JSON.stringify(report));
  return report;
}

/** เมนูชีต: แสดงสถานะ AI (ค่ายไหนพร้อม / พักอยู่ / ยังไม่มีคีย์) */
function showAiStatus() {
  var st = aiStatus();
  var lines = st.providers.map(function (p) {
    var state = p.ready ? 'พร้อมใช้' : (p.cooldownMin ? 'พักอีก ' + p.cooldownMin + ' นาที' : 'ยังไม่มีคีย์');
    return p.label + ' (' + p.model + ') — ' + state;
  });
  var msg = [
    'ค่ายที่ใช้ล่าสุด: ' + st.lastOk,
    '',
    lines.join('\n'),
    '',
    'ลำดับสำรอง: Gemini → Groq → Cerebras → OpenRouter → Mistral → GitHub Models',
    'ถ้าค่ายหนึ่งหมดโควตา ระบบจะพักค่ายนั้นแล้วส่งงานต่อให้ค่ายถัดไปอัตโนมัติ'
  ].join('\n');
  try {
    SpreadsheetApp.getUi().alert('สถานะ AI · โควตา/ค่ายสำรอง', msg, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    log_('INFO', '-', '-', 'AI STATUS UI ไม่ได้ (รันจาก editor): ' + msg.replace(/\n/g, ' | '));
  }
  return st;
}

/* ---------------------- Gemini.gs ---------------------- */
/**
 * Gemini: สร้างพรอมป์ต + เรียก API + แปลงผลลัพธ์
 */

/**
 * สร้างพรอมป์ตรีวิวคาเฟ่ภาษาไทย (ใช้ข้อมูลจริงจาก OpenStreetMap)
 * @param {string} name ชื่อร้าน
 * @param {string} zone โซน
 * @param {Object} place ข้อมูลร้านจาก Places
 * @param {string[]} avoidTitles ชื่อบทความล่าสุด (กันมุมซ้ำ)
 */
function buildPrompt_(name, zone, place, avoidTitles) {
  var zoneText = zone || (place && place.zone) || 'กรุงเทพฯ';
  var p = place || {};
  var avoid = (avoidTitles || []).filter(Boolean).slice(-10);

  var facts = [
    '- ชื่อร้าน: ' + name,
    '- โซน: ' + zoneText + ' กรุงเทพมหานคร',
    p.address ? '- ที่อยู่: ' + p.address : '',
    p.hours ? '- เวลาเปิด-ปิด: ' + p.hours : '',
    p.rating ? '- คะแนนรีวิว: ' + p.rating + (p.ratingCount ? ' (' + p.ratingCount + ' รีวิว)' : '') : '',
    p.summary ? '- ข้อมูลเพิ่มเติมจากแผนที่: ' + p.summary : ''
  ].filter(Boolean).join('\n');

  return [
    'คุณคือนักเขียนคอนเทนต์คาเฟ่และนัก SEO มืออาชีพของเว็บ "ไปคาเฟ่กัน" (paicafekan.com)',
    'เป้าหมาย: เขียนรีวิวภาษาไทยที่คนค้นเจอใน Google และ "อยากคลิกอ่าน" มากที่สุด โดยไม่กล่าวอ้างเกินจริง',
    '',
    'ข้อมูลร้าน (ข้อมูลจริง ห้ามเปลี่ยนแปลงหรือแต่งเพิ่ม):',
    facts,
    '',
    avoid.length ? 'ชื่อบทความล่าสุดที่ห้ามเขียนซ้ำมุม/โครงเดิม:' : '',
    avoid.map(function (t) { return '- ' + t; }).join('\n'),
    '',
    'ข้อกำหนดด้าน SEO และ CTR:',
    '1. title: ยาว 45–65 ตัวอักษร ใส่ชื่อร้าน + ย่านไว้ใน 30 ตัวอักษรแรก และมีจุดขายที่จับต้องได้ 1 อย่าง (เมนู บรรยากาศ ทำเล ราคา)',
    '   - ห้ามขึ้นต้นด้วย "ดื่มด่ำ" และห้ามใช้คำว่า "รีวิว" ใน title',
    '   - ห้ามใช้ตัวพิมพ์ใหญ่ทั้งประโยค อีโมจิ หรือคำเกินจริงแบบ clickbait',
    '   - ให้สลับโครงสร้าง เช่น "[ชื่อร้าน] คาเฟ่[จุดเด่น]ย่าน[โซน] ที่[เหตุผลน่าไป]" หรือ "[จุดเด่น]กลาง[โซน] ที่ [ชื่อร้าน]"',
    '   - ตัวอย่าง: "Sarnies คาเฟ่ตึกเก่าสไตล์สิงคโปร์ย่านเจริญกรุง บรันช์แน่น กาแฟเข้ม"',
    '2. metaDescription: ยาว 120–155 ตัวอักษร มีคำค้น "คาเฟ่' + zoneText + '" และชื่อร้าน บอกประโยชน์ 1 อย่าง แล้วปิดด้วยคำชวนอ่าน',
    '3. excerpt: 1–2 ประโยค ไม่เกิน 160 ตัวอักษร ใช้แสดงบนการ์ดหน้าแรก — ต้องอ่านแล้วอยากกด',
    '4. body: 800–1,100 คำ ใช้ Markdown',
    '   - ย่อหน้าแรก 2–3 ประโยค ตอบทันทีว่าร้านนี้เหมาะกับใครและจุดเด่นที่สุดคืออะไร พร้อมคำค้น "คาเฟ่' + zoneText + '" ใน 120 ตัวอักษรแรก',
    '   - ใช้ ## หัวข้อ 6 หัวข้อตามลำดับนี้เท่านั้น: ภาพรวมร้าน, บรรยากาศและการตกแต่ง, เมนูและรสชาติ, ราคาและความคุ้มค่า, การเดินทางและที่จอดรถ, สรุปน่าลองไหม',
    '   - ใต้ "ภาพรวมร้าน" ใส่รายการ - จุดเด่น 3 ข้อ ที่อ่านแล้วอยากไป (สั้น กระชับ)',
    '   - กระจายคำค้นธรรมชาติ เช่น ชื่อร้าน, "คาเฟ่' + zoneText + '", "คาเฟ่บรรยากาศดีกรุงเทพ" อย่างละ 1–2 ครั้ง ไม่ยัดคำ',
    '   - ประโยคสั้น อ่านง่าย ไม่เกิน 25 คำต่อประโยค ใช้ **ตัวหนา** เฉพาะคำสำคัญ',
    '   - ห้ามแต่งเบอร์โทร เลขที่บ้าน ราคาเมนูที่แน่นอน หรือเมนูที่ไม่มีข้อมูล ให้ใช้ถ้อยคำกว้าง ๆ เช่น "หลักสิบถึงหลักร้อยต้น ๆ"',
    '   - ห้ามระบุชื่อสถานีรถไฟฟ้า/รถไฟใต้ดิน สายสี หมายเลขทางออก จำนวนที่จอดรถ โปรโมชั่น หรือส่วนลด เว้นแต่มีในข้อมูลร้าน',
    '   - หัวข้อ "ราคาและความคุ้มค่า" ให้พูดเชิงภาพรวมเท่านั้น ห้ามใส่ตัวเลขราคาเป็นตัวเลข',
    '   - หัวข้อ "การเดินทางและที่จอดรถ" ให้อ้างอิงที่อยู่จริงจากข้อมูลร้าน และแนะนำให้ตรวจเส้นทาง/จุดจอดผ่าน Google Maps',
    '   - ห้ามอ้างว่า "เราไปลองมาเอง" หรือให้คะแนนดาว',
    '   - ปิดท้ายด้วยคำถามชวนคอมเมนต์ 1 ประโยค',
    '5. faq: 3 คำถามที่คนค้น Google บ่อยเกี่ยวกับร้าน/ย่านนี้ พร้อมคำตอบ 2–3 ประโยค',
    '   - ตอบจากข้อมูลจริงเท่านั้น ถ้าข้อมูลไม่พอให้ตอบเชิงแนะนำทั่วไปโดยไม่เดารายละเอียดร้าน',
    '   - ใช้ทำ FAQ Rich Snippet ห้ามใส่ faq ซ้ำใน body',
    '6. tags: 4–5 คำ ขึ้นต้นด้วย # และเกี่ยวข้องกับโซนหรือคอนเซปต์ของร้าน',
    '',
    'ตอบกลับเป็น JSON ตาม schema เท่านั้น ห้ามมีข้อความอื่นนอก JSON',
    'body คือเนื้อหาทั้งหมดในรูปแบบ Markdown (ห้ามมีชื่อร้านซ้ำเป็น H1 เพราะเว็บใส่ให้แล้ว)'
  ].join('\n');
}

/**
 * ตัวเรียก AI หลัก: ใช้ห่วงโซ่ AI.gs (Gemini → Groq → Cerebras → OpenRouter → Mistral → GitHub Models)
 * ถ้าเจ้าหนึ่งหมดโควตา/ล่ม จะสลับเจ้าถัดไปให้อัตโนมัติ
 */
function askGemini_(prompt, cfg) {
  return aiGenerate_(prompt, cfg || getConfig_()).article;
}

/** เรียก Gemini API พร้อม retry เมื่อโดน rate limit / server error */
function askGeminiCore_(prompt, cfg) {
  if (!cfg.apiKey) {
    throw new Error('ยังไม่ได้ตั้งค่า GEMINI_API_KEY (Project Settings > Script Properties)');
  }

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + encodeURIComponent(cfg.model) + ':generateContent?key=' + encodeURIComponent(cfg.apiKey);

  var payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: cfg.temperature,
      maxOutputTokens: 16384,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          metaDescription: { type: 'STRING' },
          excerpt: { type: 'STRING' },
          body: { type: 'STRING' },
          tags: { type: 'ARRAY', items: { type: 'STRING' } },
          faq: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                question: { type: 'STRING' },
                answer: { type: 'STRING' }
              },
              required: ['question', 'answer']
            }
          }
        },
        required: ['title', 'body']
      }
    }
  };

  // ควบคุมโควตาความคิดของโมเดล (ตั้งผ่าน GEMINI_THINKING_BUDGET ได้)
  // 0 = ปิดความคิด (เร็ว/ถูก), ไม่ตั้ง = ใช้ค่าเริ่มต้นของโมเดล
  if (cfg.thinkingBudget !== null && cfg.thinkingBudget !== '' && cfg.thinkingBudget !== undefined) {
    payload.generationConfig.thinkingConfig = { thinkingBudget: cfg.thinkingBudget };
  }

  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var lastError = '';
  for (var attempt = 1; attempt <= 1; attempt++) {
    var res = UrlFetchApp.fetch(url, options);
    var code = res.getResponseCode();
    var text = res.getContentText();

    if (code === 200) {
      return parseGeminiResponse_(text);
    }

    lastError = 'Gemini HTTP ' + code + ': ' + text.slice(0, 500);

    // 5xx = ฝั่ง Google ขัดข้อง -> รอแล้วลองใหม่
    if (code === 429 || code === 500 || code === 503) {
      Utilities.sleep(Math.pow(2, attempt) * 1500);
      continue;
    }
    throw new Error(lastError);
  }

  throw new Error('เรียก Gemini ไม่สำเร็จหลังลอง 4 ครั้ง — ' + lastError);
}

/**
 * เรียก Gemini แบบข้อความทั่วไป (ไม่บังคับ responseSchema)
 * ใช้กับงานช่วยเลือกลิงก์รูป / วิเคราะห์ข้อมูล ที่ไม่ใช่บทความ
 */
function askGeminiText_(prompt, cfg) {
  if (!cfg.apiKey) throw new Error('ยังไม่ได้ตั้งค่า GEMINI_API_KEY (Project Settings > Script Properties)');
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + encodeURIComponent(cfg.model) + ':generateContent?key=' + encodeURIComponent(cfg.apiKey);
  var payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: cfg.temperature || 0.4,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json'
    }
  };
  if (cfg.thinkingBudget !== null && cfg.thinkingBudget !== '' && cfg.thinkingBudget !== undefined) {
    payload.generationConfig.thinkingConfig = { thinkingBudget: cfg.thinkingBudget };
  }
  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  var res = UrlFetchApp.fetch(url, options);
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code !== 200) throw new Error('Gemini text HTTP ' + code + ': ' + text.slice(0, 400));
  var json;
  try { json = JSON.parse(text); } catch (e) { throw new Error('อ่าน response ของ Gemini ไม่ได้: ' + text.slice(0, 300)); }
  var candidate = (json.candidates && json.candidates[0]) || null;
  if (!candidate || !candidate.content || !candidate.content.parts) {
    throw new Error('Gemini ไม่คืนเนื้อหา (blockReason: ' + ((json.promptFeedback && json.promptFeedback.blockReason) || 'ไม่ทราบสาเหตุ') + ')');
  }
  var raw = candidate.content.parts.map(function (p) { return p.text || ''; }).join('').trim();
  if (!raw) throw new Error('Gemini คืนข้อความว่าง');
  return raw;
}

/** ดึงข้อความจาก response แล้ว parse JSON (มี fallback) */
function parseGeminiResponse_(responseText) {
  var json;
  try {
    json = JSON.parse(responseText);
  } catch (e) {
    throw new Error('อ่าน response ของ Gemini ไม่ได้: ' + responseText.slice(0, 300));
  }

  var candidate = (json.candidates && json.candidates[0]) || null;
  if (!candidate || !candidate.content || !candidate.content.parts) {
    var reason = (json.promptFeedback && json.promptFeedback.blockReason) || 'ไม่ทราบสาเหตุ';
    throw new Error('Gemini ไม่คืนเนื้อหา (blockReason: ' + reason + ')');
  }

  var raw = candidate.content.parts.map(function (p) { return p.text || ''; }).join('').trim();
  if (!raw) throw new Error('Gemini คืนข้อความว่าง');

  var data = parseArticleRaw_(raw);

  return {
    title: String(data.title || '').trim(),
    metaDescription: String(data.metaDescription || '').trim(),
    excerpt: String(data.excerpt || '').trim(),
    body: String(data.body || '').trim(),
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    faq: normalizeFaq_(data.faq),
    raw: raw
  };
}

/** แปลง raw (ข้อความ JSON ดิบจาก Gemini หรือ Groq) เป็น object ที่ใช้ต่อได้ */
function parseArticleRaw_(raw) {
  var data = null;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    var match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { data = JSON.parse(match[0]); } catch (e2) { data = null; }
    }
  }

  if (!data || !data.body) {
    data = {
      title: '',
      metaDescription: '',
      excerpt: '',
      body: raw,
      tags: []
    };
  }

  // Groq/Gemini ตอบ tags มาเป็นสตริงได้ — บังคับให้เป็น array
  if (!Array.isArray(data.tags)) {
    data.tags = typeof data.tags === 'string'
      ? data.tags.split(/[,\s]+/).map(function (s) { return s.trim(); }).filter(Boolean)
      : [];
  }
  if (data.tags.length > 12) data.tags = data.tags.slice(0, 12);

  data.title = String(data.title || '');
  data.body = String(data.body || '');
  data.metaDescription = String(data.metaDescription || '');
  data.excerpt = String(data.excerpt || '');
  data.tags = data.tags.map(String);
  data.faq = normalizeFaq_(data.faq);

  return data;
}

/**
 * แทนที่เฉพาะข้อมูลที่ AI ชอบแต่งเกินจริง (ราคาเป็นตัวเลข, ชื่อสถานี/สายสี, จำนวนที่จอด,
 * โปรโมชั่น/ส่วนลด) แล้วแทนสองหัวข้อที่เสี่ยงที่สุดด้วยข้อความที่อ้างข้อมูลร้านจริงเท่านั้น
 */
function sanitizeArticleBody_(body, place, zone) {
  var t = String(body || '');
  var p = place || {};
  var zoneText = zone || p.zone || 'กรุงเทพฯ';
  var RISK = /(\d+\s*[-–‑]\s*\d+\s*บาท|\d+\s*บาท|โปรโมชั่น|ส่วนลดพิเศษ|ส่วนลดสำหรับ|สายสี|สถานีรถไฟฟ้า|สถานี\s*(?:BTS|MRT)|\bBTS\b|\bMRT\b|ที่จอดรถ(?:ยนต์)?(?:ส่วนตัว)?\s*\d|\d+\s*คัน|โทร\.?\s*0\d|0\d{1,2}\s*[-–]\s*\d{3}\s*[-–]?\s*\d{3,4})/;

  var pricePara = 'ราคาเครื่องดื่มอยู่ในระดับมาตรฐานของคาเฟ่ย่าน' + zoneText +
    ' สอบถามราคาและเมนูประจำวันได้ที่ร้านโดยตรง';
  var travelPara = (p.address ? 'ที่ตั้ง: ' + p.address + ' ' : '') +
    'แนะนำเปิดเส้นทางและจุดจอดรถผ่าน Google Maps ตามลิงก์ในข้อมูลร้านก่อนออกเดินทาง';

  function replaceSection(text, heading, replacement) {
    var re = new RegExp('(##\\s*' + heading + '\\s*\\n)([\\s\\S]*?)(?=\\n##\\s|$)');
    return re.test(text) ? text.replace(re, '$1' + replacement + '\n') : text;
  }

  t = replaceSection(t, 'ราคาและความคุ้มค่า', pricePara);
  t = replaceSection(t, 'การเดินทางและที่จอดรถ', travelPara);

  // ตัดประโยคที่ยังเสี่ยงในหัวข้ออื่น (แยกด้วย . ! ? หรือขึ้นบรรทัดใหม่)
  var lines = t.split('\n').map(function (line) {
    if (/^##/.test(line)) return line;
    if (!RISK.test(line)) return line;
    var sentences = line.split(/(?<=[.!?])\s+/);
    var kept = sentences.filter(function (s) { return !RISK.test(s); });
    return kept.join(' ').trim();
  }).filter(function (l) { return l !== ''; });

  // ตัดหัวข้อที่เนื้อหาถูกตัดออกหมด (กันหน้าว่าง/หัวข้อลอย)
  var cleaned = [];
  for (var i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      var next = lines[i + 1];
      if (!next || /^##\s/.test(next)) continue;
    }
    cleaned.push(lines[i]);
  }

  return cleaned.join('\n');
}

/** FAQ สำรอง: สร้างจากข้อมูลร้านจริง (ที่อยู่/เวลาเปิด) ไม่เดาราคาหรือเมนู */
function fallbackFaq_(name, zone, place) {
  var p = place || {};
  var zoneText = zone || p.zone || 'กรุงเทพฯ';
  var faq = [];

  if (p.address) {
    faq.push({ question: name + ' อยู่ที่ไหน?', answer: name + ' ตั้งอยู่ที่ ' + p.address });
  }
  if (p.hours && /:/.test(p.hours)) {
    faq.push({ question: name + ' เปิดกี่โมง?', answer: 'เวลาเปิด-ปิดของร้านคือ ' + p.hours + ' แนะนำเช็กอีกครั้งผ่าน Google Maps ก่อนออกเดินทาง' });
  } else {
    faq.push({ question: 'ควรเช็กเวลาเปิด-ปิดก่อนไปไหม?', answer: 'แนะนำตรวจสอบเวลาเปิด-ปิดล่าสุดผ่าน Google Maps หรือช่องทางออนไลน์ของร้านก่อนเดินทาง' });
  }
  faq.push({
    question: 'คาเฟ่ย่าน' + zoneText + ' ร้านนี้เหมาะกับใคร?',
    answer: 'เหมาะกับคนที่มองหาคาเฟ่ย่าน' + zoneText + ' สำหรับนั่งพักจิบกาแฟ ทำงานเบา ๆ หรือคุยกับเพื่อน'
  });
  if (faq.length < 3) {
    faq.push({ question: 'มีเมนูอะไรให้ลองบ้าง?', answer: 'เมนูกาแฟและเครื่องดื่มตามที่ร้านจัดจำหน่าย สอบถามเมนูแนะนำได้ที่บาริสต้า' });
  }
  return normalizeFaq_(faq).slice(0, 3);
}

/** เติม FAQ ให้ครบ 3 ข้อ โดยไม่ทับข้อที่ AI ตอบมาดีแล้ว */
function ensureFaq_(article, name, zone, place) {
  if (!article.faq) article.faq = [];
  if (article.faq.length >= 3) return article;
  var fb = fallbackFaq_(name, zone, place);
  var have = article.faq.map(function (f) { return String(f.question || ''); });
  fb.forEach(function (f) {
    if (article.faq.length >= 3) return;
    if (have.indexOf(f.question) === -1) {
      article.faq.push(f);
      have.push(f.question);
    }
  });
  return article;
}

/** ทำความสะอาด FAQ: ตัดช่องว่างเกิน, จำกัดความยาว, เอาเฉพาะที่มีคำถาม+คำตอบ */
function normalizeFaq_(faq) {
  if (!Array.isArray(faq)) return [];
  return faq.map(function (f) {
    if (!f) return null;
    var q = String(f.question || f.q || '').replace(/\s+/g, ' ').trim();
    var a = String(f.answer || f.a || '').replace(/\s+/g, ' ').trim();
    if (!q || !a) return null;
    if (q.length > 120) {
      q = q.slice(0, 117).replace(/\s+\S*$/, '');
    }
    if (!/[?？]$/.test(q)) q += '?';
    if (a.length > 420) {
      a = a.slice(0, 417).replace(/\s+\S*$/, '') + '…';
    }
    return { question: q, answer: a };
  }).filter(Boolean).slice(0, 4);
}

/** ปรับ title/description ให้อยู่ในเกณฑ์ SEO และกันคำต้องห้ามขึ้นต้น */
function normalizeArticleSeo_(article, name, zone) {
  var a = article || {};
  var zoneText = zone || 'กรุงเทพฯ';

  var title = String(a.title || '').replace(/\s+/g, ' ').trim();
  title = title.replace(/^["“”'‘’]+|["“”'‘’]+$/g, '').trim();
  title = title.replace(/^(?:ดื่มด่ำ(?:กับ|ไปกับ)?|รีวิว)\s*/i, '').trim();
  if (title.length > 78) {
    var cut = title.slice(0, 78);
    var sp = cut.lastIndexOf(' ');
    if (sp > 45) cut = cut.slice(0, sp);
    title = cut.replace(/[\s,;:–—-]+$/, '');
  }
  if (!title) title = name;

  var md = String(a.metaDescription || '').replace(/\s+/g, ' ').trim();
  var ex = String(a.excerpt || '').replace(/\s+/g, ' ').trim();
  if (!md) md = ex;
  if (md.length < 80) {
    md = ('คาเฟ่' + zoneText + ' ' + name + ' — ' + md).replace(/\s+/g, ' ').trim();
  }
  if (md.length > 158) {
    md = md.slice(0, 155);
    var sp2 = md.lastIndexOf(' ');
    if (sp2 > 100) md = md.slice(0, sp2);
    md = md.replace(/[\s,;:–—-]+$/, '') + '…';
  }
  if (!md) {
    md = 'คาเฟ่' + zoneText + ' ' + name + ' — บรรยากาศดี กาแฟมีคุณภาพ พร้อมที่ตั้ง เวลาเปิด และแผนที่';
  }

  if (ex.length > 160) ex = ex.slice(0, 157).replace(/\s+\S*$/, '') + '…';
  if (!ex) ex = md;

  a.title = title;
  a.metaDescription = md;
  a.excerpt = ex;
  a.faq = normalizeFaq_(a.faq);
  return a;
}

/** เรียก Groq API (OpenAI-compatible) เป็นทางสำรอง */
function askGroq_(prompt, cfg) {
  var url = 'https://api.groq.com/openai/v1/chat/completions';
  var payload = {
    model: cfg.groqModel || 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: 'ตอบเป็น JSON อย่างเดียวเท่านั้น ห้ามมีข้อความอื่นนอก JSON' },
      { role: 'user', content: prompt }
    ],
    temperature: cfg.temperature || 0.8,
    max_tokens: 8192,
    response_format: { type: 'json_object' }
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg.groqKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  for (var attempt = 1; attempt <= 3; attempt++) {
    var res = UrlFetchApp.fetch(url, options);
    var code = res.getResponseCode();
    var text = res.getContentText();

    if (code === 200) {
      var data = {};
      try { data = JSON.parse(text); } catch (e) { throw new Error('อ่าน response ของ Groq ไม่ได้: ' + text.slice(0, 200)); }
      var raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      if (!raw) throw new Error('Groq คืนข้อความว่าง');
      raw = raw.trim();
      var article = parseArticleRaw_(raw);
      article.raw = raw;
      return article;
    }

    if (code === 429 || code >= 500) {
      Utilities.sleep(Math.pow(2, attempt) * 2500);
      continue;
    }
    throw new Error('Groq HTTP ' + code + ': ' + text.slice(0, 300));
  }

  throw new Error('Groq ล่มติดต่อกัน — ลองใหม่ภายหลัง');
}

/** ADMIN: ทดสอบ Groq โดยเฉพาะ ( ?run=testGroq ) */
function testGroq() {
  var cfg = getConfig_();
  if (!cfg.groqKey) return 'ยังไม่มี GROQ_API_KEY — เพิ่มใน Project Settings > Script Properties';
  try {
    var out = askGroq_('ตอบ JSON: {"title":"ทดสอบ","body":"สวัสดี"}', cfg);
    return 'Groq ใช้งานได้ ✔ — ' + out.body.slice(0, 120);
  } catch (err) {
    return 'Groq ใช้งานไม่ได้ ✖ — ' + err.message;
  }
}

/** ADMIN: ดูว่า Groq key นี้ใช้โมเดลไหนได้บ้าง */
function listGroqModels() {
  var cfg = getConfig_();
  if (!cfg.groqKey) return { error: 'no GROQ_API_KEY' };
  try {
    var res = UrlFetchApp.fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: 'Bearer ' + cfg.groqKey },
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    var data = {};
    try { data = JSON.parse(res.getContentText()); } catch (e) {}
    if (code !== 200) return { error: 'HTTP ' + code, body: String(res.getContentText()).slice(0, 300) };
    var models = (data.data || []).map(function (m) { return m.id; });
    return { ok: true, current: cfg.groqModel, count: models.length, models: models };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

/** ADMIN: สลับโมเดล Groq เป็น openai/gpt-oss-120b */
function setGroqModelGptOss120() {
  PropertiesService.getScriptProperties().setProperty('GROQ_MODEL', 'openai/gpt-oss-120b');
  return { ok: true, model: 'openai/gpt-oss-120b' };
}

/** ADMIN: สลับโมเดล Groq เป็น openai/gpt-oss-20b */
function setGroqModelGptOss20() {
  PropertiesService.getScriptProperties().setProperty('GROQ_MODEL', 'openai/gpt-oss-20b');
  return { ok: true, model: 'openai/gpt-oss-20b' };
}

/** ADMIN: สลับโมเดล Groq เป็น llama-3.1-8b-instant */
function setGroqModelLlama31Instant() {
  PropertiesService.getScriptProperties().setProperty('GROQ_MODEL', 'llama-3.1-8b-instant');
  return { ok: true, model: 'llama-3.1-8b-instant' };
}

/** ทดสอบการเชื่อมต่อ Gemini จากเมนู */
function testGemini() {
  var cfg = getConfig_();
  try {
    var out = askGemini_('ตอบ JSON: {"title":"ทดสอบ","body":"สวัสดี"}', cfg);
    return 'Gemini ใช้งานได้ ✔ — ' + out.body.slice(0, 120);
  } catch (err) {
    return 'Gemini ใช้งานไม่ได้ ✖ — ' + err.message;
  }
}

/** ADMIN: ดูรายการโมเดลที่ API key นี้เข้าถึงได้ ( ?run=listGeminiModels ) */
function listGeminiModels() {
  var cfg = getConfig_();
  if (!cfg.apiKey) return { error: 'no API key' };
  try {
    var res = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(cfg.apiKey),
      { muteHttpExceptions: true }
    );
    var code = res.getResponseCode();
    var data = {};
    try { data = JSON.parse(res.getContentText()); } catch (e) {}
    if (code !== 200) return { error: 'HTTP ' + code, body: String(res.getContentText()).slice(0, 300) };
    var models = (data.models || []).map(function (m) { return (m.name || '').replace(/^models\//, ''); });
    return { ok: true, current: cfg.model, count: models.length, models: models };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

/** ADMIN: สลับเป็น gemini-2.5-flash ( ?run=setModelGemini25Flash ) */
function setModelGemini25Flash() {
  PropertiesService.getScriptProperties().setProperty('GEMINI_MODEL', 'gemini-2.5-flash');
  return { ok: true, model: 'gemini-2.5-flash' };
}

/** ADMIN: สลับเป็น gemini-2.5-flash-lite ( ?run=setModelGemini25FlashLite ) */
function setModelGemini25FlashLite() {
  PropertiesService.getScriptProperties().setProperty('GEMINI_MODEL', 'gemini-2.5-flash-lite');
  return { ok: true, model: 'gemini-2.5-flash-lite' };
}

/** ADMIN: สลับกลับเป็น gemini-3.8-flash ( ?run=setModelDefault ) */
function setModelDefault() {
  PropertiesService.getScriptProperties().deleteProperty('GEMINI_MODEL');
  return { ok: true, model: 'gemini-3.8-flash' };
}

/** ADMIN: สลับเป็น gemini-3.5-flash ( ?run=setModel35Flash ) */
function setModel35Flash() {
  PropertiesService.getScriptProperties().setProperty('GEMINI_MODEL', 'gemini-3.5-flash');
  return { ok: true, model: 'gemini-3.5-flash' };
}

/** ADMIN: สลับเป็น gemini-3.5-flash-lite ( ?run=setModel35FlashLite ) */
function setModel35FlashLite() {
  PropertiesService.getScriptProperties().setProperty('GEMINI_MODEL', 'gemini-3.5-flash-lite');
  return { ok: true, model: 'gemini-3.5-flash-lite' };
}

/** ADMIN: สลับเป็น gemini-3.6-flash ( ?run=setModel36Flash ) */
function setModel36Flash() {
  PropertiesService.getScriptProperties().setProperty('GEMINI_MODEL', 'gemini-3.6-flash');
  return { ok: true, model: 'gemini-3.6-flash' };
}

/** ADMIN: สลับเป็น gemini-3.7-flash ( ?run=setModel37Flash ) */
function setModel37Flash() {
  PropertiesService.getScriptProperties().setProperty('GEMINI_MODEL', 'gemini-3.7-flash');
  return { ok: true, model: 'gemini-3.7-flash' };
}

/** ADMIN: สลับเป็น gemini-3-flash-preview ( ?run=setModel3FlashPreview ) */
function setModel3FlashPreview() {
  PropertiesService.getScriptProperties().setProperty('GEMINI_MODEL', 'gemini-3-flash-preview');
  return { ok: true, model: 'gemini-3-flash-preview' };
}

/* ---------------------- Docs.gs ---------------------- */
/**
 * Google Docs: สร้างร่างบทความ + จัดรูปแบบจาก Markdown อย่างง่าย
 */

/**
 * สร้าง Google Doc ร่างบทความ
 * @return {{id:string, url:string, title:string}}
 */
function createDraftDoc_(name, zone, article, cfg) {
  var now = new Date();
  var stamp = Utilities.formatDate(now, 'Asia/Bangkok', 'yyyy-MM-dd');
  var docTitle = cfg.titlePrefix + name + (zone ? ' — ' + zone : '') + ' (' + stamp + ')';

  var doc = DocumentApp.create(docTitle);
  var body = doc.getBody();
  body.clear();

  // หัวเรื่อง
  var titlePara = body.appendParagraph(article.title || name);
  titlePara.setHeading(DocumentApp.ParagraphHeading.TITLE);

  // แถบข้อมูลกำกับ (ช่วยตอนตรวจ)
  var meta = body.appendParagraph(
    'โซน: ' + (zone || '-') +
    '  |  สถานะ: รอตรวจสอบ' +
    '  |  สร้างเมื่อ: ' + Utilities.formatDate(now, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm')
  );
  meta.setForegroundColor('#5F6368');
  meta.setFontSize(9);

  if (article.metaDescription) {
    var md = body.appendParagraph('Meta description: ' + article.metaDescription);
    md.setForegroundColor('#5F6368');
    md.setFontSize(9);
  }
  if (article.tags && article.tags.length) {
    var tg = body.appendParagraph('Tags: ' + article.tags.join(', '));
    tg.setForegroundColor('#5F6368');
    tg.setFontSize(9);
  }

  body.appendHorizontalRule();

  // เนื้อหา
  renderMarkdown_(body, article.body);

  // FAQ (ใช้ทำ rich snippet บนเว็บ)
  if (article.faq && article.faq.length) {
    body.appendHorizontalRule();
    var faqHead = body.appendParagraph('คำถามที่พบบ่อย (FAQ)');
    faqHead.setHeading(DocumentApp.ParagraphHeading.HEADING2);
    article.faq.forEach(function (f) {
      var q = body.appendParagraph('Q: ' + f.question);
      q.setBold(true);
      body.appendParagraph('A: ' + f.answer);
    });
  }

  // หมายเหตุท้ายบทความ
  body.appendHorizontalRule();
  var note = body.appendParagraph(
    '⚠️ ตรวจก่อนโพสต์: ตรวจราคา/เวลาเปิด-ปิด แก้ไขลิงก์ และลบข้อความแถบนี้ก่อนเผยแพร่ · รูปจริงของร้าน: วางลิงก์ 1–5 รูปในคอลัมน์ M "Photo (ใส่เอง)" (ขึ้นบรรทัดใหม่)'
  );
  note.setFontSize(9);
  note.setForegroundColor('#B45F06');

  doc.saveAndClose();

  // ย้ายเข้าโฟลเดอร์ที่กำหนด (ถ้ามี)
  if (cfg.folderId) {
    try {
      var file = DriveApp.getFileById(doc.getId());
      DriveApp.getFolderById(cfg.folderId).addFile(file);
      // ลบออกจาก My Drive root เพื่อไม่ให้ซ้ำ (Drive รองรับไฟล์หลาย parent)
      DriveApp.getRootFolder().removeFile(file);
    } catch (e) {
      log_('WARN', name, '-', 'ย้ายไฟล์เข้าโฟลเดอร์ไม่สำเร็จ: ' + e.message);
    }
  }

  var finalDoc = DocumentApp.openById(doc.getId());
  return { id: doc.getId(), url: finalDoc.getUrl(), title: docTitle };
}

/**
 * แปลง Markdown อย่างง่ายลงในเอกสาร
 * รองรับ: # ## ###, - หรือ * (หัวข้อย่อย), **ตัวหนา**, เส้นคั่น ---
 */
function renderMarkdown_(body, markdown) {
  var lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\s+$/, '');
    if (!line.trim()) continue;

    if (/^---+$/.test(line.trim())) {
      body.appendHorizontalRule();
      continue;
    }

    var heading = null;
    var text = line;
    var isBullet = /^\s*[-*]\s+/.test(line);

    if (/^#\s+/.test(line)) {
      heading = DocumentApp.ParagraphHeading.HEADING1;
      text = line.replace(/^#\s+/, '');
    } else if (/^##\s+/.test(line)) {
      heading = DocumentApp.ParagraphHeading.HEADING2;
      text = line.replace(/^##\s+/, '');
    } else if (/^###\s+/.test(line)) {
      heading = DocumentApp.ParagraphHeading.HEADING3;
      text = line.replace(/^###\s+/, '');
    } else if (isBullet) {
      text = line.replace(/^\s*[-*]\s+/, '').replace(/^\[[ xX]\]\s*/, '');
    } else if (/^>\s?/.test(line)) {
      text = line.replace(/^>\s?/, '').trim();
    }

    if (isBullet && !heading) {
      var item = body.appendListItem('');
      appendRichText_(item, text);
      continue;
    }

    var para = body.appendParagraph('');
    appendRichText_(para, text);
    if (heading) para.setHeading(heading);
  }
}

/** ใส่ข้อความโดยแปลง **ตัวหนา** เป็น run ที่หนาจริง */
function appendRichText_(container, text) {
  var parts = String(text).split('**');
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    var run = container.appendText(parts[i]);
    if (i % 2 === 1) run.setBold(true);
  }
}

/* ---------------------- Line.gs ---------------------- */
/**
 * LINE Messaging API — ส่งข้อความขออนุมัติ + รับคำสั่งผ่าน webhook
 */

var LINE_API = 'https://api.line.me/v2/bot';

var Line = {

  headers_: function () {
    var cfg = getConfig_();
    return {
      'Authorization': 'Bearer ' + cfg.lineToken,
      'Content-Type': 'application/json'
    };
  },

  push_: function (messages) {
    var cfg = getConfig_();
    if (!cfg.lineToken) throw new Error('ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN');
    if (!cfg.lineAdmin) throw new Error('ยังไม่มี LINE_ADMIN_USER_ID — พิมพ์อะไรก็ได้หาบอท 1 ครั้งก่อน');
    return Line.post_('/message/push', { to: cfg.lineAdmin, messages: messages });
  },

  reply_: function (replyToken, messages) {
    return Line.post_('/message/reply', { replyToken: replyToken, messages: messages });
  },

  post_: function (path, payload) {
    var res = UrlFetchApp.fetch(LINE_API + path, {
      method: 'post',
      headers: Line.headers_(),
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code !== 200) {
      throw new Error('LINE error ' + code + ': ' + res.getContentText().slice(0, 300));
    }
    return true;
  },

  /** ส่งชุดร่างให้อนุมัติ */
  pushBatchApproval: function (items) {
    var cfg = getConfig_();
    var today = Utilities.formatDate(new Date(), cfg.timezone, 'd MMM');

    var lines = ['☕ ร่างรีวิว ' + today + ' (' + items.length + ' ร้าน)'];
    items.forEach(function (it, i) {
      lines.push((i + 1) + '. ' + it.name + ' — ' + it.zone);
    });
    lines.push('');
    lines.push('ตอบ "ok" = โพสต์ทั้งหมด');
    lines.push('ตอบ "2 ไม่เอา" = เปลี่ยนร้านที่ 2');
    lines.push('ตอบ "ดู" = ดูสถานะ');

    Line.push_([
      { type: 'text', text: lines.join('\n') },
      Line.carousel_(items)
    ]);
  },

  carousel_: function (items) {
    var bubbles = items.map(function (it, i) {
      var body = {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: (i + 1) + '. ' + it.name, weight: 'bold', size: 'md', wrap: true },
          { type: 'text', text: it.zone + (it.rating ? ' · ⭐ ' + it.rating : ''), size: 'xs', color: '#5B7B90' },
          { type: 'text', text: it.title, size: 'sm', wrap: true, margin: 'md', maxLines: 3 }
        ]
      };
      var bubble = {
        type: 'bubble',
        body: body,
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: 'ตอบ "' + (i + 1) + ' ไม่เอา" เพื่อเปลี่ยนร้านนี้', size: 'xxs', color: '#8A9AA8', wrap: true }
          ]
        }
      };
      // ส่งรูปผ่าน proxy ของเว็บเรา (/api/img) เพื่อให้ LINE ดึงได้ทุกแหล่ง (Drive / Google Maps / หน้าเว็บร้าน)
      if (it.photoUrl && /^https?:\/\//i.test(it.photoUrl)) {
        var base = String(getConfig_().siteBase || '').replace(/\/+$/, '');
        bubble.hero = {
          type: 'image',
          url: base + '/api/img?u=' + encodeURIComponent(it.photoUrl),
          size: 'full',
          aspectRatio: '20:13',
          aspectMode: 'cover'
        };
      }
      return bubble;
    });

    return {
      type: 'flex',
      altText: 'ร่างรีวิว ' + items.length + ' ร้าน รออนุมัติ',
      contents: { type: 'carousel', contents: bubbles }
    };
  },

  /** ข้อความสั้น ๆ */
  text: function (s) {
    return { type: 'text', text: String(s).slice(0, 4900) };
  }
};

/**
 * Webhook: LINE เรียกเข้ามาเมื่อมีข้อความ
 * ตั้ง URL เป็น https://script.google.com/macros/s/<deployId>/exec?t=<LINE_WEBHOOK_TOKEN>
 */
function doPost(e) {
  var reply = null;
  try {
    var cfg = getConfig_();
    var token = (e && e.parameter && e.parameter.t) || '';
    if (cfg.lineWebhookToken && token !== cfg.lineWebhookToken) {
      return ContentService.createTextOutput('forbidden');
    }

    var body = (e && e.postData && e.postData.contents) || '{}';
    var json = JSON.parse(body);
    var events = json.events || [];

    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') continue;

      var userId = (ev.source && ev.source.userId) || '';

      // ผู้ดูแลคนแรกที่ทักมา = เจ้าของระบบ
      if (!cfg.lineAdmin && userId) {
        PropertiesService.getScriptProperties().setProperty('LINE_ADMIN_USER_ID', userId);
        cfg.lineAdmin = userId;
        log_('INFO', '-', '-', 'บันทึก LINE_ADMIN_USER_ID: ' + userId);
      }
      if (cfg.lineAdmin && userId !== cfg.lineAdmin) {
        log_('WARN', '-', '-', 'ข้อความจากคนที่ไม่ใช่ผู้ดูแล (' + userId + ') — ไม่ทำอะไร');
        continue;
      }

      reply = Approve.handleText_(String(ev.message.text || '').trim(), ev.replyToken, cfg);
    }
  } catch (err) {
    log_('ERROR', '-', '-', 'webhook ผิดพลาด: ' + (err && err.message ? err.message : err));
  }
  return ContentService.createTextOutput('OK');
}

/** ฟังก์ชันที่ยอมให้สั่งรันผ่าน URL (ต้องมี token เท่านั้น) */
var ADMIN_FUNCTIONS = [
  'checkSetup',
  'testPlaces',
  'testGitHub',
  'testGemini',
  'testGroq',
  'listGroqModels',
  'setGroqModelGptOss120',
  'setGroqModelGptOss20',
  'setGroqModelLlama31Instant',
  'listGeminiModels',
  'setModelGemini25Flash',
  'setModelGemini25FlashLite',
  'setModelDefault',
  'setModel35Flash',
  'setModel35FlashLite',
  'setModel36Flash',
  'setModel37Flash',
  'setModel3FlashPreview',
  'testLine',
  'lineFollowers',
  'setupHeaders',
  'setupTriggers',
  'setupWeeklyTrigger',
  'seedWeeklyShops',
  'auditClosedShops',
  'removeClosedUnpublishedShops',
  'logStats',
  'testOsm',
  'listDeployInfo',
  'publishAllPending',
  'resendPending',
  'republishSite',
  'refreshPostPages',
  'testRenderPost',
  'dumpSheet',
  'dumpLog',
  'resetErrorToReady',
  'purgeMassShops',
  'runPublishQueue',
  'pauseBatch',
  'runNow'
];

/**
 * ให้เปิด URL เฉย ๆ แล้วเห็นว่ายังทำงานอยู่
 * ?t=<token>                -> "webhook ok"
 * ?t=<token>&run=<ชื่อฟังก์ชัน> -> รันฟังก์ชันแล้วคืน JSON (ใช้ตรวจระบบ)
 */
function doGet(e) {
  var cfg = getConfig_();
  var p = (e && e.parameter) || {};
  if (!cfg.lineWebhookToken || p.t !== cfg.lineWebhookToken) {
    return ContentService.createTextOutput('cafe bot');
  }
  var fn = String(p.run || '').trim();
  if (!fn) return ContentService.createTextOutput('webhook ok');
  if (ADMIN_FUNCTIONS.indexOf(fn) === -1) {
    return ContentService.createTextOutput('unknown function: ' + fn);
  }

  var out;
  try {
    var result = eval(fn + '()');
    out = { ok: true, fn: fn, result: result === undefined ? null : result };
  } catch (err) {
    out = { ok: false, fn: fn, error: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

/** ข้อมูล deployment ปัจจุบัน (ใช้ตรวจว่า web app ชี้เวอร์ชันไหน) */
function listDeployInfo() {
  var url = ScriptApp.getService().getUrl();
  return { webAppUrl: url, timezone: Session.getScriptTimeZone(), user: Session.getEffectiveUser().getEmail() };
}

/** ทดสอบส่งข้อความเข้ากลุ่มส่วนตัวผู้ดูแล */
function testLine() {
  var msg = 'ทดสอบจาก Café Bot ✔\nถ้าเห็นข้อความนี้ แปลว่า LINE เชื่อมต่อได้แล้ว';
  try {
    Line.push_([Line.text(msg)]);
    try { SpreadsheetApp.getUi().alert('ส่งข้อความทดสอบแล้ว ✔\nเช็กในแอป LINE'); } catch (e) {}
    return 'sent';
  } catch (err) {
    var m = String(err && err.message ? err.message : err);
    try { SpreadsheetApp.getUi().alert('ส่งไม่สำเร็จ ✖\n\n' + m); } catch (e) {}
    return m;
  }
}

/** ดูว่าใครเป็นเพื่อนกับ OA (ใช้ตั้ง LINE_ADMIN_USER_ID) */
function lineFollowers() {
  var cfg = getConfig_();
  var res = UrlFetchApp.fetch(LINE_API + '/followers/ids', {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + cfg.lineToken },
    muteHttpExceptions: true
  });
  var out = res.getResponseCode() + ': ' + res.getContentText().slice(0, 500);
  log_('INFO', '-', '-', 'followers: ' + out);
  return out;
}

/* ---------------------- Approve.gs ---------------------- */
/**
 * อนุมัติผ่าน LINE + เผยแพร่ขึ้นเว็บ (GitHub commit -> Cloudflare Pages)
 */

var Approve = {

  /** ข้อความจาก LINE -> การกระทำ */
  handleText_: function (text, replyToken, cfg) {
    var t = String(text || '').trim();
    var low = t.toLowerCase();

    var items = Approve.pendingItems_(cfg);
    if (!items.length) {
      Line.reply_(replyToken, [Line.text('ยังไม่มีร่างที่รออนุมัติครับ — ใส่ชื่อร้าน + โซน + ready ในชีตก่อน')]);
      return 'empty';
    }

    // อนุมัติทั้งหมด -> ตั้งคิวโพสต์ตามเวลา (09:00 / 12:00 / 17:00)
    if (/^(ok|okay|โอเค|ตกลง|อนุมัติ|โพส|โพสต์|yes|ได้)$/i.test(low)) {
      var plan = Approve.scheduleAll_(cfg, items);
      var lines = ['รับทราบ ✅ ตั้งคิวโพสต์ ' + plan.length + ' ร้าน ตามเวลา:'];
      plan.forEach(function (p, i) {
        lines.push((i + 1) + '. ' + p.name + ' — ' + p.when);
      });
      lines.push('', 'ระบบจะโพสต์ขึ้นเว็บเอง แล้วแจ้งผลในแชทนี้อีกครั้ง');
      Line.reply_(replyToken, [Line.text(lines.join('\n'))]);
      return 'scheduled';
    }

    // เปลี่ยนร้านที่ n
    var m = low.match(/^([1-9])\s*(?:ไม่เอา|ไมเอา|no|เปลี่ยนร้าน|เปลี่ยน)/) || low.match(/^(?:เปลี่ยน|แก้)\s*(?:ร้าน)?\s*([1-9])/);
    if (m) {
      var idx = parseInt(m[1], 10) - 1;
      if (idx < 0 || idx >= items.length) {
        Line.reply_(replyToken, [Line.text('ไม่มีร้านที่ ' + (idx + 1) + ' ครับ (มี ' + items.length + ' ร้าน)')]);
        return 'bad-slot';
      }
      Line.reply_(replyToken, [Line.text('รับทราบ ขอหาร้านใหม่ในโซน ' + items[idx].zone + '... ⏳')]);
      try {
        var fresh = Approve.swap_(cfg, items[idx]);
        var msg = ['🔄 เปลี่ยนร้านที่ ' + (idx + 1) + ' เป็น', fresh.name + ' — ' + fresh.zone, fresh.title, '', 'ถ้าไม่ถูกใจ ตอบ "' + (idx + 1) + ' ไม่เอา" อีกครั้ง'];
        Line.push_([Line.text(msg.join('\n')), Line.carousel_([fresh])]);
        return 'swapped';
      } catch (err) {
        var e = String(err && err.message ? err.message : err);
        Line.push_([Line.text('หาร้านใหม่ไม่สำเร็จ: ' + e)]);
        return 'swap-error';
      }
    }

    // ดูสถานะ
    if (/^(ดู|สถานะ|status|list)$/i.test(low)) {
      var s = ['📋 รออนุมัติ ' + items.length + ' ร้าน'];
      items.forEach(function (it, i) {
        s.push((i + 1) + '. ' + it.name + ' — ' + it.zone);
      });
      s.push('', 'พิมพ์ ok เพื่อโพสต์ทั้งหมด');
      Line.reply_(replyToken, [Line.text(s.join('\n'))]);
      return 'status';
    }

    Line.reply_(replyToken, [Line.text([
      'คำสั่งที่ใช้ได้',
      '• ok = อนุมัติ แล้วโพสต์ตามเวลา ' + postSlots_(cfg).join(' / '),
      '• 2 ไม่เอา = เปลี่ยนร้านที่ 2',
      '• ดู = ดูรายการที่รออนุมัติ'
    ].join('\n'))]);
    return 'help';
  },

  /** รายการที่รออนุมัติ เรียงตามแถวในชีต */
  pendingItems_: function (cfg) {
    var sheet = getSheet_(cfg.sheetName);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    var rows = sheet.getRange(2, COL.STATUS, lastRow - 1, 1).getValues();
    var items = [];
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][0]).trim().toLowerCase() !== STATUS.PENDING) continue;
      var it = loadPending_(cfg, i + 2);
      if (it) items.push(it);
    }
    return items;
  },

  /** เปลี่ยนร้านในสล็อตหนึ่ง */
  swap_: function (cfg, oldItem) {
    var sheet = getSheet_(cfg.sheetName);
    var lastRow = sheet.getLastRow();
    var ids = sheet.getRange(2, COL.PLACE_ID, lastRow - 1, 1).getValues()
      .map(function (r) { return String(r[0] || '').trim(); })
      .filter(Boolean);

    var dateKey = Utilities.formatDate(new Date(), cfg.timezone, 'yyyy-MM-dd');
    var item = buildDraftForRow_(cfg, sheet, oldItem.row, '', oldItem.zone, ids, dateKey);
    return item;
  },

  /** โพสต์ทุกรายการที่รออนุมัติ */
  publishAll_: function (cfg) {
    var items = Approve.pendingItems_(cfg);
    var results = [];
    var sheet = getSheet_(cfg.sheetName);

    if (!items.length) return { ok: 0, total: 0, items: [] };

    try {
      var res = Publish.publishItems_(cfg, items);
      res.out.forEach(function (p) {
        sheet.getRange(p.row, COL.POST_URL).setValue(p.url);
        setStatus_(sheet, p.row, STATUS.PUBLISHED, 'โพสต์แล้ว: ' + p.url);
        deletePending_(cfg, p.row);
        results.push({ ok: true, name: p.name, url: p.url });
      });
      (res.failed || []).forEach(function (f) {
        setStatus_(sheet, f.row, STATUS.ERROR, f.error);
        results.push({ ok: false, name: f.name, error: f.error });
      });
      var okN = results.filter(function (r) { return r.ok; }).length;
      log_('OK', '-', '-', 'โพสต์สำเร็จ ' + okN + '/' + results.length + ' ร้าน');
    } catch (err) {
      var msg = String(err && err.message ? err.message : err).slice(0, 400);
      log_('ERROR', '-', '-', 'โพสต์ไม่สำเร็จ: ' + msg);
      items.forEach(function (it) {
        results.push({ ok: false, name: it.name, error: msg });
      });
    }

    PropertiesService.getScriptProperties().deleteProperty('PENDING_ROWS');
    var okCount = results.filter(function (r) { return r.ok; }).length;
    return { ok: okCount, total: results.length, items: results };
  },

  /** ตั้งคิวโพสต์ตามเวลา (ยังไม่ขึ้นเว็บจนถึงเวลาสล็อต) — skip slot ที่ชนกับคิวเก่าในชีต (คอล G, L) */
  scheduleAll_: function (cfg, items) {
    reconcileQueue_(cfg);
    var now = Date.now() + 2 * 60 * 1000;
    var slots = nextSlots_(cfg, now, items.length * 6);
    var sheet = getSheet_(cfg.sheetName);
    var occupied = occupiedSlots_(cfg, sheet);
    var plan = [];
    var si = 0;

    items.forEach(function (it) {
      // หาสล็อตว่างถัดไปที่ยังไม่มีใครจองไว้ (ทั้งในคิวและในชีต)
      var at = null;
      while (si < slots.length) {
        var cand = slots[si++];
        if (!occupied[cand]) { at = cand; occupied[at] = true; break; }
      }
      if (!at) at = now + (plan.length + 1) * 60 * 60 * 1000;
      var queue = readQueue_(cfg);
      queue = queue.filter(function (q) { return q.row !== it.row; });
      queue.push({ row: it.row, slug: it.slug, name: it.name, at: at });
      writeQueue_(cfg, queue);
      setStatus_(sheet, it.row, STATUS.SCHEDULED, 'จะโพสต์ ' + slotLabel_(cfg, at));
      plan.push({ name: it.name, at: at, when: slotLabel_(cfg, at) });
    });

    PropertiesService.getScriptProperties().deleteProperty('PENDING_ROWS');
    log_('OK', '-', '-', 'ตั้งคิวโพสต์: ' + plan.map(function (p) { return p.name + ' ' + p.when; }).join(' | '));
    return plan;
  }
};

/** เมนู: โพสต์ทั้งหมดโดยไม่ต้องกด ok (ใช้ตอนทดสอบ) */
function publishAllPending() {
  var cfg = getConfig_();
  var out = Approve.publishAll_(cfg);
  var msg = 'โพสต์ ' + out.ok + '/' + out.total + ' ร้าน';
  out.items.forEach(function (r) { msg += '\n• ' + r.name + ' — ' + (r.ok ? r.url : r.error); });
  log_('INFO', '-', '-', msg.replace(/\n/g, ' | '));
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
  return out;
}

/** เมนู: ส่งชุดร่างที่ค้างอนุมัติเข้า LINE อีกครั้ง (กรณีรอบแรกส่งไม่ถึง) */
function resendPending() {
  var cfg = getConfig_();
  var items = Approve.pendingItems_(cfg);
  if (!items.length) return 'ไม่มีร่างที่รออนุมัติ';
  Line.pushBatchApproval(items);
  log_('OK', '-', '-', 'ส่ง LINE ซ้ำ ' + items.length + ' ร้าน');
  return 'ส่งแล้ว ' + items.length + ' ร้าน';
}

/* ============================================================
 * คิวโพสต์ตามเวลา (09:00 / 12:00 / 17:00 เวลาไทย)
 * ============================================================ */

var DEFAULT_POST_SLOTS = '09:00,12:00,17:00';

/** เวลาสล็อตที่ใช้อยู่ (แก้ได้ด้วย Script Property POST_SLOTS = "09:00,12:00,17:00") */
function postSlots_(cfg) {
  var raw = '';
  try { raw = PropertiesService.getScriptProperties().getProperty('POST_SLOTS') || ''; } catch (e) {}
  var out = [];
  String(raw || DEFAULT_POST_SLOTS).split(/[,\s]+/).forEach(function (s) {
    var m = String(s).trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return;
    var h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
    if (h > 23 || mi > 59) return;
    out.push((h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi);
  });
  out.sort();
  return out.length ? out : DEFAULT_POST_SLOTS.split(',');
}

/** เวลาไทย (UTC+7) -> epoch ms */
function bangkokTs_(dayStr, hhmm) {
  return new Date(dayStr + 'T' + hhmm + ':00+07:00').getTime();
}

/** สล็อตถัดไป n รายการ หลังเวลาที่กำหนด */
function nextSlots_(cfg, afterTs, n) {
  var tz = (cfg && cfg.timezone) || 'Asia/Bangkok';
  var slots = postSlots_(cfg);
  var out = [];
  for (var d = 0; d < 14 && out.length < n; d++) {
    var day = Utilities.formatDate(new Date(afterTs + d * 86400000), tz, 'yyyy-MM-dd');
    for (var i = 0; i < slots.length && out.length < n; i++) {
      var ts = bangkokTs_(day, slots[i]);
      if (ts > afterTs) out.push(ts);
    }
  }
  return out;
}

/** ป้ายเวลาที่อ่านง่าย: 5 พ.ย. 12:00 / 6 พ.ย. 09:00 (แสดงวันที่จริงเสมอ) */
function slotLabel_(cfg, ts) {
  var tz = (cfg && cfg.timezone) || 'Asia/Bangkok';
  var d = new Date(ts);
  var day = Utilities.formatDate(d, tz, 'd MMM');
  var hm = Utilities.formatDate(d, tz, 'HH:mm');
  var year = Utilities.formatDate(d, tz, 'yyyy');
  var nowYear = Utilities.formatDate(new Date(), tz, 'yyyy');
  if (year === nowYear) return day + ' ' + hm;
  return day + ' ' + year + ' ' + hm;
}

/** ตรวจจับเวลาที่ถูกจองไว้แล้วจากคิวใน Script Properties + ข้อความในชีต (คอล G และ L) */
function occupiedSlots_(cfg, sheet) {
  var occupied = {};
  var queue = readQueue_(cfg);
  queue.forEach(function (q) { occupied[q.at] = true; });

  // สแกนแถวที่สถานะ scheduled ในชีต เพื่อดึงเวลาที่เซ็ตไว้แล้ว (ป้องกันกรณีตั้งคนละรอบ)
  var lastRow = sheet.getLastRow();
  for (var r = 2; r <= lastRow; r++) {
    var status = String(sheet.getRange(r, COL.STATUS).getValue() || '').trim();
    if (status !== STATUS.SCHEDULED) continue;
    var note = String(sheet.getRange(r, COL.NOTE).getValue() || '');
    var batch = String(sheet.getRange(r, COL.BATCH).getValue() || '');
    var slug = String(sheet.getRange(r, COL.SLUG).getValue() || '');
    var timeMatch = note.match(/(\d{1,2})\s*[:：]\s*(\d{2})/) || batch.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
    if (!timeMatch) continue;
    var hh = parseInt(timeMatch[1], 10), mm = parseInt(timeMatch[2], 10);
    if (hh > 23 || mm > 59) continue;
    // สร้าง epoch ของวันนี้และพรุ่งนี้ที่เวลานั้น เพื่อกันซ้ำข้ามวัน
    var today = new Date();
    today.setHours(hh, mm, 0, 0);
    var tomorrow = new Date(today.getTime() + 86400000);
    occupied[today.getTime()] = true;
    occupied[tomorrow.getTime()] = true;
  }
  return occupied;
}

/** แปลงโน้ต "จะโพสต์ 18 Nov 09:00" -> epoch ms (คืน 0 ถ้าอ่านไม่ได้) */
function parseNoteSlot_(cfg, note) {
  var tz = (cfg && cfg.timezone) || 'Asia/Bangkok';
  var months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  var m = String(note || '').match(/(\d{1,2})\s*([A-Za-z]{3,})?\s*(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (!m) return 0;
  var hh = parseInt(m[3], 10), mi = parseInt(m[4], 10);
  if (hh > 23 || mi > 59) return 0;
  var now = new Date();
  var ts;
  if (m[2]) {
    var mi2 = months[String(m[2]).toLowerCase().slice(0, 3)];
    if (mi2 === undefined) return 0;
    var y = parseInt(Utilities.formatDate(now, tz, 'yyyy'), 10);
    ts = new Date(y, mi2, parseInt(m[1], 10), hh, mi, 0, 0).getTime();
    if (ts < Date.now() - 45 * 86400000) ts = new Date(y + 1, mi2, parseInt(m[1], 10), hh, mi, 0, 0).getTime();
  } else {
    ts = new Date(now.getFullYear(), now.getMonth(), parseInt(m[1], 10), hh, mi, 0, 0).getTime();
    if (ts < Date.now() - 45 * 86400000) ts = new Date(now.getFullYear(), now.getMonth() + 1, parseInt(m[1], 10), hh, mi, 0, 0).getTime();
  }
  return ts || 0;
}

/**
 * กู้คิวที่หลุด: แถวสถานะ scheduled ต้องมีอยู่ในคิวเสมอ
 * - ถ้าโน้ตยังมีเวลาในอนาคตและสล็อตยังว่าง ใช้เวลานั้น
 * - ถ้าเวลาผ่านไปแล้ว/ชนกัน จัดสล็อตถัดไปที่ว่างให้
 */
function reconcileQueue_(cfg) {
  var sheet = getSheet_(cfg.sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var vals = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  var queue = readQueue_(cfg);
  var have = {};
  var used = {};
  queue.forEach(function (q) { have[q.row] = true; used[Number(q.at)] = true; });

  var now = Date.now() + 3 * 60 * 1000;
  var slots = nextSlots_(cfg, now, 120);
  var si = 0;
  var added = [];

  for (var i = 0; i < vals.length; i++) {
    var row = i + 2;
    if (String(vals[i][COL.STATUS - 1] || '').trim().toLowerCase() !== STATUS.SCHEDULED) continue;
    if (have[row]) continue;

    var slug = String(vals[i][COL.SLUG - 1] || '').trim();
    if (!slug) {
      setStatus_(sheet, row, STATUS.ERROR, 'ไม่มี slug — กู้คิวไม่ได้ ต้องสร้างร่างใหม่');
      added.push(row + ' ERROR no slug');
      continue;
    }

    var at = parseNoteSlot_(cfg, vals[i][COL.NOTE - 1]);
    if (!at || at <= now || used[at]) at = 0;
    while (!at && si < slots.length) {
      var cand = slots[si++];
      if (!used[cand]) at = cand;
    }
    if (!at) continue;

    queue.push({ row: row, slug: slug, name: String(vals[i][COL.NAME - 1] || ''), at: at });
    used[at] = true;
    have[row] = true;
    setStatus_(sheet, row, STATUS.SCHEDULED, 'จะโพสต์ ' + slotLabel_(cfg, at));
    added.push(row + ' ' + slotLabel_(cfg, at));
  }

  if (added.length) {
    writeQueue_(cfg, queue);
    log_('WARN', '-', '-', 'กู้คิวที่หลุด ' + added.length + ' รายการ: ' + added.join(' | '));
  }
  return added;
}

function readQueue_(cfg) {
  try {
    var arr = JSON.parse(PropertiesService.getScriptProperties().getProperty('PUBLISH_QUEUE') || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function writeQueue_(cfg, queue) {
  var props = PropertiesService.getScriptProperties();
  var clean = (queue || []).slice().sort(function (a, b) { return a.at - b.at; });
  if (!clean.length) {
    props.deleteProperty('PUBLISH_QUEUE');
    return;
  }
  props.setProperty('PUBLISH_QUEUE', JSON.stringify(clean));
}

var PublishQueue = {

  /** โพสต์รายการที่ถึงเวลาแล้ว (เรียกจาก trigger ทุก 5 นาที) */
  run_: function (cfg) {
    try { reconcileQueue_(cfg); } catch (e) { log_('WARN', '-', '-', 'กู้คิวไม่สำเร็จ: ' + e.message); }
    var queue = readQueue_(cfg);
    if (!queue.length) return { due: 0, ok: 0, total: 0 };

    var now = Date.now();
    var due = queue.filter(function (q) { return Number(q.at) <= now; });
    if (!due.length) return { due: 0, ok: 0, total: 0, next: queue[0].at };

    var sheet = getSheet_(cfg.sheetName);
    var items = [];
    due.forEach(function (q) {
      var it = loadPending_(cfg, q.row);
      if (it) items.push(it);
      else setStatus_(sheet, q.row, STATUS.ERROR, 'ไม่พบไฟล์ร่างที่รอโพสต์ — ข้ามคิว');
    });

    var results = [];
    if (items.length) {
      try {
        var res = Publish.publishItems_(cfg, items);
        res.out.forEach(function (p) {
          sheet.getRange(p.row, COL.POST_URL).setValue(p.url);
          setStatus_(sheet, p.row, STATUS.PUBLISHED, 'โพสต์ตามเวลาแล้ว: ' + p.url);
          deletePending_(cfg, p.row);
          results.push({ ok: true, name: p.name, url: p.url });
        });
        (res.failed || []).forEach(function (f) {
          setStatus_(sheet, f.row, STATUS.ERROR, f.error);
          results.push({ ok: false, name: f.name, error: f.error });
        });
        log_('OK', '-', '-', 'โพสต์ตามเวลา ' + results.length + ' ร้าน');
      } catch (err) {
        var msg = String(err && err.message ? err.message : err).slice(0, 400);
        log_('ERROR', '-', '-', 'โพสต์ตามเวลาไม่สำเร็จ: ' + msg);
        items.forEach(function (it) {
          setStatus_(sheet, it.row, STATUS.ERROR, 'โพสต์ตามเวลาไม่สำเร็จ: ' + msg);
          results.push({ ok: false, name: it.name, error: msg });
        });
      }
    }

    // เอาออกจากคิวทั้งที่สำเร็จและ error (ไม่ให้ค้าง)
    var doneRows = due.map(function (q) { return q.row; });
    writeQueue_(cfg, readQueue_(cfg).filter(function (q) {
      return doneRows.indexOf(q.row) === -1;
    }));

    // แจ้งผลใน LINE
    try {
      if (results.length) {
        var okN = results.filter(function (r) { return r.ok; }).length;
        var lines = ['📣 โพสต์ตามเวลา ' + okN + '/' + results.length + ' ร้าน'];
        results.forEach(function (r) {
          lines.push((r.ok ? '✅ ' : '✖ ') + r.name + (r.ok ? '\n  ' + r.url : '\n  ' + r.error));
        });
        Line.push_([Line.text(lines.join('\n'))]);
      }
    } catch (e) {
      log_('WARN', '-', '-', 'แจ้ง LINE ไม่สำเร็จ: ' + e.message);
    }

    return {
      ok: results.filter(function (r) { return r.ok; }).length,
      total: results.length,
      items: results
    };
  }
};

/** trigger: ตรวจคิวโพสต์ตามเวลา */
function runPublishQueue() {
  return withLock_(function () {
    return PublishQueue.run_(getConfig_());
  });
}

/* ---------------------- Site.gs ---------------------- */
/**
 * Site: แปลงบทความ -> หน้า HTML (พาสเทลฟ้า) ไม่ต้องมี build step
 */

var Site = {

  renderPost_: function (item, manifest) {
    var cfg = getConfig_();
    var base = String(cfg.siteBase || '').replace(/\/+$/, '');
    var dateTH = thaiDate_(item.date);
    var bodySource = item.body || item.bodyHtml || '';
    var readMin = readingTime_(String(bodySource).replace(/<[^>]+>/g, ' '));
    var canonical = base + '/posts/' + item.slug + '/';
    var photoPaths = (item.photoPaths && item.photoPaths.length)
      ? item.photoPaths
      : (item.photoPath ? [item.photoPath] : []);
    var heroPath = photoPaths[0] || '';
    var photo = heroPath ? '/' + heroPath : '';
    var desc = seoDescription_(item);
    var zone = item.zone || 'กรุงเทพฯ';
    var absolutePhotos = photoPaths.map(function (p) { return base + '/' + p; });

    var head = Site.head_({
      title: item.title + ' | ไปคาเฟ่กัน',
      desc: desc,
      canonical: canonical,
      url: canonical,
      type: 'article',
      image: absolutePhotos[0] || '',
      imageAlt: item.name + ' — คาเฟ่' + zone,
      preload: photo,
      published: isoDateTime_(item.date),
      modified: isoDateTime_(item.date),
      section: zone,
      tags: item.tags || [],
      jsonLd: [
        Site.orgNode_(base),
        Site.siteNode_(base),
        Site.articleNode_(item, base, canonical, desc, absolutePhotos),
        Site.placeNode_(item, base, canonical, desc, absolutePhotos),
        Site.crumbNode_(base, zone, item, canonical),
        (item.faq && item.faq.length) ? Site.faqNode_(item, canonical) : null
      ].filter(Boolean)
    });

    var cover = photo
      ? '<figure class="article-cover"><img src="' + esc_(photo) + '" alt="' + esc_(item.name + ' คาเฟ่' + zone) + '" loading="eager" fetchpriority="high" decoding="async" width="1200" height="675"></figure>'
      : '<figure class="article-cover cover-auto">' + Site.coverAuto_(item) + '</figure>';

    // ถ้ามี bodyHtml (โพสต์เก่าที่แปลงจาก HTML เดิม) ใช้ตรง ๆ ไม่ต้องแปลง Markdown ซ้ำ
    var bodyHtml;
    var gallery = '';
    if (item.bodyHtml) {
      bodyHtml = String(item.bodyHtml);
      // โพสต์เก่าที่แปลงจาก HTML: รูปชุดล่างบทความถูกเก็บแยกไว้เป็น galleryHtml
      if (item.galleryHtml) gallery = String(item.galleryHtml);
    } else {
      // แทรกรูปแทรกในเนื้อหา (ย่อหน้า -> รูป -> ย่อหน้า) เพื่อให้อ่านลื่นเหมือนนิตยสาร
      var blocks = Site.mdBlocks_(item.body);
      var inlinePhotos = photoPaths.slice(1);
      var paraIdx = [];
      blocks.forEach(function (b, i) { if (b.type === 'p') paraIdx.push(i); });
      var slots = Math.min(inlinePhotos.length, Math.max(0, paraIdx.length - 1));
      var insertAfter = {};
      for (var k = 0; k < slots; k++) {
        var pos = Math.round((k + 1) * paraIdx.length / (slots + 1)) - 1;
        if (pos < 0) pos = 0;
        if (pos > paraIdx.length - 1) pos = paraIdx.length - 1;
        insertAfter[paraIdx[pos]] = '<figure class="article-photo"><img src="/' + esc_(inlinePhotos[k]) +
          '" alt="' + esc_(item.name) + ' ภาพที่ ' + (k + 2) + '" loading="lazy" decoding="async" width="1000" height="667"></figure>';
      }
      bodyHtml = blocks.map(function (b, i) {
        var s = '    ' + b.html;
        if (insertAfter[i]) s += '\n    ' + insertAfter[i];
        return s;
      }).join('\n');

      var restPhotos = inlinePhotos.slice(slots);
      gallery = restPhotos.length ? [
        '<div class="photo-grid">',
        restPhotos.map(function (p, i) {
          return '  <figure><img src="/' + esc_(p) + '" alt="' + esc_(item.name) + ' ภาพที่ ' + (slots + i + 2) + '" loading="lazy" decoding="async" width="640" height="440"></figure>';
        }).join('\n'),
        '</div>'
      ].join('\n') : '';
    }

    var infoRows = [
      ['ชื่อร้าน', item.name],
      ['โซน', zone],
      ['เวลาเปิด', item.hours || 'โปรดตรวจสอบกับทางร้าน'],
      ['ที่อยู่', item.address || '-']
    ];
    if (item.website) infoRows.push(['เว็บไซต์', '<a href="' + esc_(item.website) + '" target="_blank" rel="noopener nofollow">เว็บไซต์ร้าน →</a>']);
    infoRows.push(['แผนที่', '<a href="' + esc_(item.mapsUrl || '#') + '" target="_blank" rel="noopener nofollow">เปิดใน Google Maps →</a>']);
    var infoHtml = infoRows.map(function (r) {
      var isLink = r[0] === 'แผนที่' || r[0] === 'เว็บไซต์';
      return '<div class="info-row"><span class="k">' + esc_(r[0]) + '</span><span class="v">' + (isLink ? r[1] : esc_(r[1])) + '</span></div>';
    }).join('\n    ');

    var tagHtml = (item.tags || []).map(function (t) {
      var tag = String(t || '').trim();
      if (!tag) return '';
      return '<span class="tag">' + esc_(tag.charAt(0) === '#' ? tag : '#' + tag) + '</span>';
    }).filter(Boolean).join('\n    ');

    var faqHtml = (item.faq && item.faq.length) ? [
      '<section class="faq">',
      '  <h2>คำถามที่พบบ่อย</h2>',
      item.faq.map(function (f) {
        return '  <details><summary>' + esc_(f.question) + '</summary><p>' + esc_(f.answer) + '</p></details>';
      }).join('\n'),
      '</section>'
    ].join('\n') : '';

    // ลิงก์ภายใน: ดันร้านย่านเดียวกันขึ้นก่อน เพื่อเพิ่ม internal link ที่เกี่ยวข้อง
    var pool = (manifest || []).filter(function (m) { return m.slug !== item.slug; });
    var sameZone = pool.filter(function (m) { return (m.zone || 'กรุงเทพฯ') === zone; });
    var others = pool.filter(function (m) { return (m.zone || 'กรุงเทพฯ') !== zone; });
    var related = sameZone.concat(others).slice(0, 3);
    var relatedTitle = sameZone.length ? 'ร้านอื่นในย่าน ' + zone : 'ร้านอื่นที่น่าสนใจ';
    var relatedHtml = related.length ? [
      '<section class="related">',
      '  <div class="section-head"><div><h2>' + esc_(relatedTitle) + '</h2></div><a class="more" href="/cafe/' + zoneSlug_(zone) + '/">ดูทั้งหมด →</a></div>',
      '  <div class="post-grid">',
      Site.cards_(related),
      '  </div>',
      '</section>'
    ].join('\n') : '';

    var credit = photo
      ? '<p class="photo-credit">' + (item.photoManual ? 'รูปจากทางร้าน' : 'รูปจากเว็บไซต์ของร้าน') + '</p>'
      : '';

    return [
      '<!DOCTYPE html>',
      '<html lang="th">',
      head,
      '<body>',
      Site.header_(),
      '<main class="wrap">',
      '  <nav class="breadcrumb" aria-label="breadcrumb">',
      '    <a href="/">หน้าแรก</a><span aria-hidden="true">›</span>',
      '    <a href="/cafe/' + zoneSlug_(zone) + '/">คาเฟ่' + esc_(zone) + '</a><span aria-hidden="true">›</span>',
      '    <span aria-current="page">' + esc_(item.name) + '</span>',
      '  </nav>',
      '  <header class="article-head">',
      '    <a class="zone-pill" href="/cafe/' + zoneSlug_(zone) + '/">' + esc_(zone) + '</a>',
      '    <h1>' + esc_(item.title) + '</h1>',
      '    <div class="article-meta"><span>' + esc_(dateTH) + '</span><span class="dot"></span><span>อ่าน ' + readMin + ' นาที</span></div>',
      '  </header>',
      '  ' + cover,
      '  ' + credit,
      '  <div class="article-layout">',
      '    <div class="article-main">',
      '      <article class="article-body">',
      bodyHtml,
      '      </article>',
      gallery ? '      ' + gallery : '',
      faqHtml,
      '    </div>',
      '    <aside class="article-side">',
      '      <aside class="info-box"><h3>ข้อมูลร้าน</h3>',
      '        ' + infoHtml,
      '      </aside>',
      tagHtml ? '      <div class="tags">\n        ' + tagHtml + '\n      </div>' : '',
      '    </aside>',
      '  </div>',
      relatedHtml,
      '</main>',
      Site.footer_(),
      '<script src="/assets/views.js" defer></script>',
      '</body>',
      '</html>'
    ].join('\n');
  },

  renderIndex_: function (manifest, cfg) {
    var base = String(cfg.siteBase || '').replace(/\/+$/, '');
    var latest = manifest.length ? manifest[0] : null;
    var listPosts = manifest.slice(0, 12);

    // รวบรวม zone ทั้งหมดที่ไม่ซ้ำ สำหรับ dropdown "ย่าน" บนแถบเมนูด้านบน
    var zones = [];
    manifest.forEach(function(p){ var z = p.zone || 'กรุงเทพฯ'; if (zones.indexOf(z) === -1) zones.push(z); });
    zones.sort();

    var head = Site.head_({
      title: 'ไปคาเฟ่กัน — รีวิวคาเฟ่กรุงเทพฯ กาแฟดี บรรยากาศดี',
      desc: 'รีวิวคาเฟ่ในกรุงเทพฯ คัดร้านกาแฟบรรยากาศดี กาแฟ Specialty และมุมถ่ายรูปสวย พร้อมข้อมูลจริง ที่ตั้ง เวลาเปิด และแผนที่',
      canonical: base + '/',
      url: base + '/',
      type: 'website',
      image: latest && latest.photo ? base + '/' + latest.photo : '',
      imageAlt: 'คาเฟ่กรุงเทพฯ จากไปคาเฟ่กัน',
      jsonLd: [
        Site.orgNode_(base),
        Site.siteNode_(base),
        Site.collectionNode_({
          id: base + '/#webpage',
          url: base + '/',
          name: 'ไปคาเฟ่กัน — รีวิวคาเฟ่กรุงเทพฯ',
          desc: 'รวมรีวิวคาเฟ่และร้านกาแฟในกรุงเทพฯ คัดร้านบรรยากาศดี พร้อมข้อมูลการเดินทาง',
          base: base,
          posts: listPosts
        })
      ]
    });

    var cards = listPosts.length
      ? Site.cards_(listPosts)
      : '<div class="empty"><div style="font-size:52px">☕</div><p>กำลังเก็บข้อมูลร้านแรกอยู่ — กลับมาดูเร็ว ๆ นี้</p></div>';

    // การ์ด "รีวิวล่าสุด" ในการ์ด hero (รูปจริงถ้ามี)
    var heroFeature = latest ? [
      '        <a class="hero-feature" href="/posts/' + esc_(latest.slug) + '/">',
      latest.photo
        ? '          <img class="hero-feature-img" src="/' + esc_(latest.photo) + '" alt="' + esc_(latest.name) + '" loading="eager" fetchpriority="high" width="900" height="675">'
        : '          <div class="hero-feature-img cover-auto">' + Site.coverAuto_(latest) + '</div>',
      '          <div class="hero-feature-body">',
      '            <span class="zone">' + esc_(latest.zone || 'กรุงเทพฯ') + '</span>',
      '            <h2>' + esc_(latest.title) + '</h2>',
      '            <p>รีวิวล่าสุด · ' + esc_(thaiDate_(latest.date)) + '</p>',
      '          </div>',
      '        </a>'
    ].join('\n') : '';

    // ลิงก์ภายในตามย่าน -> หน้า /cafe/<slug>/ (ช่วย crawl + ให้คนเลือกง่าย)
    var zoneLinks = zones.length ? [
      '  <section class="wrap zone-links">',
      '    <div class="section-head">',
      '      <div><h2>เลือกคาเฟ่ตามย่าน</h2><p>รวมรีวิวแยกตามโซนที่คนค้นหาบ่อย</p></div>',
      '      <a class="more" href="/reviews/">ดูทั้งหมด →</a>',
      '    </div>',
      '    <div class="chip-row">',
      zones.map(function (z) {
        return '      <a class="chip" href="/cafe/' + zoneSlug_(z) + '/">คาเฟ่' + esc_(z) + '</a>';
      }).join('\n'),
      '    </div>',
      '  </section>'
    ].join('\n') : '';

    return [
      '<!DOCTYPE html>',
      '<html lang="th">',
      head,
      '<body>',
      Site.header_(zones),
      '<main>',
      '  <section class="hero wrap">',
      '    <div class="hero-grid">',
      '      <div>',
      '        <span class="eyebrow">✦ รีวิวใหม่ทุกวัน</span>',
      '        <h1>ตามหา<em>คาเฟ่ดี ๆ</em><br>ในกรุงเทพฯ ให้คุณ</h1>',
      '        <p class="lead">คัดร้านที่บรรยากาศดี กาแฟมีคุณภาพ และเดินทางสะดวก แล้วเล่าทุกอย่างที่ควรรู้ก่อนไป — ตั้งแต่รสชาติเมนูเด่น ไปจนถึงช่วงเวลาที่คนน้อย</p>',
      '        <div class="hero-actions">',
      '          <a class="btn btn-primary" href="/reviews/">ดูรีวิวทั้งหมด →</a>',
      '          <a class="btn btn-ghost" href="/about/">รู้จักเรา</a>',
      '        </div>',
      '        <div class="hero-stats">',
      '          <div><strong>' + manifest.length + '</strong><span>รีวิวคาเฟ่</span></div>',
      '          <div><strong>' + zones.length + '</strong><span>ย่านในกรุงเทพฯ</span></div>',
      '          <div><strong>3</strong><span>รีวิวใหม่ทุกวัน</span></div>',
      '        </div>',
      '      </div>',
      '      <div class="hero-art">',
      heroFeature,
      '        <div class="hero-badge"><span style="font-size:22px">📍</span><span><strong>คัดแล้ว 100%</strong>จากร้านที่บรรยากาศดีจริง ไม่ใช่สปอนเซอร์</span></div>',
      '      </div>',
      '    </div>',
      '  </section>',
      '  <section class="wrap" id="latest">',
      '    <div class="section-head">',
      '      <div><h2>รีวิวล่าสุด</h2><p>อัปเดตทุกเช้า 07:00</p></div>',
      '      <a class="more" href="/reviews/">ดูทั้งหมด →</a>',
      '    </div>',
      '    <div class="post-grid">',
      cards,
      '    </div>',
      '  </section>',
      zoneLinks,
      '</main>',
      '  <script>',
      '(function(){',
      '  var root = document.getElementById("zoneFilter");',
      '  if (!root) return;',
      '  var btn = root.querySelector(".zone-filter-btn");',
      '  var label = root.querySelector(".zone-filter-label");',
      '  var items = root.querySelectorAll(".zone-item");',
      '  var cards = document.querySelectorAll(".card[data-zone]");',
      '  var params = new URLSearchParams(location.search);',
      '  var initial = params.get("zone") || "all";',
      '  function close(){ root.classList.remove("open"); btn.setAttribute("aria-expanded","false"); }',
      '  function apply(zone){',
      '    label.textContent = (zone === "all") ? "ย่าน" : zone;',
      '    items.forEach(function(it){ it.classList.toggle("active", it.dataset.zone === zone); });',
      '    cards.forEach(function(card){',
      '      card.style.display = (zone === "all" || card.dataset.zone === zone) ? "" : "none";',
      '    });',
      '    close();',
      '    history.replaceState(null, "", zone === "all" ? location.pathname : location.pathname + "?zone=" + encodeURIComponent(zone));',
      '  }',
      '  btn.addEventListener("click", function(e){',
      '    e.stopPropagation();',
      '    var open = root.classList.toggle("open");',
      '    btn.setAttribute("aria-expanded", open ? "true" : "false");',
      '  });',
      '  items.forEach(function(it){ it.addEventListener("click", function(e){ e.stopPropagation(); apply(this.dataset.zone); }); });',
      '  document.addEventListener("click", close);',
      '  apply(initial);',
      '})();',
      '  </script>',
      Site.footer_(),
      '</body>',
      '</html>'
    ].join('\n');
  },

  /** หน้าแดชบอร์ดรวมรีวิว (/reviews/) — ค้นหา/กรอง/เรียงตามยอดวิว (เรนเดอร์ฝั่ง client) */
  renderReviews_: function (manifest, cfg) {
    var base = String(cfg.siteBase || '').replace(/\/+$/, '');
    var posts = manifest || [];
    var zones = [];
    posts.forEach(function (p) {
      var z = p.zone || 'กรุงเทพฯ';
      if (zones.indexOf(z) === -1) zones.push(z);
    });
    zones.sort();

    var head = Site.head_({
      title: 'รวมรีวิวคาเฟ่กรุงเทพฯ ทั้งหมด — ค้นหาและกรองตามย่าน | ไปคาเฟ่กัน',
      desc: 'รวมรีวิวคาเฟ่กรุงเทพฯ ทั้งหมดในที่เดียว ค้นหาชื่อร้าน กรองตามย่าน เรียงตามยอดวิว และดูความนิยมของแต่ละบทความ',
      canonical: base + '/reviews/',
      url: base + '/reviews/',
      type: 'website',
      image: posts.length && posts[0].photo ? base + '/' + posts[0].photo : '',
      imageAlt: 'รวมรีวิวคาเฟ่กรุงเทพฯ',
      jsonLd: [
        Site.orgNode_(base),
        Site.siteNode_(base),
        Site.collectionNode_({
          id: base + '/reviews/#webpage',
          url: base + '/reviews/',
          name: 'รวมรีวิวคาเฟ่กรุงเทพฯ',
          desc: 'แดชบอร์ดรวมรีวิวคาเฟ่ทั้งหมด พร้อมค้นหาและกรองตามย่าน',
          base: base,
          posts: posts
        }),
        Site.crumbNode_(base, '', { name: 'รวมรีวิว', slug: '' }, base + '/reviews/')
      ]
    });

    var chips = ['<button type="button" class="chip active" data-zone="all">ทั้งหมด</button>']
      .concat(zones.map(function (z) {
        return '<button type="button" class="chip" data-zone="' + esc_(z) + '">' + esc_(z) + '</button>';
      })).join('');

    var cards = posts.length ? Site.cards_(posts)
      : '<div class="empty"><div style="font-size:52px">🔎</div><p>ยังไม่มีรีวิว — กลับมาดูเร็ว ๆ นี้</p></div>';

    return [
      '<!DOCTYPE html>',
      '<html lang="th">',
      head,
      '<body>',
      Site.header_(zones),
      '<main class="wrap">',
      '  <nav class="breadcrumb" aria-label="breadcrumb">',
      '    <a href="/">หน้าแรก</a><span aria-hidden="true">›</span>',
      '    <span aria-current="page">รวมรีวิว</span>',
      '  </nav>',
      '  <section class="reviews-hero">',
      '    <span class="eyebrow">✦ แดชบอร์ดรีวิว</span>',
      '    <h1>รวมรีวิว<em>ทั้งหมด</em></h1>',
      '    <p class="lead">ค้นหาชื่อร้าน กรองตามย่าน หรือเรียงตามยอดวิว — รวมทุกบทความที่เราเคยไปมาไว้ในหน้านี้</p>',
      '    <div class="stat-row">',
      '      <div class="stat"><strong id="statPosts">' + posts.length + '</strong><span>รีวิวทั้งหมด</span></div>',
      '      <div class="stat"><strong id="statZones">' + zones.length + '</strong><span>ย่าน</span></div>',
      '      <div class="stat"><strong id="statViews">–</strong><span>ยอดวิวรวม</span></div>',
      '    </div>',
      '  </section>',
      '  <section class="filter-bar">',
      '    <label class="search-box">',
      '      <span class="search-icon" aria-hidden="true">🔍</span>',
      '      <input id="reviewSearch" type="search" placeholder="ค้นหาร้าน ย่าน หรือเมนู…" autocomplete="off" aria-label="ค้นหารีวิว">',
      '    </label>',
      '    <label class="sort-box">',
      '      <span>เรียงโดย</span>',
      '      <select id="reviewSort">',
      '        <option value="new">ใหม่สุด</option>',
      '        <option value="popular">ยอดนิยม</option>',
      '        <option value="name">ชื่อ ก–ฮ</option>',
      '      </select>',
      '    </label>',
      '  </section>',
      '  <div class="chip-row" id="reviewChips">' + chips + '</div>',
      '  <h2 class="sr-only">ผลการค้นหารีวิว</h2>',
      '  <p class="result-count" id="reviewCount">พบ ' + posts.length + ' ร้าน</p>',
      '  <div class="post-grid" id="reviewGrid">',
      cards,
      '  </div>',
      '  <div class="empty" id="reviewEmpty" hidden><div style="font-size:52px">🔎</div><p>ไม่พบร้านที่ตรงกับคำค้น — ลองคำอื่นหรือเลือก “ทั้งหมด”</p></div>',
      '  <section class="zone-links">',
      '    <div class="section-head"><div><h2>คาเฟ่ตามย่าน</h2><p>เปิดหน้าเฉพาะของแต่ละย่าน พร้อมรายชื่อร้านทั้งหมด</p></div></div>',
      '    <div class="chip-row">',
      zones.map(function (z) { return '      <a class="chip" href="/cafe/' + zoneSlug_(z) + '/">คาเฟ่' + esc_(z) + '</a>'; }).join('\n'),
      '    </div>',
      '  </section>',
      '</main>',
      Site.footer_(),
      '<script src="/assets/reviews.js" defer></script>',
      '</body>',
      '</html>'
    ].join('\n');
  },

  cards_: function (posts) {
    return posts.map(function (p) {
      var href = '/posts/' + p.slug + '/';
      var img = p.photo
        ? '<img src="/' + esc_(p.photo) + '" alt="' + esc_(p.name) + '" loading="lazy" width="640" height="440">'
        : '<span class="card-auto"><strong>' + esc_(p.name) + '</strong></span>';
      return [
        '      <article class="card" data-zone="' + esc_(p.zone || 'กรุงเทพฯ') + '">',
        '        <a class="card-photo' + (p.photo ? '' : ' cover-auto') + '" href="' + href + '"><span class="zone">' + esc_(p.zone || 'กรุงเทพฯ') + '</span>' + img + '</a>',
        '        <div class="card-body">',
        '          <h3><a href="' + href + '">' + esc_(p.title) + '</a></h3>',
        p.excerpt ? '          <p>' + esc_(p.excerpt) + '</p>' : '',
        '          <div class="card-meta"><span>' + esc_(thaiDate_(p.date)) + '</span></div>',
        '        </div>',
        '      </article>'
      ].filter(Boolean).join('\n');
    }).join('\n');
  },

  /** ปกอัตโนมัติ (ไม่มีรูปจริง) — ใช้ CSS พาสเทล + ชื่อร้าน + โซน */
  coverAuto_: function (item) {
    return [
      '<div class="cover-auto-inner">',
      '  <span class="cover-zone">' + esc_(item.zone || 'กรุงเทพฯ') + '</span>',
      '  <span class="cover-name">' + esc_(item.name) + '</span>',
      '  <span class="cover-brand">☕ ไปคาเฟ่กัน · รีวิวคาเฟ่กรุงเทพฯ</span>',
      '</div>'
    ].join('\n      ');
  },

  head_: function (o) {
    var robots = o.robots || 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1';
    var tags = (o.tags || []).map(function (t) {
      return String(t || '').replace(/^#/, '').trim();
    }).filter(Boolean);

    var jsonLd = '';
    if (o.jsonLd && o.jsonLd.length) {
      jsonLd = '<script type="application/ld+json">' + JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': o.jsonLd
      }).replace(/</g, '\\u003c') + '</script>';
    }

    return [
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>' + esc_(o.title) + '</title>',
      '<meta name="description" content="' + esc_(o.desc) + '">',
      '<meta name="robots" content="' + esc_(robots) + '">',
      '<link rel="canonical" href="' + esc_(o.canonical) + '">',
      '<link rel="alternate" hreflang="th-TH" href="' + esc_(o.canonical) + '">',
      '<link rel="alternate" hreflang="x-default" href="' + esc_(o.canonical) + '">',
      '<meta name="theme-color" content="#eef7fd">',
      '<meta name="author" content="ทีมไปคาเฟ่กัน">',
      '<link rel="preconnect" href="https://fonts.googleapis.com">',
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
      '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;500;600&family=Prompt:wght@500;600;700&display=swap" rel="stylesheet">',
      o.preload ? '<link rel="preload" as="image" href="' + esc_(o.preload) + '" fetchpriority="high">' : '',
      '<link rel="stylesheet" href="/assets/style.css">',
      '<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">',
      '<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">',
      '<meta property="og:site_name" content="ไปคาเฟ่กัน">',
      '<meta property="og:locale" content="th_TH">',
      '<meta property="og:title" content="' + esc_(o.title) + '">',
      '<meta property="og:description" content="' + esc_(o.desc) + '">',
      '<meta property="og:type" content="' + esc_(o.type || 'website') + '">',
      '<meta property="og:url" content="' + esc_(o.url) + '">',
      o.image ? '<meta property="og:image" content="' + esc_(o.image) + '">' : '',
      o.image ? '<meta property="og:image:secure_url" content="' + esc_(o.image) + '">' : '',
      o.imageAlt ? '<meta property="og:image:alt" content="' + esc_(o.imageAlt) + '">' : '',
      '<meta name="twitter:card" content="' + (o.image ? 'summary_large_image' : 'summary') + '">',
      '<meta name="twitter:title" content="' + esc_(o.title) + '">',
      '<meta name="twitter:description" content="' + esc_(o.desc) + '">',
      o.image ? '<meta name="twitter:image" content="' + esc_(o.image) + '">' : '',
      o.published ? '<meta property="article:published_time" content="' + esc_(o.published) + '">' : '',
      o.modified ? '<meta property="article:modified_time" content="' + esc_(o.modified) + '">' : '',
      o.section ? '<meta property="article:section" content="' + esc_(o.section) + '">' : '',
      tags.map(function (t) { return '<meta property="article:tag" content="' + esc_(t) + '">'; }).join('\n'),
      jsonLd,
      '<link rel="alternate" type="application/rss+xml" title="ไปคาเฟ่กัน" href="/feed.xml">',
      '</head>'
    ].filter(Boolean).join('\n');
  },

  /* ---------------- structured data (Schema.org / Rich Results) ---------------- */

  /** ข้อมูลองค์กร — ใช้ร่วมทุกหน้า */
  orgNode_: function (base) {
    return {
      '@type': 'Organization',
      '@id': base + '/#org',
      'name': 'ไปคาเฟ่กัน',
      'url': base + '/',
      'logo': {
        '@type': 'ImageObject',
        'url': base + '/assets/logo-512.png',
        'width': 512,
        'height': 512
      },
      'description': 'รีวิวคาเฟ่และร้านกาแฟในกรุงเทพฯ คัดร้านบรรยากาศดี กาแฟมีคุณภาพ พร้อมข้อมูลการเดินทาง'
    };
  },

  /** เว็บไซต์ + ช่องค้นหา (Sitelinks Search Box) */
  siteNode_: function (base) {
    return {
      '@type': 'WebSite',
      '@id': base + '/#website',
      'url': base + '/',
      'name': 'ไปคาเฟ่กัน',
      'description': 'รีวิวคาเฟ่กรุงเทพฯ กาแฟดี บรรยากาศดี อัปเดตทุกวัน',
      'inLanguage': 'th-TH',
      'publisher': { '@id': base + '/#org' },
      'potentialAction': {
        '@type': 'SearchAction',
        'target': {
          '@type': 'EntryPoint',
          'urlTemplate': base + '/reviews/?q={search_term_string}'
        },
        'query-input': 'required name=search_term_string'
      }
    };
  },

  /** หน้ารวมลิสต์ (หน้าแรก / reviews) */
  collectionNode_: function (o) {
    return {
      '@type': 'CollectionPage',
      '@id': o.id,
      'url': o.url,
      'name': o.name,
      'description': o.desc,
      'isPartOf': { '@id': o.base + '/#website' },
      'inLanguage': 'th-TH',
      'mainEntity': {
        '@type': 'ItemList',
        'numberOfItems': o.posts.length,
        'itemListOrder': 'https://schema.org/ItemListOrderDescending',
        'itemListElement': o.posts.map(function (p, i) {
          return {
            '@type': 'ListItem',
            'position': i + 1,
            'url': o.base + '/posts/' + p.slug + '/',
            'name': p.title
          };
        })
      }
    };
  },

  /** บทความ (BlogPosting) */
  articleNode_: function (item, base, canonical, desc, images) {
    var t = isoDateTime_(item.date);
    var keywords = (item.tags || []).map(function (s) { return String(s || '').replace(/^#/, '').trim(); }).filter(Boolean);
    return {
      '@type': 'BlogPosting',
      '@id': canonical + '#article',
      'headline': String(item.title || '').slice(0, 110),
      'description': desc,
      'image': images.length ? images : undefined,
      'datePublished': t,
      'dateModified': t,
      'author': {
        '@type': 'Organization',
        'name': 'ทีมไปคาเฟ่กัน',
        'url': base + '/about/'
      },
      'publisher': { '@id': base + '/#org' },
      'mainEntityOfPage': { '@type': 'WebPage', '@id': canonical },
      'isPartOf': { '@id': base + '/#website' },
      'inLanguage': 'th-TH',
      'articleSection': item.zone || 'กรุงเทพฯ',
      'keywords': keywords.join(', ')
    };
  },

  /** ข้อมูลร้าน (CafeOrCoffeeShop) — ใช้เฉพาะข้อมูลจริงที่มี */
  placeNode_: function (item, base, canonical, desc, images) {
    var node = {
      '@type': 'CafeOrCoffeeShop',
      '@id': canonical + '#place',
      'name': item.name,
      'url': canonical,
      'description': desc,
      'image': images.length ? images : undefined,
      'servesCuisine': 'Coffee',
      'isPartOf': { '@id': base + '/#website' }
    };
    if (item.address) {
      node.address = {
        '@type': 'PostalAddress',
        'streetAddress': item.address,
        'addressLocality': 'กรุงเทพมหานคร',
        'addressRegion': 'กรุงเทพมหานคร',
        'addressCountry': 'TH'
      };
    }
    if (item.lat && item.lon) {
      node.geo = {
        '@type': 'GeoCoordinates',
        'latitude': Number(item.lat),
        'longitude': Number(item.lon)
      };
    }
    if (item.hours && /[A-Za-z]/.test(item.hours) && /:/.test(item.hours)) {
      node.openingHours = String(item.hours).split(/\s*·\s*/).filter(Boolean);
    }
    var same = [item.website, item.mapsUrl].filter(Boolean);
    if (same.length) node.sameAs = same;
    if (item.mapsUrl) node.hasMap = item.mapsUrl;
    return node;
  },

  /** เส้นทางนำทาง (BreadcrumbList) */
  crumbNode_: function (base, zone, item, canonical) {
    var list = [
      { '@type': 'ListItem', 'position': 1, 'name': 'หน้าแรก', 'item': base + '/' }
    ];
    if (zone) {
      list.push({
        '@type': 'ListItem',
        'position': 2,
        'name': 'คาเฟ่' + zone,
        'item': base + '/cafe/' + zoneSlug_(zone) + '/'
      });
    }
    list.push({
      '@type': 'ListItem',
      'position': list.length + 1,
      'name': item.name,
      'item': canonical
    });
    return { '@type': 'BreadcrumbList', '@id': canonical + '#breadcrumb', 'itemListElement': list };
  },

  /** คำถามที่พบบ่อย (FAQPage) */
  faqNode_: function (item, canonical) {
    return {
      '@type': 'FAQPage',
      '@id': canonical + '#faq',
      'mainEntity': item.faq.map(function (f) {
        return {
          '@type': 'Question',
          'name': f.question,
          'acceptedAnswer': { '@type': 'Answer', 'text': f.answer }
        };
      })
    };
  },

  /** robots.txt — ชี้ sitemap ให้ crawler เจอทันที */
  renderRobots_: function (cfg) {
    var base = String(cfg.siteBase || '').replace(/\/+$/, '');
    return [
      'User-agent: *',
      'Allow: /',
      'Disallow: /api/',
      '',
      'Sitemap: ' + base + '/sitemap.xml',
      ''
    ].join('\n');
  },

  /** เมนู "ย่าน" แบบ dropdown (แสดงเฉพาะหน้าแรกที่มีรายการโซน) */
  zoneFilter_: function (zones) {
    var items = ['<button type="button" class="zone-item active" data-zone="all">ทั้งหมด</button>']
      .concat(zones.map(function (z) {
        return '<button type="button" class="zone-item" data-zone="' + esc_(z) + '">' + esc_(z) + '</button>';
      }))
      .join('\n            ');
    return [
      '      <div class="zone-filter" id="zoneFilter">',
      '        <button type="button" class="zone-filter-btn" aria-haspopup="true" aria-expanded="false">',
      '          <span class="zone-filter-label">ย่าน</span><span class="caret">▾</span>',
      '        </button>',
      '        <div class="zone-menu">',
      '            ' + items,
      '        </div>',
      '      </div>'
    ].join('\n');
  },

  header_: function (zones) {
    var zoneNav = (zones && zones.length) ? Site.zoneFilter_(zones) : '';
    return [
      '<header class="site-header">',
      '  <div class="header-inner">',
      '    <a class="brand" href="/"><span class="brand-mark">☕</span><span>ไปคาเฟ่กัน<small>paicafekan.com</small></span></a>',
      '    <nav class="nav">',
      '      <a href="/">หน้าแรก</a>',
      zoneNav,
      '      <a href="/#latest">รีวิวล่าสุด</a>',
      '      <a href="/reviews/">รวมรีวิว</a>',
      '      <a href="/about/">เกี่ยวกับ</a>',
      '      <a class="cta" href="/#latest">ไปดูร้าน</a>',
      '    </nav>',
      '  </div>',
      '</header>'
    ].filter(Boolean).join('\n');
  },

  footer_: function () {
    return [
      '<footer class="site-footer">',
      '  <div class="footer-inner">',
      '    <span>© ' + (new Date().getFullYear() + 543) + ' ไปคาเฟ่กัน · paicafekan.com</span>',
      '    <div class="footer-links"><a href="/cafe/">ย่าน</a><a href="/reviews/">รวมรีวิว</a><a href="/about/">เกี่ยวกับ</a><a href="/sitemap.xml">Sitemap</a><a href="/feed.xml">RSS</a></div>',
      '  </div>',
      '</footer>'
    ].join('\n');
  },

  /** Markdown แบบง่าย -> กลุ่มบล็อก HTML (ใช้แทรกรูปกลางเนื้อหา) */
  mdBlocks_: function (md) {
    var lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    var out = [];
    var list = null;
    var para = [];

    function flushPara() {
      if (para.length) {
        out.push({ type: 'p', html: '<p>' + inlineMd_(para.join(' ')) + '</p>' });
        para = [];
      }
    }
    function flushList() {
      if (list) {
        out.push({ type: list.type, html: '<' + list.type + '>' + list.items.map(function (s) {
          return '<li>' + inlineMd_(s) + '</li>';
        }).join('') + '</' + list.type + '>' });
        list = null;
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var line = raw.replace(/\s+$/, '');
      if (!line.trim()) { flushPara(); flushList(); continue; }

      if (/^\s*---+\s*$/.test(line)) { flushPara(); flushList(); out.push({ type: 'hr', html: '<hr>' }); continue; }

      var h = line.match(/^(#{2,4})\s+(.*)$/);
      if (h) {
        flushPara(); flushList();
        var lvl = h[1].length;
        out.push({ type: 'h' + lvl, html: '<h' + lvl + '>' + inlineMd_(h[2]) + '</h' + lvl + '>' });
        continue;
      }

      var ul = line.match(/^\s*[-*]\s+(.*)$/);
      if (ul) {
        flushPara();
        if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
        list.items.push(ul[1]);
        continue;
      }

      var ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ol) {
        flushPara();
        if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
        list.items.push(ol[1]);
        continue;
      }

      var q = line.match(/^>\s?(.*)$/);
      if (q) {
        flushPara(); flushList();
        out.push({ type: 'blockquote', html: '<blockquote>' + inlineMd_(q[1]) + '</blockquote>' });
        continue;
      }

      para.push(line.trim());
    }
    flushPara(); flushList();
    return out;
  },

  /** Markdown แบบง่าย -> HTML (ยังใช้ได้เหมือนเดิม) */
  md_: function (md) {
    return Site.mdBlocks_(md).map(function (b) { return '    ' + b.html; }).join('\n');
  },

  renderSitemap_: function (manifest, cfg) {
    var base = String(cfg.siteBase || '').replace(/\/+$/, '');
    var latest = manifest.length ? String(manifest[0].date || '') : '';
    var rows = [
      '  <url><loc>' + esc_(base + '/') + '</loc>' + (latest ? '<lastmod>' + esc_(latest) + '</lastmod>' : '') + '<changefreq>daily</changefreq><priority>1.0</priority></url>',
      '  <url><loc>' + esc_(base + '/reviews/') + '</loc>' + (latest ? '<lastmod>' + esc_(latest) + '</lastmod>' : '') + '<changefreq>daily</changefreq><priority>0.9</priority></url>',
      '  <url><loc>' + esc_(base + '/cafe/') + '</loc>' + (latest ? '<lastmod>' + esc_(latest) + '</lastmod>' : '') + '<changefreq>weekly</changefreq><priority>0.8</priority></url>',
      '  <url><loc>' + esc_(base + '/about/') + '</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>'
    ];
    var zoneLatest = {};
    manifest.forEach(function (p) {
      var z = p.zone || 'กรุงเทพฯ';
      if (!zoneLatest[z] || String(p.date) > zoneLatest[z]) zoneLatest[z] = String(p.date || '');
    });
    Object.keys(zoneLatest).sort().forEach(function (z) {
      rows.push('  <url><loc>' + esc_(base + '/cafe/' + zoneSlug_(z) + '/') + '</loc>' +
        (zoneLatest[z] ? '<lastmod>' + esc_(zoneLatest[z]) + '</lastmod>' : '') +
        '<changefreq>weekly</changefreq><priority>0.7</priority></url>');
    });
    manifest.forEach(function (p) {
      var images = (p.photos && p.photos.length ? p.photos : (p.photo ? [p.photo] : [])).map(function (img) {
        return '    <image:image><image:loc>' + esc_(base + '/' + img) + '</image:loc></image:image>';
      }).join('\n');
      rows.push([
        '  <url>',
        '    <loc>' + esc_(base + '/posts/' + p.slug + '/') + '</loc>',
        '    <lastmod>' + esc_(p.date) + '</lastmod><changefreq>weekly</changefreq><priority>0.8</priority>',
        images,
        '  </url>'
      ].filter(Boolean).join('\n'));
    });
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
      rows.join('\n'),
      '</urlset>'
    ].join('\n');
  },

  renderFeed_: function (manifest, cfg) {
    var base = String(cfg.siteBase || '').replace(/\/+$/, '');
    var items = manifest.slice(0, 20).map(function (p) {
      var url = base + '/posts/' + p.slug + '/';
      var pubDate = '';
      try { pubDate = new Date(p.date + 'T07:00:00+07:00').toUTCString(); } catch (e) {}
      return [
        '    <item>',
        '      <title>' + esc_(p.title) + '</title>',
        '      <link>' + esc_(url) + '</link>',
        '      <guid isPermaLink="true">' + esc_(url) + '</guid>',
        '      <description>' + esc_(p.excerpt || '') + '</description>',
        p.zone ? '      <category>' + esc_(p.zone) + '</category>' : '',
        pubDate ? '      <pubDate>' + esc_(pubDate) + '</pubDate>' : '',
        '    </item>'
      ].filter(Boolean).join('\n');
    }).join('\n');

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0"><channel>',
      '    <title>ไปคาเฟ่กัน</title>',
      '    <link>' + esc_(base + '/') + '</link>',
      '    <description>รีวิวคาเฟ่กรุงเทพฯ กาแฟดี บรรยากาศดี</description>',
      '    <language>th</language>',
      manifest.length ? '    <lastBuildDate>' + esc_(new Date(manifest[0].date + 'T07:00:00+07:00').toUTCString()) + '</lastBuildDate>' : '',
      items,
      '</channel></rss>'
    ].filter(Boolean).join('\n');
  },

  /* ---------------- หน้า hub ตามย่าน (SEO: "คาเฟ่<ย่าน>") ---------------- */

  renderZone_: function (zone, posts, manifest, cfg) {
    var base = String(cfg.siteBase || '').replace(/\/+$/, '');
    var slug = zoneSlug_(zone);
    var canonical = base + '/cafe/' + slug + '/';
    var n = posts.length;
    var latest = posts.length ? String(posts[0].date || '') : '';
    var name = 'คาเฟ่' + zone;
    var title = name + ' รวม ' + n + ' ร้านบรรยากาศดี พิกัดและเวลาเปิด | ไปคาเฟ่กัน';
    var desc = 'รวมรีวิว' + name + ' ' + n + ' ร้าน คัดร้านกาแฟบรรยากาศดี พร้อมที่ตั้ง เวลาเปิด และแผนที่' +
      (latest ? ' อัปเดตล่าสุด ' + thaiDate_(latest) : '');

    var head = Site.head_({
      title: title,
      desc: desc,
      canonical: canonical,
      url: canonical,
      type: 'website',
      image: posts.length && posts[0].photo ? base + '/' + posts[0].photo : '',
      imageAlt: name,
      jsonLd: [
        Site.orgNode_(base),
        Site.siteNode_(base),
        Site.collectionNode_({
          id: canonical + '#webpage',
          url: canonical,
          name: name,
          desc: desc,
          base: base,
          posts: posts
        }),
        {
          '@type': 'BreadcrumbList',
          '@id': canonical + '#breadcrumb',
          'itemListElement': [
            { '@type': 'ListItem', 'position': 1, 'name': 'หน้าแรก', 'item': base + '/' },
            { '@type': 'ListItem', 'position': 2, 'name': 'ย่านทั้งหมด', 'item': base + '/cafe/' },
            { '@type': 'ListItem', 'position': 3, 'name': name, 'item': canonical }
          ]
        }
      ]
    });

    var otherZones = [];
    (manifest || []).forEach(function (m) {
      var z = m.zone || 'กรุงเทพฯ';
      if (z !== zone && otherZones.indexOf(z) === -1) otherZones.push(z);
    });

    return [
      '<!DOCTYPE html>',
      '<html lang="th">',
      head,
      '<body>',
      Site.header_(),
      '<main class="wrap">',
      '  <nav class="breadcrumb" aria-label="breadcrumb">',
      '    <a href="/">หน้าแรก</a><span aria-hidden="true">›</span>',
      '    <a href="/cafe/">ย่านทั้งหมด</a><span aria-hidden="true">›</span>',
      '    <span aria-current="page">' + esc_(name) + '</span>',
      '  </nav>',
      '  <section class="reviews-hero">',
      '    <span class="eyebrow">✦ คาเฟ่ตามย่าน</span>',
      '    <h1>คาเฟ่<em>' + esc_(zone) + '</em></h1>',
      '    <p class="lead">รวม ' + n + ' ร้านคาเฟ่ในย่าน' + esc_(zone) +
        ' ที่เราเก็บรายละเอียดไว้ทั้งบรรยากาศ เมนู และการเดินทาง — เลือกร้านที่ถูกใจแล้วกดอ่านต่อได้เลย</p>',
      '    <div class="stat-row">',
      '      <div class="stat"><strong>' + n + '</strong><span>ร้านในย่านนี้</span></div>',
      '      <div class="stat"><strong>' + (latest ? esc_(thaiDate_(latest)) : '-') + '</strong><span>อัปเดตล่าสุด</span></div>',
      '      <div class="stat"><strong>' + (manifest || []).length + '</strong><span>รีวิวทั้งเว็บ</span></div>',
      '    </div>',
      '  </section>',
      '  <h2 class="sr-only">รีวิวคาเฟ่ในย่าน ' + esc_(zone) + '</h2>',
      '  <div class="post-grid">',
      n ? Site.cards_(posts) : '    <div class="empty"><p>ยังไม่มีรีวิวในย่านนี้ — กำลังเก็บข้อมูลอยู่</p></div>',
      '  </div>',
      otherZones.length ? [
        '  <section class="zone-links">',
        '    <div class="section-head">',
        '      <div><h2>ย่านอื่นที่น่าสนใจ</h2><p>เลือกดูคาเฟ่ในย่านที่ใกล้เคียง</p></div>',
        '      <a class="more" href="/cafe/">ย่านทั้งหมด →</a>',
        '    </div>',
        '    <div class="chip-row">',
        otherZones.map(function (z) {
          return '      <a class="chip" href="/cafe/' + zoneSlug_(z) + '/">คาเฟ่' + esc_(z) + '</a>';
        }).join('\n'),
        '    </div>',
        '  </section>'
      ].join('\n') : '',
      '</main>',
      Site.footer_(),
      '</body>',
      '</html>'
    ].filter(Boolean).join('\n');
  },

  renderZones_: function (manifest, cfg) {
    var base = String(cfg.siteBase || '').replace(/\/+$/, '');
    var canonical = base + '/cafe/';
    var counts = {};
    (manifest || []).forEach(function (m) {
      var z = m.zone || 'กรุงเทพฯ';
      counts[z] = (counts[z] || 0) + 1;
    });
    var zones = Object.keys(counts).sort();
    var desc = 'รวมคาเฟ่กรุงเทพฯ แยกตามย่าน ' + zones.length + ' ย่าน — เอกมัย ทองหล่อ อารีย์ สยาม และอื่น ๆ พร้อมรีวิวและพิกัด';

    var head = Site.head_({
      title: 'คาเฟ่ตามย่านในกรุงเทพฯ ' + zones.length + ' ย่าน | ไปคาเฟ่กัน',
      desc: desc,
      canonical: canonical,
      url: canonical,
      type: 'website',
      image: manifest && manifest.length && manifest[0].photo ? base + '/' + manifest[0].photo : '',
      imageAlt: 'คาเฟ่ตามย่านในกรุงเทพฯ',
      jsonLd: [
        Site.orgNode_(base),
        Site.siteNode_(base),
        Site.collectionNode_({
          id: canonical + '#webpage',
          url: canonical,
          name: 'คาเฟ่ตามย่าน',
          desc: desc,
          base: base,
          posts: []
        })
      ]
    });

    return [
      '<!DOCTYPE html>',
      '<html lang="th">',
      head,
      '<body>',
      Site.header_(),
      '<main class="wrap">',
      '  <nav class="breadcrumb" aria-label="breadcrumb">',
      '    <a href="/">หน้าแรก</a><span aria-hidden="true">›</span>',
      '    <span aria-current="page">ย่านทั้งหมด</span>',
      '  </nav>',
      '  <section class="reviews-hero">',
      '    <span class="eyebrow">✦ เลือกตามย่าน</span>',
      '    <h1>คาเฟ่<em>ตามย่าน</em>ในกรุงเทพฯ</h1>',
      '    <p class="lead">เลือกย่านที่คุณจะไป แล้วดูร้านที่เราคัดไว้ — บรรยากาศดี เดินทางสะดวก พร้อมข้อมูลจริงก่อนออกเดินทาง</p>',
      '  </section>',
      '  <div class="chip-row">',
      zones.map(function (z) {
        return '      <a class="chip" href="/cafe/' + zoneSlug_(z) + '/">คาเฟ่' + esc_(z) + ' (' + counts[z] + ')</a>';
      }).join('\n'),
      '  </div>',
      '  <section class="zone-links">',
      '    <div class="section-head">',
      '      <div><h2>ดูรีวิวทั้งหมด</h2><p>ค้นหาและกรองร้านได้ในหน้าเดียว</p></div>',
      '      <a class="more" href="/reviews/">ไปที่รวมรีวิว →</a>',
      '    </div>',
      '  </section>',
      '</main>',
      Site.footer_(),
      '</body>',
      '</html>'
    ].join('\n');
  }
};

/* ---------------- ย่าน: slug สำหรับ URL ---------------- */

var ZONE_SLUGS = {
  'สยาม': 'siam',
  'อารีย์': 'ari',
  'ทองหล่อ': 'thonglor',
  'เอกมัย': 'ekamai',
  'อโศก': 'asoke',
  'พระโขนง': 'phra-khanong',
  'พระนคร': 'phra-nakhon',
  'บางรัก': 'bang-rak',
  'พญาไท': 'phaya-thai',
  'จตุจักร': 'chatuchak',
  'บางนา': 'bang-na',
  'รัชดา': 'ratchada',
  'สาทร': 'sathorn',
  'สีลม': 'silom',
  'พร้อมพงษ์': 'phrom-phong',
  'เจริญกรุง': 'charoen-krung',
  'เยาวราช': 'yaowarat',
  'อ่อนนุช': 'on-nut',
  'ลาดพร้าว': 'lat-phrao',
  'รามคำแหง': 'ramkhamhaeng',
  'สะพานควาย': 'saphan-khwai',
  'ราชเทวี': 'ratchathewi',
  'ดินแดง': 'din-daeng',
  'ห้วยขวาง': 'huai-khwang',
  'บางกะปิ': 'bang-kapi',
  'บางเขน': 'bang-khen',
  'ดอนเมือง': 'don-mueang',
  'หลักสี่': 'lak-si',
  'มีนบุรี': 'min-buri',
  'หนองจอก': 'nong-chok',
  'คลองสาน': 'khlong-san',
  'ธนบุรี': 'thonburi',
  'บางกอกน้อย': 'bangkok-noi',
  'บางกอกใหญ่': 'bangkok-yai',
  'ภาษีเจริญ': 'phasi-charoen',
  'ตลิ่งชัน': 'taling-chan',
  'บางแค': 'bang-khae',
  'จอมทอง': 'chom-thong',
  'บางขุนเทียน': 'bang-khun-thian',
  'ราษฎร์บูรณะ': 'rat-burana',
  'ทุ่งครุ': 'thung-khru',
  'สวนหลวง': 'suan-luang',
  'ประเวศ': 'prawet',
  'คันนายาว': 'khan-na-yao',
  'บึงกุ่ม': 'bueng-kum',
  'วังทองหลาง': 'wang-thonglang',
  'สายไหม': 'sai-mai',
  'บางซื่อ': 'bang-sue',
  'ดุสิต': 'dusit',
  'ป้อมปราบ': 'pom-prap',
  'สัมพันธวงศ์': 'samphanthawong',
  'ปทุมวัน': 'pathum-wan',
  'วัฒนา': 'watthana',
  'คลองเตย': 'khlong-toei',
  'ตลาดพลู': 'talat-phlu',
  'กรุงเทพฯ': 'bangkok'
};

function zoneSlug_(zone) {
  var z = String(zone || '').trim();
  if (ZONE_SLUGS[z]) return ZONE_SLUGS[z];
  var ascii = z.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (ascii) return ascii;
  var h = 0;
  for (var i = 0; i < z.length; i++) h = (h * 31 + z.charCodeAt(i)) % 100000;
  return 'zone-' + h;
}

function zoneFromSlug_(slug) {
  for (var k in ZONE_SLUGS) if (ZONE_SLUGS[k] === slug) return k;
  return '';
}

/* ---------------- helpers ---------------- */

function esc_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** แปลง **ตัวหนา**, *เอียง*, [ลิงก์](url) */
function inlineMd_(s) {
  var t = esc_(s);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t;
}

/** yyyy-MM-dd -> 30 ตุลาคม 2569 */
function thaiDate_(iso) {
  if (!iso) return '';
  var m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso);
  var months = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  return parseInt(m[3], 10) + ' ' + months[parseInt(m[2], 10) - 1] + ' ' + (parseInt(m[1], 10) + 543);
}

/** ประมาณเวลาอ่าน (นาที) */
function readingTime_(body) {
  var chars = String(body || '').replace(/\s/g, '').length;
  return Math.max(3, Math.round(chars / 700));
}

/** คำอธิบายสำหรับ meta description / schema — จำกัดความยาวและมี fallback */
function seoDescription_(item) {
  var d = String(item.metaDescription || item.excerpt || '').replace(/\s+/g, ' ').trim();
  if (d.length > 158) {
    d = d.slice(0, 155);
    var sp = d.lastIndexOf(' ');
    if (sp > 100) d = d.slice(0, sp);
    d = d.replace(/[\s,;:–—-]+$/, '') + '…';
  }
  if (!d) {
    d = 'คาเฟ่' + (item.zone || 'กรุงเทพฯ') + ' ' + (item.name || '') +
      ' — บรรยากาศดี กาแฟมีคุณภาพ พร้อมที่ตั้ง เวลาเปิด และแผนที่สำหรับไปลอง';
  }
  return d;
}

/** yyyy-MM-dd -> ISO 8601 พร้อมเขตเวลาไทย (ใช้ใน schema / og article) */
function isoDateTime_(iso) {
  var s = String(iso || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s;
  var m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] + 'T07:00:00+07:00' : '';
}

/** ถอด HTML entity กลับเป็นข้อความ (ใช้ตอนดึงข้อมูลจากหน้าโพสต์เดิม) */
function unescapeHtml_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** สร้าง slug จากชื่อร้าน */
function makeSlug_(name, placeId) {
  var base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  if (!base) base = 'cafe';
  var suffix = String(placeId || '').replace(/[^a-zA-Z0-9]/g, '').slice(-5).toLowerCase();
  if (suffix) base = base + '-' + suffix;
  return base.slice(0, 70);
}

/* ---------------------- Publish.gs ---------------------- */
/**
 * เผยแพร่ขึ้นเว็บ: สร้างหน้า HTML -> commit ขึ้น GitHub -> Cloudflare Pages deploy เอง
 */

var Publish = {

  /** โพสต์รายการที่อนุมัติแล้ว; รายการที่มีลิงก์รูปแต่ดึงไม่ได้เลยถูกตัดทิ้ง ไม่ถูก commit */
  publishItems_: function (cfg, items) {
    if (!cfg.ghToken) throw new Error('ยังไม่ได้ตั้งค่า GITHUB_TOKEN');
    if (!cfg.ghOwner) throw new Error('ยังไม่ได้ตั้งค่า GITHUB_OWNER');

    var manifest = Publish.loadManifest_(cfg);
    var files = [];
    var out = [];
    var failed = [];
    var today = Utilities.formatDate(new Date(), cfg.timezone, 'yyyy-MM-dd');

    items.forEach(function (it) {
      var photoPaths = [];
      var refs = (it.photoRefs && it.photoRefs.length) ? it.photoRefs : (it.photoRef ? [it.photoRef] : []);
      refs.forEach(function (ref) {
        var f = Places.photoFile_(cfg, ref, 1600);
        if (!f) return;
        var p = 'assets/img/posts/' + it.slug + '-' + (photoPaths.length + 1) + '.' + f.ext;
        files.push({ path: p, content: f.b64, encoding: 'base64' });
        photoPaths.push(p);
      });

      // มีลิงก์รูปแต่ดึงไม่ได้เลย -> ไม่โพสต์ (เตือนใน LINE จะมีให้แก้ลิงก์)
      if (refs.length && photoPaths.length === 0) {
        log_('WARN', '-', '-', 'ข้ามโพสต์ ' + it.name + ': รูปโหลดไม่ได้เลย (' + refs.length + ' ลิงก์)');
        failed.push({ row: it.row, name: it.name, error: 'รูป ' + refs.length + ' ลิงก์โหลดไม่ได้ (ทั้งหมด) — ตรวจคอลัมน์ M ว่าแชร์ "ทุกคนที่มีลิงก์" แล้วใส่ ready ใหม่' });
        return;
      }

      // ลบข้อมูลเก่าของสลักเดียวกัน (ถ้ามี) แล้วใส่ใหม่
      manifest = manifest.filter(function (m) { return m.slug !== it.slug; });
      manifest.unshift({
        slug: it.slug,
        name: it.name,
        zone: it.zone,
        title: it.title,
        excerpt: it.excerpt || '',
        date: today,
        photo: photoPaths[0] || '',
        photos: photoPaths,
        tags: it.tags || []
      });

      // ด่านสุดท้ายก่อนขึ้นเว็บ: ตัดข้อมูลที่แต่งเกินจริง + เติม FAQ ให้ครบ 3 ข้อ
      // (ฉบับร่างเก่าที่สร้างก่อนติดกฎ จะถูกทำความสะอาดตอนโพสต์ด้วย)
      try {
        it.body = sanitizeArticleBody_(it.body || '', it, it.zone);
        it = ensureFaq_(it, it.name || '', it.zone || '', it);
      } catch (e) {
        log_('WARN', '-', '-', 'sanitize ก่อนโพสต์ไม่สำเร็จ: ' + (e && e.message ? e.message : e));
      }

      it.photoPaths = photoPaths;
      it.photoPath = photoPaths[0] || '';
      it.date = today;

      files.push({ path: 'posts/' + it.slug + '/index.html', content: Site.renderPost_(it, manifest), encoding: 'utf-8' });
      out.push({ row: it.row, name: it.name, url: cfg.siteBase + '/posts/' + it.slug + '/' });
      // เก็บต้นฉบับไว้ใน Drive เพื่อ rebuild หน้าโพสต์ครั้งหน้าได้โดยไม่ต้องดึงจาก HTML
      savePostSource_(cfg, it);
    });

    if (!out.length && failed.length) {
      return { published: [], failed: failed, out: out };
    }

    // เก็บไว้แค่ 60 โพสต์ล่าสุด
    manifest = manifest.slice(0, 60);

    files.push({ path: 'data/posts.json', content: JSON.stringify(manifest, null, 2), encoding: 'utf-8' });
    files.push({ path: 'index.html', content: Site.renderIndex_(manifest, cfg), encoding: 'utf-8' });
    files.push({ path: 'reviews/index.html', content: Site.renderReviews_(manifest, cfg), encoding: 'utf-8' });
    files = files.concat(Publish.zoneFiles_(manifest, cfg));
    files.push({ path: 'sitemap.xml', content: Site.renderSitemap_(manifest, cfg), encoding: 'utf-8' });
    files.push({ path: 'feed.xml', content: Site.renderFeed_(manifest, cfg), encoding: 'utf-8' });
    files.push({ path: 'robots.txt', content: Site.renderRobots_(cfg), encoding: 'utf-8' });

    var publishedItems = out.map(function (p) { return p.name; }).join(', ');
    GitHub.commit_(cfg, 'post: ' + publishedItems, files);

    return { published: out, failed: failed, out: out };
  },

  /** สร้างหน้าเว็บใหม่ทั้งหมด (index/sitemap/feed) จาก posts.json แล้ว commit — ใช้เมื่อแก้ดีไซน์ */
  republishSite_: function (cfg) {
    if (!cfg.ghToken) throw new Error('ยังไม่ได้ตั้งค่า GITHUB_TOKEN');
    var manifest = Publish.loadManifest_(cfg);
    if (!manifest.length) return { ok: false, reason: 'ยังไม่มีโพสต์ใน data/posts.json' };
    var files = [
      { path: 'data/posts.json', content: JSON.stringify(manifest, null, 2), encoding: 'utf-8' },
      { path: 'index.html', content: Site.renderIndex_(manifest, cfg), encoding: 'utf-8' },
      { path: 'reviews/index.html', content: Site.renderReviews_(manifest, cfg), encoding: 'utf-8' },
      { path: 'sitemap.xml', content: Site.renderSitemap_(manifest, cfg), encoding: 'utf-8' },
      { path: 'feed.xml', content: Site.renderFeed_(manifest, cfg), encoding: 'utf-8' },
      { path: 'robots.txt', content: Site.renderRobots_(cfg), encoding: 'utf-8' }
    ].concat(Publish.zoneFiles_(manifest, cfg));
    var sha = GitHub.commit_(cfg, 'site: rebuild index (' + manifest.length + ' posts)', files);
    return { ok: true, posts: manifest.length, commit: sha };
  },

  /** ไฟล์หน้า hub ตามย่าน (/cafe/ และ /cafe/<slug>/) */
  zoneFiles_: function (manifest, cfg) {
    var byZone = {};
    (manifest || []).forEach(function (m) {
      var z = m.zone || 'กรุงเทพฯ';
      if (!byZone[z]) byZone[z] = [];
      byZone[z].push(m);
    });
    var files = [{ path: 'cafe/index.html', content: Site.renderZones_(manifest, cfg), encoding: 'utf-8' }];
    Object.keys(byZone).sort().forEach(function (z) {
      files.push({
        path: 'cafe/' + zoneSlug_(z) + '/index.html',
        content: Site.renderZone_(z, byZone[z], manifest, cfg),
        encoding: 'utf-8'
      });
    });
    return files;
  },

  /**
   * สร้างหน้าโพสต์ทั้งหมดใหม่ด้วยเทมเพลต SEO ล่าสุด
   * ใช้ต้นฉบับใน Drive (post-<slug>.json) ก่อน ถ้าไม่มีจะดึงเนื้อหาจาก HTML เดิม
   */
  refreshPosts_: function (cfg) {
    if (!cfg.ghToken) throw new Error('ยังไม่ได้ตั้งค่า GITHUB_TOKEN');
    var manifest = Publish.loadManifest_(cfg);
    if (!manifest.length) return { ok: false, reason: 'ยังไม่มีโพสต์ใน data/posts.json' };

    var files = [];
    var used = 0;
    var skipped = [];

    manifest.forEach(function (m) {
      var item = loadPostSource_(cfg, m.slug);
      var fromHtml = false;
      if (!item) {
        var f = GitHub.getFile_(cfg, 'posts/' + m.slug + '/index.html');
        if (!f || !f.content) { skipped.push(m.slug); return; }
        var html = Utilities.newBlob(Utilities.base64Decode(f.content)).getDataAsString('UTF-8');
        item = Publish.itemFromHtml_(m, html);
        fromHtml = true;
      }

      item.slug = m.slug;
      item.title = m.title || item.title;
      item.name = m.name || item.name;
      item.zone = m.zone || item.zone || 'กรุงเทพฯ';
      item.excerpt = m.excerpt || item.excerpt || '';
      item.date = m.date || item.date;
      item.tags = (m.tags && m.tags.length) ? m.tags : (item.tags || []);
      item.photoPaths = (m.photos && m.photos.length) ? m.photos : (m.photo ? [m.photo] : []);
      item.photoPath = item.photoPaths[0] || '';
      if (typeof item.photoManual !== 'boolean') item.photoManual = true;

      files.push({
        path: 'posts/' + m.slug + '/index.html',
        content: Site.renderPost_(item, manifest),
        encoding: 'utf-8'
      });
      used++;

      if (fromHtml) savePostSource_(cfg, item);
    });

    if (!used) return { ok: false, reason: 'ไม่พบหน้าโพสต์ให้ rebuild', skipped: skipped };

    files.push({ path: 'index.html', content: Site.renderIndex_(manifest, cfg), encoding: 'utf-8' });
    files.push({ path: 'reviews/index.html', content: Site.renderReviews_(manifest, cfg), encoding: 'utf-8' });
    files = files.concat(Publish.zoneFiles_(manifest, cfg));
    files.push({ path: 'sitemap.xml', content: Site.renderSitemap_(manifest, cfg), encoding: 'utf-8' });
    files.push({ path: 'feed.xml', content: Site.renderFeed_(manifest, cfg), encoding: 'utf-8' });
    files.push({ path: 'robots.txt', content: Site.renderRobots_(cfg), encoding: 'utf-8' });

    var sha = GitHub.commit_(cfg, 'seo: refresh ' + used + ' post pages', files);
    return { ok: true, posts: used, skipped: skipped, commit: sha };
  },

  /** ดึงข้อมูลที่จำเป็นจากหน้าโพสต์เดิม (ใช้ยามอัปเกรดเทมเพลตย้อนหลัง) */
  itemFromHtml_: function (m, html) {
    var src = String(html || '');
    var item = {
      name: m.name || '',
      zone: m.zone || 'กรุงเทพฯ',
      slug: m.slug,
      title: m.title || '',
      excerpt: m.excerpt || '',
      metaDescription: '',
      bodyHtml: '',
      galleryHtml: '',
      tags: (m.tags || []).slice(),
      address: '',
      hours: '',
      mapsUrl: '',
      website: '',
      lat: '',
      lon: '',
      photoPaths: (m.photos && m.photos.length) ? m.photos : (m.photo ? [m.photo] : []),
      photoManual: src.indexOf('รูปจากทางร้าน') !== -1
    };

    var body = src.match(/<article class="article-body">([\s\S]*?)<\/article>/i);
    if (body) item.bodyHtml = body[1].replace(/^\s+|\s+$/g, '');

    // รูปชุดล่างบทความ (photo-grid) อยู่นอก <article> จึงต้องเก็บแยก ไม่งั้น rebuild แล้วรูปหาย
    var gal = src.match(/<\/article>\s*(<div class="photo-grid">[\s\S]*?<\/div>)/i);
    if (gal) item.galleryHtml = gal[1].replace(/^\s+|\s+$/g, '');

    var desc = src.match(/<meta name="description" content="([^"]*)"/i);
    if (desc) item.metaDescription = unescapeHtml_(desc[1]);

    var addr = src.match(/<span class="k">ที่อยู่<\/span><span class="v">([\s\S]*?)<\/span>/i);
    if (addr) item.address = unescapeHtml_(addr[1].replace(/<[^>]+>/g, '')).trim();

    var hrs = src.match(/<span class="k">เวลาเปิด<\/span><span class="v">([\s\S]*?)<\/span>/i);
    if (hrs) item.hours = unescapeHtml_(hrs[1].replace(/<[^>]+>/g, '')).trim();

    var map = src.match(/<span class="k">แผนที่<\/span><span class="v"><a href="([^"]*)"/i);
    if (map) item.mapsUrl = unescapeHtml_(map[1]);

    var web = src.match(/<span class="k">เว็บไซต์<\/span><span class="v"><a href="([^"]*)"/i);
    if (web) item.website = unescapeHtml_(web[1]);

    if (!item.tags.length) {
      var tagBlock = src.match(/<div class="tags">([\s\S]*?)<\/div>/i);
      if (tagBlock) {
        var re = /<span class="tag">#?([^<]*)<\/span>/gi;
        var tm;
        while ((tm = re.exec(tagBlock[1]))) {
          var tag = unescapeHtml_(tm[1]).trim();
          if (tag) item.tags.push(tag);
        }
      }
    }

    return item;
  },

  /** อ่าน manifest จาก repo (ถ้ายังไม่มี = array ว่าง) */
  loadManifest_: function (cfg) {
    var file = GitHub.getFile_(cfg, 'data/posts.json');
    if (!file || !file.content) return [];
    try {
      var data = JSON.parse(Utilities.newBlob(Utilities.base64Decode(file.content)).getDataAsString('UTF-8'));
      return Array.isArray(data) ? data : [];
    } catch (e) {
      log_('WARN', '-', '-', 'อ่าน posts.json ไม่ได้: ' + e.message);
      return [];
    }
  }
};

/* ------------------------------------------------------------------ */
/*  GitHub Contents / Git Data API                                     */
/* ------------------------------------------------------------------ */

var GitHub = {

  api_: function (cfg, method, path, payload) {
    var url = 'https://api.github.com' + path;
    var opts = {
      method: method,
      headers: {
        'Authorization': 'token ' + cfg.ghToken,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'cafe-bot'
      },
      muteHttpExceptions: true
    };
    if (payload) {
      opts.contentType = 'application/json';
      opts.payload = JSON.stringify(payload);
    }
    var res = UrlFetchApp.fetch(url, opts);
    var code = res.getResponseCode();
    var text = res.getContentText();
    if (code >= 200 && code < 300) {
      return text ? JSON.parse(text) : {};
    }
    throw new Error('GitHub ' + method.toUpperCase() + ' ' + path + ' -> ' + code + ': ' + text.slice(0, 300));
  },

  repoPath_: function (cfg) {
    return '/repos/' + cfg.ghOwner + '/' + cfg.ghRepo;
  },

  getFile_: function (cfg, path) {
    try {
      return GitHub.api_(cfg, 'get', GitHub.repoPath_(cfg) + '/contents/' + path + '?ref=' + encodeURIComponent(cfg.ghBranch));
    } catch (err) {
      if (String(err.message).indexOf('-> 404') !== -1) return null;
      throw err;
    }
  },

  /** commit หลายไฟล์พร้อมกันในครั้งเดียว */
  commit_: function (cfg, message, files) {
    var base = GitHub.repoPath_(cfg);

    var ref = GitHub.api_(cfg, 'get', base + '/git/ref/heads/' + cfg.ghBranch);
    var headSha = ref.object.sha;
    var headCommit = GitHub.api_(cfg, 'get', base + '/git/commits/' + headSha);
    var baseTree = headCommit.tree.sha;

    var tree = files.map(function (f) {
      var blob = GitHub.api_(cfg, 'post', base + '/git/blobs', {
        content: f.content,
        encoding: f.encoding || 'utf-8'
      });
      return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
    });

    var newTree = GitHub.api_(cfg, 'post', base + '/git/trees', { base_tree: baseTree, tree: tree });
    var commit = GitHub.api_(cfg, 'post', base + '/git/commits', {
      message: message,
      tree: newTree.sha,
      parents: [headSha]
    });
    GitHub.api_(cfg, 'patch', base + '/git/refs/heads/' + cfg.ghBranch, { sha: commit.sha, force: false });
    return commit.sha;
  }
};

/** สร้างหน้าเว็บใหม่จาก posts.json (เรียกผ่าน URL: run=republishSite) */
function republishSite() {
  var cfg = getConfig_();
  var r = Publish.republishSite_(cfg);
  log_('INFO', 'SITE', '-', 'republishSite: ' + JSON.stringify(r));
  return r;
}

/** สร้างหน้าโพสต์ทั้งหมดใหม่ด้วยเทมเพลต SEO (เรียกผ่าน URL: run=refreshPostPages) */
function refreshPostPages() {
  var cfg = getConfig_();
  var r = Publish.refreshPosts_(cfg);
  log_('INFO', 'SITE', '-', 'refreshPostPages: ' + JSON.stringify(r));
  return r;
}

/** เก็บ/อ่านต้นฉบับโพสต์ใน Drive (ไว้ rebuild หน้าโพสต์) */
function savePostSource_(cfg, item) {
  try {
    var folder = cfg.folderId ? DriveApp.getFolderById(cfg.folderId) : DriveApp.getRootFolder();
    var name = 'post-' + item.slug + '.json';
    var data = {
      slug: item.slug,
      name: item.name,
      zone: item.zone,
      title: item.title,
      metaDescription: item.metaDescription || '',
      excerpt: item.excerpt || '',
      body: item.body || '',
      bodyHtml: item.bodyHtml || '',
      galleryHtml: item.galleryHtml || '',
      faq: item.faq || [],
      tags: item.tags || [],
      address: item.address || '',
      hours: item.hours || '',
      mapsUrl: item.mapsUrl || '',
      website: item.website || '',
      lat: item.lat || '',
      lon: item.lon || '',
      rating: item.rating || '',
      date: item.date || '',
      docUrl: item.docUrl || ''
    };
    var files = folder.getFilesByName(name);
    while (files.hasNext()) files.next().setTrashed(true);
    folder.createFile(name, JSON.stringify(data), MimeType.PLAIN_TEXT);
  } catch (e) {
    log_('WARN', item && item.name, item && item.row, 'เก็บต้นฉบับโพสต์ไม่สำเร็จ: ' + e.message);
  }
}

function loadPostSource_(cfg, slug) {
  try {
    var folder = cfg.folderId ? DriveApp.getFolderById(cfg.folderId) : DriveApp.getRootFolder();
    var files = folder.getFilesByName('post-' + slug + '.json');
    if (!files.hasNext()) return null;
    var data = JSON.parse(files.next().getBlob().getDataAsString('UTF-8'));
    return (data && (data.body || data.bodyHtml)) ? data : null;
  } catch (e) {
    return null;
  }
}

/** ตรวจว่ารูปแทรกกลางเนื้อหาทำงานไหม (เรียกผ่าน URL: run=testRenderPost) */
function testRenderPost() {
  var body = [];
  for (var i = 1; i <= 8; i++) body.push('ย่อหน้าที่ ' + i + ' เล่าเรื่องบรรยากาศของร้านและเมนูที่ควรลอง');
  var item = {
    name: 'ร้านทดสอบ', zone: 'สยาม', slug: 'test-render', title: 'ทดสอบการแทรกรูป',
    date: '2026-11-08', body: body.join('\n\n'), photos: ['a-1.webp', 'a-2.webp', 'a-3.webp', 'a-4.webp'],
    photoPaths: ['a-1.webp', 'a-2.webp', 'a-3.webp', 'a-4.webp'], tags: ['#ทดสอบ'],
    excerpt: 'ทดสอบ', address: '-', hours: '-', mapsUrl: '#'
  };
  var html = Site.renderPost_(item, []);
  return {
    ok: true,
    len: html.length,
    inlinePhotos: (html.match(/class="article-photo"/g) || []).length,
    galleryPhotos: (html.match(/<figure><img/g) || []).length,
    hasMdWrapper: typeof Site.md_ === 'function'
  };
}

/** เมนู: ทดสอบอ่าน repo */
function testGitHub() {  var cfg = getConfig_();
  var lines = [];
  try {
    var root = GitHub.api_(cfg, 'get', GitHub.repoPath_(cfg));
    lines.push('repo: ' + root.full_name + ' (default: ' + root.default_branch + ')');
    var file = GitHub.getFile_(cfg, 'data/posts.json');
    lines.push('data/posts.json: ' + (file ? 'มี (' + file.size + ' bytes)' : 'ยังไม่มี'));
    var idx = GitHub.getFile_(cfg, 'index.html');
    lines.push('index.html: ' + (idx ? 'มี' : 'ยังไม่มี'));
  } catch (err) {
    lines.push('ผิดพลาด: ' + (err && err.message ? err.message : err));
  }
  var msg = lines.join('\n');
  log_('INFO', 'TEST', '-', 'testGitHub: ' + msg.replace(/\n/g, ' | '));
  try { SpreadsheetApp.getUi().alert('ทดสอบ GitHub\n\n' + msg); } catch (e) {}
  return msg;
}

/* ---------------------- Setup.gs ---------------------- */
/**
 * Setup: ตัวตั้งเวลา + ตรวจสอบการตั้งค่า
 */

var PEAK_TIMES = [
  { hour: 6, minute: 50 }
];

var TIMEZONE = 'Asia/Bangkok';

/** ติดตั้ง trigger 1 รอบ/วัน 06:50 + ตัวตรวจคิวโพสต์ทุก 5 นาที + รายชื่อร้านวันอาทิตย์ 07:00 */
function setupTriggers() {
  removeTriggers();
  PEAK_TIMES.forEach(function (t) {
    ScriptApp.newTrigger('runDailyBatch')
      .timeBased()
      .atHour(t.hour)
      .nearMinute(t.minute)
      .everyDays(1)
      .inTimezone(TIMEZONE)
      .create();
  });
  ScriptApp.newTrigger('runPublishQueue')
    .timeBased()
    .everyMinutes(5)
    .create();
  setupWeeklyTrigger();
  log_('INFO', '-', '-', 'ติดตั้ง trigger เรียบร้อย: สร้างร่าง 06:50 + ตรวจคิวโพสต์ทุก 5 นาที + รายชื่อร้านวันอาทิตย์ 08:00');
  return listTriggers_();
}

/** ติดตั้ง/รีเซ็ต trigger รายชื่อร้านประจำสัปดาห์ (วันอาทิตย์ 08:00) */
function setupWeeklyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (tr) {
    if (tr.getHandlerFunction() === 'seedWeeklyShops') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('seedWeeklyShops')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(8)
    .nearMinute(0)
    .inTimezone(TIMEZONE)
    .create();
  log_('INFO', '-', '-', 'ติดตั้ง trigger รายชื่อร้านวันอาทิตย์ 08:00 เรียบร้อย');
  return listTriggers_();
}

/** ลบ trigger ของระบบนี้ทั้งหมด */
function removeTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  triggers.forEach(function (tr) {
    var fn = tr.getHandlerFunction();
    if (fn === 'runNow' || fn === 'runDailyBatch' || fn === 'runPublishQueue' || fn === 'seedWeeklyShops') {
      ScriptApp.deleteTrigger(tr);
      removed++;
    }
  });
  return removed;
}

/* ---------------- รายชื่อร้านประจำสัปดาห์ (ทุกวันอาทิตย์ 07:00) ---------------- */

/** จุดกลางย่าน ใช้เดาย่านจากพิกัดร้านใน OSM */
var ZONE_CENTERS = [
  { zone: 'สยาม', lat: 13.7466, lon: 100.5347 },
  { zone: 'อารีย์', lat: 13.7799, lon: 100.5447 },
  { zone: 'ทองหล่อ', lat: 13.7323, lon: 100.5822 },
  { zone: 'เอกมัย', lat: 13.7240, lon: 100.5845 },
  { zone: 'อโศก', lat: 13.7370, lon: 100.5600 },
  { zone: 'พระโขนง', lat: 13.7100, lon: 100.5900 },
  { zone: 'พระนคร', lat: 13.7550, lon: 100.5000 },
  { zone: 'บางรัก', lat: 13.7280, lon: 100.5140 },
  { zone: 'พญาไท', lat: 13.7565, lon: 100.5385 },
  { zone: 'จตุจักร', lat: 13.8000, lon: 100.5500 },
  { zone: 'บางนา', lat: 13.6700, lon: 100.6000 },
  { zone: 'รัชดา', lat: 13.7700, lon: 100.5700 }
];

/** ชื่อร้านเครือ/แมส มาร์เก็ต — ห้ามเข้ารายการ */
var CHAIN_WORDS = [
  'amazon', 'อเมซอน', 'chao doi', 'ชาวดอย', 'black canyon', 'flash coffee',
  'after you', 'true coffee', 'arabica', 'starbucks', 'mccafe', 'dunkin',
  'krispy kreme', 'tim horton', 'inthanin', 'อินทนิล', 'cha tra mue', 'ชาตรามือ',
  'open house', 'cafe nero', 'blue bottle', 'costa coffee', 'pacific coffee',
  'heytea', 'ucc ', 'roots at', 'real grocers', 'tom n toms', 'tomntoms', 'brasserie', 'brewery'
];

/** แปลงชื่อให้เทียบกันได้ (ตัดช่องว่าง/ตัวพิมพ์) */
function normShopName_(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[.,'’`"()\[\]-]/g, '');
}

/** ระยะทางโดยประมาณ (กม.) */
function distKm_(lat1, lon1, lat2, lon2) {
  var R = 6371;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLon = (lon2 - lon1) * Math.PI / 180;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** เลือกย่านที่ใกล้ที่สุด (ไม่เกิน 4.5 กม.) */
function nearestZone_(lat, lon) {
  var best = null;
  ZONE_CENTERS.forEach(function (z) {
    var d = distKm_(lat, lon, z.lat, z.lon);
    if (!best || d < best.d) best = { zone: z.zone, d: d };
  });
  return (best && best.d <= 4.5) ? best.zone : '';
}

/**
 * เดาย่านจากที่อยู่ Google (แม่นกว่าพิกัดล้วน) เช่น "Sukhumvit 36" = ทองหล่อ
 * กติกาซอยสุขุมวิท: 1-32 อโศก | 33-55 ทองหล่อ | 56-66 เอกมัย | 67+ พระโขนง
 */
function zoneFromAddress_(addr, lat, lon, fallback) {
  var s = String(addr || '').toLowerCase();
  var m = s.match(/sukhumvit[^0-9]{0,12}(\d{1,3})/);
  if (m) {
    var n = parseInt(m[1], 10);
    if (n >= 1 && n <= 32) return 'อโศก';
    if (n >= 33 && n <= 55) return 'ทองหล่อ';
    if (n >= 56 && n <= 66) return 'เอกมัย';
    if (n >= 67 && n <= 99) return 'พระโขนง';
  }
  if (/ekkamai|เอกมัย/.test(s)) return 'เอกมัย';
  if (/thong ?lo|ทองหล่อ/.test(s)) return 'ทองหล่อ';
  if (/phrom ?phong|พร้อมพงษ์/.test(s)) return 'พร้อมพงษ์';
  if (/soi ari|ari 1|อารีย์|phahon yothin 5|phahonyothin 5/.test(s)) return 'อารีย์';
  if (/chatuchak|kamphaeng phet|จตุจักร|bang sue|บางซื่อ|vibhavadi/.test(s)) return 'จตุจักร';
  if (/ratchadapisek|ratchadaphisek|din daeng|รัชดา/.test(s)) return 'รัชดา';
  if (/silom|สีลม/.test(s)) return 'สีลม';
  if (/sathon|สาทร/.test(s)) return 'สาทร';
  if (/yaowarat|talat noi|samphanthawong|เยาวราช/.test(s)) return 'เยาวราช';
  if (/bang rak|บางรัก/.test(s)) return 'บางรัก';
  if (/charoen krung|เจริญกรุง/.test(s)) return 'เจริญกรุง';
  if (/phra nakhon|พระนคร|bang khun phrom|thewet|เทเวศร์|maha ratchawang/.test(s)) return 'พระนคร';
  if (/bang na|lasalle|la salle|บางนา|phra pradaeng/.test(s)) return 'บางนา';
  if (/phra khanong|พระโขนง/.test(s)) return 'พระโขนง';
  if (/pathum wan|siam|rama i|rong mueang|chula|สยาม/.test(s)) return 'สยาม';
  if (/phaya thai|ratchathewi|พญาไท/.test(s)) return 'พญาไท';
  return nearestZone_(lat, lon) || fallback || '';
}

/* ---------------- แหล่งข้อมูลร้าน: OSM Nominatim (ไม่ต้องใช้คีย์) ---------------- */

var OSM_NOMINATIM = 'https://nominatim.openstreetmap.org/search';
var OSM_UA = 'paicafekan-bot/1.0 (+https://paicafekan.com)';
var ZONE_BOX_DEG = 0.020;   // ครึ่งด้านของกรอบค้นหา ≈ 2.2 กม.
var ZONE_BOX_LAT = 0.012;

/* ---------------- ตรวจสถานะร้านกับ Google Maps (อ่านหน้าค้นหา ไม่ใช้ API key) ---------------- */

var GMAPS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9,th;q=0.6'
};

function gmapsGet_(url) {
  var res = UrlFetchApp.fetch(url, {
    headers: GMAPS_HEADERS,
    muteHttpExceptions: true,
    followRedirects: true,
    deadline: 20000
  });
  if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
  return res.getContentText();
}

/**
 * ค้นใน Google Maps แล้วคืนรายการร้าน
 * [{ name, address, status, hasHours, types }]
 * status = "CLOSED" เมื่อร้านปิดถาวร/ปิดชั่วคราว (ค่าว่างหรือข้อความอื่น = ยังเปิด)
 */
function googleSearchPlaces_(query) {
  try {
    // เรียกเพย์โหลด JSON ของ Maps ตรง ๆ (URL สั้น กันข้อจำกัดความยาว URL ของ UrlFetchApp)
    var payload = gmapsGet_('https://www.google.com/search?tbm=map&hl=en&gl=th&q=' + encodeURIComponent(query));
    if (payload.charAt(0) !== ')') return [];
    var j = JSON.parse(payload.replace(/^\)\]\}'\s*/, ''));
    var list = (j[0] && j[0][1]) || [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i] && list[i][14];
      if (!p || !p[11]) continue;
      out.push({
        name: String(p[11]),
        address: String(p[39] || ''),
        status: String((p[88] && p[88][0]) || ''),
        hasHours: !!p[203],
        lat: (p[9] && p[9][2]) || 0,
        lon: (p[9] && p[9][3]) || 0,
        types: p[13] || []
      });
    }
    return out;
  } catch (e) {
    return [];
  }
}

/** จับคู่ชื่อร้านจากผลค้นหา (เทียบแบบตัดช่องว่าง/วรรคตอน) */
/** ตัดชื่อร้านเป็นคำ (ภาษาไทย/อังกฤษ/ตัวเลข) เพื่อเทียบความคล้าย */
function nameTokens_(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^0-9a-z\u0e00-\u0e7f]+/g, ' ')
    .split(' ')
    .filter(function (t) { return t.length >= 2; });
}

/** คะแนนความคล้ายชื่อ 0..1 */
function nameSim_(a, b) {
  var na = normShopName_(a);
  var nb = normShopName_(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.indexOf(nb) !== -1 || nb.indexOf(na) !== -1) return 0.9;
  var ta = nameTokens_(a);
  var tb = nameTokens_(b);
  if (!ta.length || !tb.length) return 0;
  var hit = 0;
  ta.forEach(function (t) { if (tb.indexOf(t) !== -1) hit++; });
  var union = ta.length + tb.length - hit;
  return union ? hit / union : 0;
}

/**
 * จับคู่ชื่อร้านจากผลค้นหา
 * - ร้านที่ Google บอกว่าปิด: ยอมรับคะแนนคล้ายแค่ 0.34 (พลาดก็แค่ไม่หยิบร้านนั้น = ปลอดภัย)
 * - ร้านที่ยังเปิด: ต้องคล้าย ≥ 0.5 กันหยิบร้านอื่นมาแทน
 */
function matchGooglePlace_(places, name) {
  var best = null;
  var bestScore = 0;
  for (var i = 0; i < places.length; i++) {
    var s = nameSim_(places[i].name, name);
    if (s > bestScore) { bestScore = s; best = places[i]; }
  }
  if (!best) return null;
  var closed = /^(CLOSED|PERMANENTLY[ _]?CLOSED|TEMPORARILY[ _]?CLOSED)$/i.test(best.status);
  if (closed) return bestScore >= 0.34 ? best : null;
  return bestScore >= 0.5 ? best : null;
}

/**
 * ตรวจว่าร้านยังเปิดอยู่ไหมจาก Google Maps
 * คืน { verdict: 'OPEN' | 'CLOSED' | 'UNKNOWN', found: place|null }
 */
/** คำบอกประเภท "คาเฟ่" และคำบอกว่า "ไม่ใช่คาเฟ่" ในข้อมูลประเภทของ Google */
var CAFE_TYPE_WORDS = ['cafe', 'coffee', 'คาเฟ่', 'กาแฟ', 'bakery', 'เบเกอรี', 'เบเกอรี่', 'bread', 'ขนม',
  'dessert', 'ของหวาน', 'tea house', 'ร้านน้ำชา', 'ชา ', 'ice cream', 'ไอศกรีม', 'bistro', 'brunch',
  'juice', 'smoothie', 'นมสด', 'เครื่องดื่ม'];
var BAD_TYPE_WORDS = ['นวด', 'massage', 'สปา', 'spa', 'บาร์', 'bar,', ' bar', 'bar ', 'pub', 'ผับ',
  'ไนต์คลับ', 'night club', 'ค็อกเทล', 'cocktail', 'ดิสโก้', 'disco', 'คาราโอเกะ', 'karaoke',
  'คลินิก', 'clinic', 'ร้านยา', 'pharmacy', 'โฮสเทล', 'hostel', 'hotel', 'โรงแรม', 'supermarket',
  'ซูเปอร์มาร์เก็ต', 'grocery', 'ขายส่ง', 'wholesale', 'dispensary', 'กัญชา', 'cannabis',
  'car wash', 'ล้างรถ', 'ปั๊มน้ำมัน', 'laundry', 'ซักผ้า', '|bar|', '|pub|', '|ผับ|', '|บาร์|'];

/** ตรวจว่าประเภทของร้านใน Google เป็นคาเฟ่จริงไหม */
function placeTypesOk_(place) {
  var types = (place && place.types) || [];
  var joined = '|' + types.join('|').toLowerCase() + '|';
  if (types.length === 0) return true;
  for (var i = 0; i < BAD_TYPE_WORDS.length; i++) {
    if (joined.indexOf(BAD_TYPE_WORDS[i]) !== -1) return false;
  }
  for (var j = 0; j < CAFE_TYPE_WORDS.length; j++) {
    if (joined.indexOf(CAFE_TYPE_WORDS[j]) !== -1) return true;
  }
  return false;
}

/** ที่อยู่จาก Google ต้องอยู่ในกรุงเทพฯ/ปริมณฑล กันจับคู่ผิดร้านที่ชื่อคล้ายกันแต่คนละจังหวัด */
function addressInMetro_(addr) {
  var s = String(addr || '').toLowerCase();
  if (!s) return true;
  return /bangkok|krung thep|กรุงเทพ|samut prakan|สมุทรปราการ|nonthaburi|นนทบุรี|pathum thani|ปทุมธานี|samut sakhon|สมุทรสาคร/.test(s);
}

function googleShopStatus_(name, zone, lat, lon) {
  var queries = [];
  if (zone) queries.push(name + ' ' + zone + ' กรุงเทพ');
  queries.push(name + ' Bangkok');
  queries.push(name);
  for (var i = 0; i < queries.length; i++) {
    var places = googleSearchPlaces_(queries[i]);
    if (!places.length) continue;
    var p = matchGooglePlace_(places, name);
    if (!p) continue;
    if (/^(CLOSED|PERMANENTLY[ _]?CLOSED|TEMPORARILY[ _]?CLOSED)$/i.test(p.status)) {
      return { verdict: 'CLOSED', found: p };
    }
    if (!addressInMetro_(p.address)) continue;
    if (lat && lon && p.lat && p.lon && distKm_(lat, lon, p.lat, p.lon) > 6) continue;
    return { verdict: 'OPEN', found: p };
  }
  return { verdict: 'UNKNOWN', found: null };
}

/** คำที่บอกว่าไม่ใช่คาเฟ่ที่เราต้องการ (ร้านอาหารจานด่วน/ร้านสะดวกซื้อ/อื่น ๆ) */
var NON_CAFE_WORDS = [
  'ก๋วยเตี๋ยว', 'kuay teow', 'kuaytiew', 'noodle', 'ข้าวมันไก่', 'ข้าวหมูแดง',
  'หมูกระทะ', 'ชาบู', 'สุกี้', 'ปิ้งย่าง', 'บุฟเฟ่ต์', 'food court',
  '7-eleven', 'เซเว่น', 'seven eleven', 'family mart', 'มินิมาร์ท', 'minimart',
  'ซูเปอร์มาร์เก็ต', 'supermarket', 'สะดวกซื้อ',
  'นวด', 'massage', 'สปา', 'spa ', 'คลินิก', 'clinic', 'ร้านยา', 'pharmacy',
  'เสริมสวย', 'salon', 'ตัดผม', 'barber', ' tattoo',
  'cannabis', 'กัญชา', 'dispensary', 'weed',
  'hostel', 'โฮสเทล', ' guesthouse', 'เกสต์เฮาส์',
  'car wash', 'ล้างรถ', 'ปั๊มน้ำมัน', 'petrol', 'gas station',
  'laundry', 'ซักผ้า', 'อพาร์ทเมนท์', 'apartment', 'คอนโด', 'condo'
];

/** ดึงรายชื่อคาเฟ่ในกรุงเทพฯ จาก OSM Nominatim ทีละย่าน (แคช 6 ชม.) */
function fetchCafesByZone_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('bkk_cafes_v3');
  if (hit) {
    try { return JSON.parse(hit); } catch (e) {}
  }
  var byName = {};
  var order = [];
  var errors = [];
  for (var i = 0; i < ZONE_CENTERS.length; i++) {
    var z = ZONE_CENTERS[i];
    var vb = [
      (z.lon - ZONE_BOX_DEG).toFixed(4),
      (z.lat + ZONE_BOX_LAT).toFixed(4),
      (z.lon + ZONE_BOX_DEG).toFixed(4),
      (z.lat - ZONE_BOX_LAT).toFixed(4)
    ].join(',');
    var url = OSM_NOMINATIM + '?amenity=cafe&format=jsonv2&limit=50&bounded=1&viewbox=' + vb +
      '&extratags=1&accept-language=th,en';
    var rows = [];
    for (var attempt = 0; attempt < 2 && !rows.length; attempt++) {
      try {
        var res = UrlFetchApp.fetch(url, {
          headers: { 'User-Agent': OSM_UA, 'Accept-Language': 'th,en;q=0.8' },
          muteHttpExceptions: true,
          deadline: 20000
        });
        if (res.getResponseCode() === 200) {
          rows = JSON.parse(res.getContentText()) || [];
        } else {
          errors.push(z.zone + ' HTTP ' + res.getResponseCode());
        }
      } catch (e) {
        errors.push(z.zone + ' ' + String(e && e.message ? e.message : e));
      }
      Utilities.sleep(1100); // มารยาทกับ Nominatim: ไม่เกิน 1 ครั้ง/วินาที
    }
    for (var r = 0; r < rows.length; r++) {
      var it = rows[r];
      var nm = String(it.name || String(it.display_name || '').split(',')[0] || '').trim();
      if (!nm) continue;
      var lat = parseFloat(it.lat);
      var lon = parseFloat(it.lon);
      if (!lat || !lon) continue;
      var key = normShopName_(nm);
      if (!key) continue;
      var d = distKm_(lat, lon, z.lat, z.lon);
      var prev = byName[key];
      if (prev) {
        if (d < prev.zoneDist) { prev.zone = z.zone; prev.zoneDist = d; }
        continue;
      }
      byName[key] = {
        name: nm,
        zone: z.zone,
        zoneDist: d,
        lat: lat,
        lon: lon,
        opening_hours: (it.extratags && it.extratags.opening_hours) || '',
        website: (it.extratags && (it.extratags.website || it.extratags['contact:website'])) || '',
        street: (it.address && (it.address.road || it.address.suburb)) || ''
      };
      order.push(key);
    }
  }
  if (!order.length) {
    throw new Error('หาแหล่งข้อมูลร้านไม่ได้: ' + errors.slice(0, 4).join(' | '));
  }
  var out = order.map(function (k) { return byName[k]; });
  try { cache.put('bkk_cafes_v3', JSON.stringify(out), 21600); } catch (e) {}
  log_('INFO', '-', '-', 'Nominatim: ' + out.length + ' คาเฟ่ จาก ' + ZONE_CENTERS.length + ' ย่าน');
  return out;
}

/**
 * ADMIN + trigger: เติมรายชื่อร้าน 21 ร้าน พร้อมย่าน ลงชีททุกวันอาทิตย์ 08:00
 * ทุกครั้งที่หาได้ จะเช็คกับ Google Maps ก่อนว่ายังเปิดอยู่ (ไม่เอาร้านที่ปิดถาวร)
 * สถานะเว้นว่างไว้ — ผู้ใช้ใส่รูปในคอลัมน์ M แล้วตั้ง ready เอง
 */
function seedWeeklyShops(limit) {
  limit = limit || 21;
  var cfg = getConfig_();
  var sheet = getSheet_(cfg.sheetName);
  var props = PropertiesService.getScriptProperties();
  var started = Date.now();
  var MAX_GOOGLE_CHECKS = 80;
  var BUDGET_MS = 210000;

  try {
    // ชื่อที่มีอยู่แล้ว (ทุกสถานะ) + ประวัติที่เคยแนะนำ
    var existing = {};
    var existingNames = [];
    var lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      var names = sheet.getRange(2, COL.NAME, lastRow - 1, 1).getValues();
      names.forEach(function (r) {
        var k = normShopName_(r[0]);
        if (!k) return;
        existing[k] = true;
        existingNames.push(String(r[0]));
      });
    }
    var seeded = [];
    try { seeded = JSON.parse(props.getProperty('SEEDED_SHOPS') || '[]'); } catch (e) { seeded = []; }
    seeded.forEach(function (n) { existing[normShopName_(n)] = true; });

    var els = fetchCafesByZone_();
    var cands = [];
    els.forEach(function (el) {
      var name = String(el.name || '').trim();
      if (!name || name.length < 2 || name.length > 70) return;
      if (/permanently closed|closed permanently|ปิดกิจการ|ปิดถาวร/i.test(name)) return;
      if (/https?:|www\.|@/.test(name)) return;
      var low = name.toLowerCase();
      var chain = CHAIN_WORDS.some(function (w) { return low.indexOf(String(w).toLowerCase()) !== -1; });
      if (chain) return;
      var junk = NON_CAFE_WORDS.some(function (w) { return low.indexOf(String(w).toLowerCase()) !== -1; });
      if (junk) return;
      var k = normShopName_(name);
      if (!k || existing[k]) return;
      for (var ei = 0; ei < existingNames.length; ei++) {
        if (nameSim_(name, existingNames[ei]) >= 0.6) return;
      }
      var zone = nearestZone_(el.lat, el.lon) || el.zone;
      if (!zone) return;
      // คะแนนความน่าเชื่อถือของข้อมูล (มีเวลาเปิด/ที่อยู่/เว็บ = มีตัวตนจริง)
      var score = 0;
      if (el.opening_hours) score += 3;
      if (el.street) score += 2;
      if (el.website) score += 2;
      if (el.zoneDist != null) score += Math.max(0, 2 - el.zoneDist);
      cands.push({ name: name, zone: zone, score: score, lat: el.lat, lon: el.lon });
    });

    // กันชื่อซ้ำภายในชุดเดียวกัน
    var seen = {};
    cands = cands.filter(function (c) {
      var k = normShopName_(c.name);
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });

    if (!cands.length) {
      log_('WARN', '-', '-', 'weekly seed: ไม่พบร้านใหม่ (Nominatim ' + els.length + ' ร้าน)');
      return { ok: false, added: 0, reason: 'ไม่พบร้านใหม่หลังคัดกรอง', ms: Date.now() - started };
    }

    // เรียงต่อย่าน: คะแนนสูงก่อน แล้ววนย่านละร้าน จะได้กระจายครบทุกย่าน
    var byZone = {};
    cands.forEach(function (c) {
      (byZone[c.zone] = byZone[c.zone] || []).push(c);
    });
    var zoneKeys = Object.keys(byZone).sort();
    zoneKeys.forEach(function (z) {
      byZone[z].sort(function (a, b) { return b.score - a.score || a.name.localeCompare(b.name); });
    });

    // วนเก็บร้านทีละย่าน + ตรวจกับ Google ว่ายังเปิดอยู่
    var picks = [];
    var rejected = [];
    var checks = 0;
    var cursors = {};
    zoneKeys.forEach(function (z) { cursors[z] = 0; });
    var stop = false;
    while (picks.length < limit && !stop) {
      var progressed = false;
      for (var i = 0; i < zoneKeys.length && picks.length < limit; i++) {
        var z = zoneKeys[i];
        var list = byZone[z];
        if (cursors[z] >= list.length) continue;
        var cand = list[cursors[z]++];
        progressed = true;
        if (checks >= MAX_GOOGLE_CHECKS || Date.now() - started > BUDGET_MS) { stop = true; break; }
        checks++;
        var st = googleShopStatus_(cand.name, cand.zone, cand.lat, cand.lon);
        if (st.verdict === 'CLOSED') {
          rejected.push(cand.name + ' (ปิดแล้ว)');
          continue;
        }
        if (st.verdict === 'UNKNOWN') {
          rejected.push(cand.name + ' (ไม่พบใน Google)');
          continue;
        }
        if (!placeTypesOk_(st.found)) {
          rejected.push(cand.name + ' (ไม่ใช่คาเฟ่: ' + ((st.found.types || []).join('/').slice(0, 40)) + ')');
          continue;
        }
        cand.gname = (st.found && st.found.name) || cand.name;
        cand.address = (st.found && st.found.address) || '';
        // ย่านจริงจากที่อยู่ Google (ซอยสุขุมวิท/ชื่อถนน) มาก่อนพิกัดล้วน
        var zfx = zoneFromAddress_(cand.address, cand.lat, cand.lon, cand.zone);
        if (zfx && zfx !== cand.zone) cand.zone = zfx;
        picks.push(cand);
      }
      if (!progressed) break;
    }

    if (!picks.length) {
      log_('WARN', '-', '-', 'weekly seed: ตรวจแล้วไม่เหลือร้านที่ยังเปิด (' + rejected.length + ' ร้านถูกตัด)');
      return { ok: false, added: 0, reason: 'ไม่เหลือร้านที่ยังเปิด', rejected: rejected.slice(0, 20), ms: Date.now() - started };
    }

    var rows = picks.map(function (p) {
      return [p.name, p.zone, '', '', '', '',
        '🌱 ร้านประจำสัปดาห์ (Google ยืนยันว่ายังเปิด) — ใส่รูปในคอลัมน์ M แล้วตั้งสถานะ ready'];
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 7).setValues(rows);

    // จำชื่อที่เคยแนะนำไว้ กันซ้ำข้ามสัปดาห์
    var keep = seeded.concat(picks.map(function (p) { return p.name; })).slice(-800);
    props.setProperty('SEEDED_SHOPS', JSON.stringify(keep));

    var summary = picks.map(function (p) { return p.name + ' (' + p.zone + ')'; }).join('\n');
    log_('INFO', '-', '-', 'weekly seed: +' + picks.length + ' ร้าน, ตัดออก ' + rejected.length +
      ', เช็ค Google ' + checks + ' ครั้ง (' + Math.round((Date.now() - started) / 1000) + 's)');
    try {
      Line.push_([Line.text('🌱 รายชื่อร้านประจำสัปดาห์ +' + picks.length + ' ร้าน ลงชีทแล้ว\n' +
        'ผ่านการเช็ค Google ว่ายังเปิดอยู่ทุกร้าน\nใส่รูปในคอลัมน์ M แล้วตั้งสถานะ ready ได้เลย\n\n' + summary.slice(0, 850))]);
    } catch (e) {}

    return {
      ok: true, added: picks.length, checked: checks, rejected: rejected.slice(0, 20),
      ms: Date.now() - started, shops: picks
    };
  } catch (err) {
    var msg = String(err && err.message ? err.message : err);
    log_('ERROR', '-', '-', 'weekly seed ล้มเหลว: ' + msg.slice(0, 400));
    try {
      Line.push_([Line.text('⚠️ หาร้านประจำสัปดาห์ไม่สำเร็จ\n' + msg.slice(0, 500))]);
    } catch (e) {}
    return { ok: false, added: 0, error: msg.slice(0, 400), ms: Date.now() - started };
  }
}

/** ADMIN: ตรวจร้านทุกแถวในชีทว่าปิดถาวรหรือยัง (ไม่ลบอะไร) */
function auditClosedShops() {
  var cfg = getConfig_();
  var sheet = getSheet_(cfg.sheetName);
  var last = sheet.getLastRow();
  var out = { checked: 0, closed: [], unknown: [], ms: 0 };
  if (last < 2) return out;
  var t0 = Date.now();
  var vals = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    var name = String(vals[i][COL.NAME - 1] || '').trim();
    if (!name) continue;
    if (Date.now() - t0 > 240000) break;
    var zone = String(vals[i][COL.ZONE - 1] || '').trim();
    var st = googleShopStatus_(name, zone);
    out.checked++;
    var item = { row: i + 2, name: name, zone: zone, status: String(vals[i][COL.STATUS - 1] || '').trim() };
    if (st.verdict === 'CLOSED') out.closed.push(item);
    else if (st.verdict === 'UNKNOWN') out.unknown.push(item);
  }
  out.ms = Date.now() - t0;
  log_('WARN', '-', '-', 'audit: ตรวจ ' + out.checked + ' ร้าน — ปิดถาวร ' + out.closed.length +
    ', ไม่พบใน Google ' + out.unknown.length);
  return out;
}

/** ADMIN: ลบเฉพาะแถวที่ปิดถาวรและยังไม่มีบทความ/ไม่เคยโพสต์ (รัน audit ก่อน) */
function removeClosedUnpublishedShops() {
  var cfg = getConfig_();
  var sheet = getSheet_(cfg.sheetName);
  var audit = auditClosedShops();
  var removed = [];
  var kept = [];
  // ลบจากล่างขึ้นบนเพื่อไม่ให้เลขแถวเลื่อน
  var rows = audit.closed.slice().sort(function (a, b) { return b.row - a.row; });
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i].row;
    var status = String(sheet.getRange(r, COL.STATUS).getValue() || '').trim().toLowerCase();
    var doc = String(sheet.getRange(r, COL.DOC_URL).getValue() || '').trim();
    var post = String(sheet.getRange(r, COL.POST_URL).getValue() || '').trim();
    if (doc || post || status === 'published' || status === 'scheduled' || status === 'drafted') {
      kept.push({ row: r, name: rows[i].name, status: status, why: 'มีบทความ/เคยโพสต์' });
      continue;
    }
    sheet.deleteRow(r);
    removed.push({ row: r, name: rows[i].name });
  }
  log_('WARN', '-', '-', 'ลบร้านที่ปิดถาวร ' + removed.length + ' แถว, เก็บไว้ให้ตรวจ ' + kept.length + ' แถว');
  return { removed: removed, kept: kept, audit: { checked: audit.checked, closed: audit.closed.length } };
}

/** ADMIN: ตรวจสุขภาพชีต Log (ดูว่า log_ เขียนได้จริงไหม) */
function logStats() {
  var cfg = getConfig_();
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(cfg.logSheet);
  var out = { logSheet: cfg.logSheet };
  if (!sh) return { logSheet: cfg.logSheet, exists: false };
  out.exists = true;
  out.lastRow = sh.getLastRow();
  out.maxRows = sh.getMaxRows();
  out.maxCols = sh.getMaxColumns();
  out.cells = sh.getLastRow() * sh.getMaxColumns();
  out.protected = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length > 0;
  var last = sh.getLastRow();
  out.tail = last >= 2 ? sh.getRange(Math.max(2, last - 4), 1, Math.min(5, last - 1), 5).getValues() : [];
  try {
    sh.appendRow([new Date(), 'DEBUG', '-', '-', 'logStats: ทดสอบเขียน log']);
    out.appendOk = true;
  } catch (e) {
    out.appendOk = false;
    out.appendError = String(e && e.message ? e.message : e).slice(0, 200);
  }
  out.lastRowAfter = sh.getLastRow();
  return out;
}

/** ADMIN: ทดสอบแหล่งข้อมูลร้าน + ตัวอย่างการเช็ค Google */
function testOsm() {
  var out = [];
  var cache = CacheService.getScriptCache();
  var cached = cache.get('bkk_cafes_v3');
  if (cached) {
    try { out.push({ step: 'cache', n: JSON.parse(cached).length, chars: cached.length }); } catch (e) {}
  }
  try {
    var t0 = Date.now();
    var els = fetchCafesByZone_();
    out.push({
      step: 'fetch', ok: true, n: els.length, ms: Date.now() - t0,
      sample: els.slice(0, 5).map(function (e) { return e.name + ' (' + e.zone + ')'; })
    });
    var g = googleShopStatus_(els[0].name, els[0].zone);
    out.push({ step: 'google', name: els[0].name, verdict: g.verdict, status: g.found && g.found.status });
  } catch (err) {
    out.push({ step: 'fetch', ok: false, error: String(err && err.message ? err.message : err).slice(0, 300), ms: 0 });
  }
  return out;
}
/** ADMIN: ลบแถวร้านในรายชื่อห้าม (mass/chain) — เฉพาะแถว ≥ 15 เช่น "คาเฟ่ อเมซอน" */
function purgeMassShops() {
  var cfg = getConfig_();
  var sheet = getSheet_(cfg.sheetName);
  var words = ['amazon', 'อเมซอน', 'คาเฟ่ อเมซอน',
    'chao doi',                    // Chao Doi
    'black canyon',                // Black Canyon Coffee
    'flash coffee',                // Flash Coffee
    'after you',                   // After You
    'true coffee',                 // True Coffee
    'arabica percentage',          // Arabica Percentage Empire
    'open house'                   // Open House (Central World)
  ];
  var lastRow = sheet.getLastRow();
  var deleted = [];
  var names = [];
  for (var r = lastRow; r >= 15; r--) {
    var name = String(sheet.getRange(r, COL.NAME).getValue() || '').trim();
    var low = name.toLowerCase();
    var hit = words.some(function (w) { return low.indexOf(String(w).toLowerCase()) !== -1; });
    if (hit) {
      sheet.deleteRow(r);
      try { deletePending_(cfg, r); } catch (e) {}
      deleted.push(r);
      names.push(name);
    }
  }
  log_('WARN', '-', '-', 'ลบแถวห้ามโดยระบบ: ' + (names.join(', ') || '(ไม่พบ)'));
  return { deleted: deleted.length, rows: deleted, names: names };
}

/** ADMIN: พัก trigger สร้างร่างเท่านั้น (คิวโพสต์ยังทำงาน โพสต์ที่อนุมัติแล้วจะโพสต์ตามเวลา) */
function pauseBatch() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  triggers.forEach(function (tr) {
    if (tr.getHandlerFunction() === 'runDailyBatch') {
      ScriptApp.deleteTrigger(tr);
      removed++;
    }
  });
  log_('WARN', '-', '-', 'พัก trigger สร้างร่าง: ' + removed + ' รายการ (เปิดใหม่ด้วย setupTriggers)');
  return 'paused: ' + removed;
}

/** แสดง trigger ที่มีอยู่ */
function listTriggers_() {
  return ScriptApp.getProjectTriggers().map(function (tr) {
    return tr.getHandlerFunction() + ' :: ' + tr.getEventType();
  });
}

/** ตรวจสอบความพร้อมของระบบทั้งหมด */
function checkSetup() {
  var cfg = getConfig_();
  var problems = [];

  if (!cfg.apiKey) problems.push('ยังไม่มี GEMINI_API_KEY');
  if (!cfg.folderId) problems.push('ยังไม่มี DOC_FOLDER_ID (ไฟล์ร่างจะไปอยู่ My Drive)');

  if (!cfg.lineToken) problems.push('ยังไม่มี LINE_CHANNEL_ACCESS_TOKEN');
  if (!cfg.lineSecret) problems.push('ยังไม่มี LINE_CHANNEL_SECRET');
  if (!cfg.lineAdmin) problems.push('ยังไม่มี LINE_ADMIN_USER_ID (พิมพ์หาบอท 1 ครั้ง)');
  if (!cfg.lineWebhookToken) problems.push('ยังไม่มี LINE_WEBHOOK_TOKEN');
  if (!cfg.ghToken) problems.push('ยังไม่มี GITHUB_TOKEN (โพสต์ขึ้นเว็บไม่ได้)');
  if (!cfg.ghOwner) problems.push('ยังไม่มี GITHUB_OWNER');

  var sheet = getSheet_(cfg.sheetName);
  var header = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  for (var i = 0; i < HEADERS.length; i++) {
    if (String(header[i]).trim() !== HEADERS[i]) {
      problems.push('หัวตารางคอลัมน์ ' + (i + 1) + ' ควรเป็น "' + HEADERS[i] + '" (พบ: "' + header[i] + '")');
    }
  }

  var allTriggers = ScriptApp.getProjectTriggers();
  var triggers = allTriggers.filter(function (t) {
    return t.getHandlerFunction() === 'runDailyBatch';
  });
  var queueTriggers = allTriggers.filter(function (t) {
    return t.getHandlerFunction() === 'runPublishQueue';
  });
  if (triggers.length === 0) problems.push('ยังไม่มีตัวตั้งเวลา (กด "ติดตั้งตัวตั้งเวลา")');

  var counts = { ready: 0, pending: 0, scheduled: 0 };
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var statuses = sheet.getRange(2, COL.STATUS, lastRow - 1, 1).getValues();
    statuses.forEach(function (r) {
      var s = String(r[0]).trim().toLowerCase();
      if (s === STATUS.READY) counts.ready++;
      if (s === STATUS.PENDING) counts.pending++;
      if (s === STATUS.SCHEDULED) counts.scheduled++;
    });
  }

  var queue = readQueue_(cfg);

  var summary = [
    'Gemini: ' + (cfg.apiKey ? 'มี ✔' : 'ไม่มี ✖') + ' (' + cfg.model + ')',
    'ค้นร้าน: OpenStreetMap (ไม่ต้องใช้คีย์) ✔',
    'LINE token: ' + (cfg.lineToken ? 'มี ✔' : 'ไม่มี ✖'),
    'LINE ผู้ดูแล: ' + (cfg.lineAdmin ? cfg.lineAdmin.slice(0, 12) + '…' : 'ยังไม่รู้'),
    'GitHub: ' + (cfg.ghToken && cfg.ghOwner ? (cfg.ghOwner + '/' + cfg.ghRepo + ' ✔') : 'ยังไม่ครบ ✖'),
    'เว็บ: ' + cfg.siteBase,
    'รอบละ: ' + cfg.batchSize + ' ร้าน',
    'ตัวตั้งเวลา: ' + triggers.length + ' รายการ (สร้างร่าง) + ' + queueTriggers.length + ' รายการ (ตรวจคิวโพสต์)',
    'สล็อตโพสต์: ' + postSlots_(cfg).join(' / ') + ' (คิว ' + queue.length + ' รายการ)',
    'รออยู่ (ready): ' + counts.ready + ' แถว | รออนุมัติ (pending): ' + counts.pending +
      ' | ตั้งคิวแล้ว: ' + counts.scheduled,
    '',
    problems.length ? 'ต้องแก้:\n- ' + problems.join('\n- ') : 'ทุกอย่างพร้อมใช้งาน ✔'
  ].join('\n');

  log_('INFO', '-', '-', 'checkSetup: ' + summary.replace(/\n/g, ' | '));
  Logger.log(summary);
  try {
    SpreadsheetApp.getUi().alert('สถานะระบบ\n\n' + summary);
  } catch (e) {
    // เรียกจาก editor โดยไม่มี UI ก็ไม่เป็นไร
  }
  return summary;
}

/** เรียกครั้งแรกจาก editor: ใส่ค่าเริ่มต้นที่ปลอดภัย */
function firstRunSetup() {
  setupHeaders();
  setupTriggers();
  checkSetup();
}

