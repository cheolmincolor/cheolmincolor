/**
 * GRAYZONE 장부 — 「GRAYZONE 매출 장부」 시트에 붙여 쓰는 웹앱.
 *
 * 입력은 「장부」 시트의 A~P열에만 합니다. Q~S열(연도·월·미수금)과 요약·미수금·거래처별
 * 시트는 시트의 수식이 계산하므로 이 스크립트는 건드리지 않습니다.
 *
 * @OnlyCurrentDoc
 */

var SHEET_NAME = '장부';
var INPUT_COLS = 16; // A~P: 사람이 입력하는 열
var FIELDS = ['date', 'client', 'director', 'pd', 'title', 'amount', 'type', 'quote',
  'invoice', 'paid', 'paidAmount', 'paidDate', 'incentive', 'note', 'extra', 'attrYear'];
var DATE_FIELDS = { date: 1, paidDate: 1 };
var NUMBER_FIELDS = { amount: 1, paidAmount: 1, incentive: 1, attrYear: 1 };
var CHOICES = {
  type: ['', '서비스'],
  quote: ['', '완료', 'X'],
  invoice: ['', '완료', 'X', '*'],
  paid: ['', '완료', 'X']
};

// ---------- 웹앱 진입점 ----------

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('GRAYZONE 장부')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/** 장부 전체를 읽어 JSON 문자열로 돌려줍니다. */
function getData() {
  var ctx = open_();
  return JSON.stringify(snapshot_(ctx));
}

/** 새 작업을 납품일이 속한 연도·월 묶음의 빈 행에 넣습니다. */
function addJob(job) {
  return withLock_(function (ctx) {
    var clean = cleanJob_(job, true);
    var parsed = parseSheet_(readValues_(ctx.sheet), ctx.tz);
    writeNewRow_(ctx, parsed, clean);
  });
}

/**
 * 한 행을 고칩니다. patch 에 들어 있는 항목만 바뀝니다.
 * expect 는 앱이 보고 있던 행의 내용으로, 시트의 행이 그 사이에 밀렸는지 확인하는 데 씁니다.
 */
function updateJob(row, expect, patch) {
  return withLock_(function (ctx) {
    var parsed = parseSheet_(readValues_(ctx.sheet), ctx.tz);
    var current = findJob_(parsed, row, expect);
    var clean = cleanJob_(patch, false);
    var merged = {};
    FIELDS.forEach(function (f) { merged[f] = f in clean ? clean[f] : current[f]; });
    if (!merged.date || !merged.client || !merged.title) {
      throw new Error('납품일·거래처·내용은 비울 수 없습니다.');
    }

    var moved = 'date' in clean && isIsoDate_(current.date) &&
      clean.date.slice(0, 7) !== current.date.slice(0, 7);
    if (moved) {
      // 다른 달로 옮길 때: 옮길 자리가 있는지 먼저 확인하고, 원래 행을 비운 뒤 새 자리에 씁니다.
      findBlock_(parsed, merged.date);
      ctx.sheet.getRange(row, 1, 1, INPUT_COLS).clearContent();
      parsed = parseSheet_(readValues_(ctx.sheet), ctx.tz);
      writeNewRow_(ctx, parsed, merged);
      return;
    }
    FIELDS.forEach(function (f, i) {
      if (f in clean) ctx.sheet.getRange(row, i + 1).setValue(toCell_(f, clean[f], ctx.tz));
    });
  });
}

/** 한 행의 입력 내용을 지웁니다(행 자체는 빈 행으로 남아 다음 등록 때 다시 쓰입니다). */
function deleteJob(row, expect) {
  return withLock_(function (ctx) {
    var parsed = parseSheet_(readValues_(ctx.sheet), ctx.tz);
    findJob_(parsed, row, expect);
    ctx.sheet.getRange(row, 1, 1, INPUT_COLS).clearContent();
  });
}

// ---------- 시트 읽기 ----------

function open_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('이 스크립트는 매출 장부 시트의 확장 프로그램 > Apps Script 안에서 만들어야 합니다.');
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('「' + SHEET_NAME + '」 시트를 찾을 수 없습니다.');
  return { ss: ss, sheet: sheet, tz: ss.getSpreadsheetTimeZone() };
}

function withLock_(fn) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  try {
    var ctx = open_();
    fn(ctx);
    SpreadsheetApp.flush();
    return JSON.stringify(snapshot_(ctx));
  } finally {
    lock.releaseLock();
  }
}

function readValues_(sheet) {
  var rows = sheet.getDataRange().getNumRows();
  return sheet.getRange(1, 1, rows, INPUT_COLS).getValues();
}

function snapshot_(ctx) {
  var parsed = parseSheet_(readValues_(ctx.sheet), ctx.tz);
  return {
    jobs: parsed.jobs,
    today: Utilities.formatDate(new Date(), ctx.tz, 'yyyy-MM-dd'),
    sheetUrl: ctx.ss.getUrl() + '#gid=' + ctx.sheet.getSheetId()
  };
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

function isIsoDate_(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function blank_(v) {
  return v === '' || v === null || v === undefined;
}

/** 행의 종류: 'year'(2026년), 'month'(1월·기타), 'job', 'empty', 'other' */
function rowKind_(r) {
  var a = r[0];
  var hasJobData = !blank_(r[1]) || !blank_(r[4]) || !blank_(r[5]);
  if (isDate_(a) || hasJobData) return 'job';
  if (typeof a === 'string' && a.trim() !== '') {
    var t = a.trim();
    if (/^\d{4}년$/.test(t)) return 'year';
    if (/^\d{1,2}월$/.test(t) || /^기타/.test(t)) return 'month';
    return 'other';
  }
  for (var i = 0; i < INPUT_COLS; i++) if (!blank_(r[i])) return 'other';
  return 'empty';
}

/**
 * 시트 값(A~P)을 작업 목록과 연도·월 묶음으로 풉니다.
 * 연도·월·미수금은 시트 Q~S열 수식과 같은 규칙으로 계산합니다.
 */
function parseSheet_(values, tz) {
  var jobs = [];
  var blocks = [];
  var kinds = [];
  var year = null;
  var block = null;
  for (var i = 1; i < values.length; i++) { // 1행은 머리줄
    var r = values[i];
    var row = i + 1;
    var kind = rowKind_(r);
    kinds[row] = kind;
    if (kind === 'year') {
      year = Number(r[0].trim().slice(0, 4));
      block = null;
    } else if (kind === 'month') {
      var t = r[0].trim();
      block = { year: year, month: /^기타/.test(t) ? 0 : Number(t.replace('월', '')), header: row, first: row + 1, last: row };
      blocks.push(block);
    } else {
      if (block) block.last = row;
      if (kind === 'job') jobs.push(parseJob_(r, row, tz));
    }
  }
  return { jobs: jobs, blocks: blocks, kinds: kinds };
}

function parseJob_(r, row, tz) {
  var j = { row: row };
  FIELDS.forEach(function (f, i) {
    var v = r[i];
    if (DATE_FIELDS[f]) j[f] = isDate_(v) ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : String(blank_(v) ? '' : v);
    else if (NUMBER_FIELDS[f]) j[f] = typeof v === 'number' ? v : (blank_(v) ? '' : String(v));
    else j[f] = blank_(v) ? '' : String(v);
  });
  var dated = isIsoDate_(j.date);
  var dateYear = dated ? Number(j.date.slice(0, 4)) : null;
  j.year = j.attrYear !== '' ? Number(j.attrYear) : dateYear;
  j.month = dated && dateYear === j.year ? Number(j.date.slice(5, 7)) : 0; // 0 = 기타
  var amount = typeof j.amount === 'number' ? j.amount : 0;
  var got = typeof j.paidAmount === 'number' ? j.paidAmount : 0;
  j.unpaid = j.paid === '완료' ? 0 : Math.max(0, amount - got);
  return j;
}

function fingerprint_(j) {
  return [j.date, j.client, j.title, j.amount === '' || j.amount == null ? '' : Number(j.amount)].join('|');
}

function findJob_(parsed, row, expect) {
  var found = null;
  parsed.jobs.forEach(function (j) { if (j.row === row) found = j; });
  if (!found || !expect || fingerprint_(found) !== fingerprint_(expect)) {
    throw new Error('장부가 그 사이에 바뀌었습니다. 새로 고친 뒤 다시 해 주세요.');
  }
  return found;
}

// ---------- 시트 쓰기 ----------

function findBlock_(parsed, isoDate) {
  var y = Number(isoDate.slice(0, 4));
  var m = Number(isoDate.slice(5, 7));
  for (var i = 0; i < parsed.blocks.length; i++) {
    var b = parsed.blocks[i];
    if (b.year === y && b.month === m) return b;
  }
  throw new Error('장부에 ' + y + '년 ' + m + '월 묶음이 없습니다. 시트에 그 달 묶음을 먼저 만들어 주세요.');
}

/** 새 행이 들어갈 자리. 묶음 안에 빈 행이 있으면 그 행, 없으면 묶음 끝에 행을 삽입합니다. */
function findSlot_(parsed, isoDate) {
  var b = findBlock_(parsed, isoDate);
  for (var row = b.first; row <= b.last; row++) {
    if (parsed.kinds[row] === 'empty') return { row: row, insertAfter: null };
  }
  var template = b.last >= b.first ? b.last : null;
  if (template === null && parsed.jobs.length) template = parsed.jobs[parsed.jobs.length - 1].row;
  return { row: b.last + 1, insertAfter: b.last, template: template };
}

function writeNewRow_(ctx, parsed, job) {
  var sheet = ctx.sheet;
  var slot = findSlot_(parsed, job.date);
  if (slot.insertAfter !== null) {
    sheet.insertRowAfter(slot.insertAfter);
    var tpl = slot.template;
    if (tpl !== null) {
      if (tpl > slot.insertAfter) tpl += 1;
      // 서식·드롭다운·묶음 깊이를 같은 종류의 행에서 가져옵니다.
      var cols = sheet.getLastColumn();
      var from = sheet.getRange(tpl, 1, 1, cols);
      var to = sheet.getRange(slot.row, 1, 1, cols);
      from.copyTo(to, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
      from.copyTo(to, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
      try {
        var diff = sheet.getRowGroupDepth(tpl) - sheet.getRowGroupDepth(slot.row);
        if (diff !== 0) sheet.getRange(slot.row, 1).shiftRowGroupDepth(diff);
      } catch (e) { /* 묶음 깊이는 보기용이라 실패해도 저장은 계속합니다. */ }
    }
  }
  var cells = FIELDS.map(function (f) { return toCell_(f, job[f], ctx.tz); });
  sheet.getRange(slot.row, 1, 1, INPUT_COLS).setValues([cells]);
}

/** 앱에서 온 값을 검사하고 정리합니다. full=true 면 모든 항목을 채워 돌려줍니다. */
function cleanJob_(input, full) {
  if (!input || typeof input !== 'object') throw new Error('입력 내용이 없습니다.');
  var out = {};
  FIELDS.forEach(function (f) {
    if (!(f in input)) {
      if (full) out[f] = '';
      return;
    }
    var v = input[f];
    if (blank_(v)) { out[f] = ''; return; }
    if (DATE_FIELDS[f]) {
      if (!isIsoDate_(v) || isNaN(new Date(v + 'T00:00:00Z').getTime())) throw new Error('날짜 형식이 올바르지 않습니다: ' + v);
      out[f] = v;
    } else if (NUMBER_FIELDS[f]) {
      var n = Number(v);
      if (!isFinite(n) || n < 0) throw new Error('금액은 0 이상의 숫자여야 합니다: ' + v);
      out[f] = n;
    } else {
      var s = String(v).trim();
      if (s.charAt(0) === '=') throw new Error('= 로 시작하는 내용은 입력할 수 없습니다.');
      if (CHOICES[f] && CHOICES[f].indexOf(s) < 0) throw new Error('선택할 수 없는 값입니다: ' + s);
      out[f] = s;
    }
  });
  if (full && (!out.date || !out.client || !out.title)) {
    throw new Error('납품일·거래처·내용은 꼭 입력해야 합니다.');
  }
  return out;
}

function toCell_(field, v, tz) {
  if (blank_(v)) return '';
  if (DATE_FIELDS[field]) return isIsoDate_(v) ? Utilities.parseDate(v, tz, 'yyyy-MM-dd') : v;
  return v;
}

// Node 테스트용. Apps Script 에서는 module 이 없으므로 실행되지 않습니다.
if (typeof module !== 'undefined') {
  module.exports = {
    getData: getData, addJob: addJob, updateJob: updateJob, deleteJob: deleteJob,
    parseSheet_: parseSheet_, findSlot_: findSlot_, cleanJob_: cleanJob_, rowKind_: rowKind_
  };
}
