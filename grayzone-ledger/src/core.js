'use strict';
/**
 * 장부 시트의 규칙. 입출력 없이 값만 다룹니다.
 *
 * 앱은 「장부」 시트의 A~P열(사람이 입력하는 칸)만 읽고 씁니다. Q~S열(연도·월·미수금)과
 * 요약·미수금·거래처별 시트는 시트 수식이 계산하므로 건드리지 않습니다.
 * 행 번호(row)는 시트에 보이는 번호(1부터)입니다.
 */

const SHEET_TITLE = '장부';
const INPUT_COLS = 16; // A~P
const FIELDS = ['date', 'client', 'director', 'pd', 'title', 'amount', 'type', 'quote',
  'invoice', 'paid', 'paidAmount', 'paidDate', 'incentive', 'note', 'extra', 'attrYear'];
const DATE_FIELDS = new Set(['date', 'paidDate']);
const NUMBER_FIELDS = new Set(['amount', 'paidAmount', 'incentive', 'attrYear']);
const CHOICES = {
  type: ['', '서비스'],
  quote: ['', '완료', 'X'],
  invoice: ['', '완료', 'X', '*'],
  paid: ['', '완료', 'X'],
};
const DATE_FORMAT = { type: 'DATE', pattern: 'yyyy-mm-dd' };

class UserError extends Error {}

// ---------- 날짜 ----------
// 시트의 날짜는 1899-12-30부터 센 일수(serial)입니다. 날짜만 다루므로 시간대와 무관합니다.
const EPOCH = Date.UTC(1899, 11, 30);
function serialToIso(n) {
  return new Date(EPOCH + Math.floor(n) * 86400000).toISOString().slice(0, 10);
}
function isoToSerial(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - EPOCH) / 86400000;
}
function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return serialToIso(isoToSerial(s)) === s; // 2026-02-31 같은 날짜를 거릅니다.
}
function localToday(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

const blank = (v) => v === '' || v === null || v === undefined;

// ---------- 읽기 ----------

/** 행의 종류: 'year'(2026년), 'month'(1월·기타), 'job', 'empty', 'other' */
function rowKind(r) {
  const a = r[0];
  if (typeof a === 'number' || !blank(r[1]) || !blank(r[4]) || !blank(r[5])) return 'job';
  if (typeof a === 'string' && a.trim() !== '') {
    const t = a.trim();
    if (/^\d{4}년$/.test(t)) return 'year';
    if (/^\d{1,2}월$/.test(t) || /^기타/.test(t)) return 'month';
    return 'other';
  }
  for (let i = 0; i < INPUT_COLS; i++) if (!blank(r[i])) return 'other';
  return 'empty';
}

/**
 * 시트 값(A~P, 1행 머리줄 포함)을 작업 목록과 연도·월 묶음으로 풉니다.
 * rowCount 는 시트 전체 행 수로, 값 목록 끝에서 잘린 빈 행을 마지막 묶음에 붙이는 데 씁니다.
 * 연도·월·미수금은 시트 Q~S열 수식과 같은 규칙으로 계산합니다.
 */
function parseSheet(values, rowCount = values.length) {
  const jobs = [];
  const blocks = [];
  const kinds = [];
  let year = null;
  let block = null;
  const total = Math.max(values.length, rowCount);
  for (let i = 1; i < total; i++) {
    const r = values[i] || [];
    const row = i + 1;
    const kind = rowKind(r);
    kinds[row] = kind;
    if (kind === 'year') {
      year = Number(r[0].trim().slice(0, 4));
      block = null;
    } else if (kind === 'month') {
      const t = r[0].trim();
      block = { year, month: /^기타/.test(t) ? 0 : Number(t.replace('월', '')), header: row, first: row + 1, last: row };
      blocks.push(block);
    } else {
      if (block) block.last = row;
      if (kind === 'job') jobs.push(parseJob(r, row));
    }
  }
  return { jobs, blocks, kinds };
}

function parseJob(r, row) {
  const j = { row };
  FIELDS.forEach((f, i) => {
    const v = r[i];
    if (DATE_FIELDS.has(f)) j[f] = typeof v === 'number' ? serialToIso(v) : blank(v) ? '' : String(v);
    else if (NUMBER_FIELDS.has(f)) j[f] = typeof v === 'number' ? v : blank(v) ? '' : String(v);
    else j[f] = blank(v) ? '' : String(v);
  });
  const dated = isIsoDate(j.date);
  const dateYear = dated ? Number(j.date.slice(0, 4)) : null;
  j.year = j.attrYear !== '' && !isNaN(Number(j.attrYear)) ? Number(j.attrYear) : dateYear;
  j.month = dated && dateYear === j.year ? Number(j.date.slice(5, 7)) : 0; // 0 = 기타
  const amount = typeof j.amount === 'number' ? j.amount : 0;
  const got = typeof j.paidAmount === 'number' ? j.paidAmount : 0;
  j.unpaid = j.paid === '완료' ? 0 : Math.max(0, amount - got);
  return j;
}

function fingerprint(j) {
  return [j.date, j.client, j.title, blank(j.amount) ? '' : Number(j.amount)].join('|');
}

/** 앱이 보던 행(expect)이 지금도 그 자리에 있는지 확인합니다. */
function findJob(parsed, row, expect) {
  const found = parsed.jobs.find((j) => j.row === row);
  if (!found || !expect || fingerprint(found) !== fingerprint(expect)) {
    throw new UserError('장부가 그 사이에 바뀌었습니다. 새로 고친 뒤 다시 해 주세요.');
  }
  return found;
}

// ---------- 입력 검사 ----------

/** 앱에서 온 값을 검사하고 정리합니다. full=true 면 모든 항목을 채워 돌려줍니다. */
function cleanJob(input, full) {
  if (!input || typeof input !== 'object') throw new UserError('입력 내용이 없습니다.');
  const out = {};
  for (const f of FIELDS) {
    if (!(f in input)) {
      if (full) out[f] = '';
      continue;
    }
    const v = input[f];
    if (blank(v)) { out[f] = ''; continue; }
    if (DATE_FIELDS.has(f)) {
      if (!isIsoDate(v)) throw new UserError('날짜 형식이 올바르지 않습니다: ' + v);
      out[f] = v;
    } else if (NUMBER_FIELDS.has(f)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new UserError('금액은 0 이상의 숫자여야 합니다: ' + v);
      out[f] = n;
    } else {
      const s = String(v).trim();
      if (CHOICES[f] && !CHOICES[f].includes(s)) throw new UserError('선택할 수 없는 값입니다: ' + s);
      out[f] = s;
    }
  }
  if (full && (!out.date || !out.client || !out.title)) {
    throw new UserError('납품일·거래처·내용은 꼭 입력해야 합니다.');
  }
  return out;
}

// ---------- 쓰기 계획 ----------

function findBlock(parsed, iso) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const b = parsed.blocks.find((x) => x.year === y && x.month === m);
  if (!b) throw new UserError(`장부에 ${y}년 ${m}월 묶음이 없습니다. 시트에 그 달 묶음을 먼저 만들어 주세요.`);
  return b;
}

/**
 * 새 작업이 들어갈 자리. 그 달 묶음 안의 첫 빈 행, 없으면 묶음의 마지막 행 바로 아래에 행을 삽입합니다.
 * 마지막 행 바로 아래에 삽입하면 시트가 월·연도 묶음을 함께 늘리고, 바로 위 행의 서식과
 * 드롭다운을 물려받습니다(실제 Google Sheets 에서 확인한 동작).
 */
function planSlot(parsed, iso) {
  const b = findBlock(parsed, iso);
  for (let row = b.first; row <= b.last; row++) {
    if (parsed.kinds[row] === 'empty') return { row, insert: false };
  }
  if (b.last < b.first) {
    throw new UserError(`${b.year}년 ${b.month}월 묶음에 행이 하나도 없습니다. 시트에서 그 달 아래에 빈 행을 하나 만들어 주세요.`);
  }
  return { row: b.last + 1, insert: true };
}

// Sheets API batchUpdate 요청을 만듭니다. 문자열은 stringValue 로 보내므로 수식으로 해석되지 않습니다.
function cellOf(field, v) {
  if (blank(v)) return {};
  if (DATE_FIELDS.has(field) && isIsoDate(v)) return { userEnteredValue: { numberValue: isoToSerial(v) } };
  if (typeof v === 'number') return { userEnteredValue: { numberValue: v } };
  return { userEnteredValue: { stringValue: String(v) } };
}

function insertRowRequest(sheetId, row) {
  return { insertDimension: { range: { sheetId, dimension: 'ROWS', startIndex: row - 1, endIndex: row }, inheritFromBefore: true } };
}

/** 한 행의 A~P 를 job 값으로 덮어씁니다(빠진 항목은 비웁니다). 날짜 칸에는 날짜 서식도 겁니다. */
function writeRowRequests(sheetId, row, job) {
  const reqs = [{
    updateCells: {
      start: { sheetId, rowIndex: row - 1, columnIndex: 0 },
      rows: [{ values: FIELDS.map((f) => cellOf(f, job[f])) }],
      fields: 'userEnteredValue',
    },
  }];
  FIELDS.forEach((f, i) => {
    if (DATE_FIELDS.has(f) && isIsoDate(job[f])) reqs.push(dateFormatRequest(sheetId, row, i));
  });
  return reqs;
}

/** 한 행에서 patch 에 있는 칸만 고칩니다. */
function patchCellsRequests(sheetId, row, patch) {
  const reqs = [];
  FIELDS.forEach((f, i) => {
    if (!(f in patch)) return;
    reqs.push({
      updateCells: {
        start: { sheetId, rowIndex: row - 1, columnIndex: i },
        rows: [{ values: [cellOf(f, patch[f])] }],
        fields: 'userEnteredValue',
      },
    });
    if (DATE_FIELDS.has(f) && isIsoDate(patch[f])) reqs.push(dateFormatRequest(sheetId, row, i));
  });
  return reqs;
}

function clearRowRequest(sheetId, row) {
  return {
    updateCells: {
      range: { sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 0, endColumnIndex: INPUT_COLS },
      fields: 'userEnteredValue',
    },
  };
}

function dateFormatRequest(sheetId, row, col) {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: col, endColumnIndex: col + 1 },
      cell: { userEnteredFormat: { numberFormat: DATE_FORMAT } },
      fields: 'userEnteredFormat.numberFormat',
    },
  };
}

module.exports = {
  SHEET_TITLE, INPUT_COLS, FIELDS, UserError,
  serialToIso, isoToSerial, isIsoDate, localToday,
  rowKind, parseSheet, fingerprint, findJob, cleanJob, findBlock, planSlot,
  insertRowRequest, writeRowRequests, patchCellsRequests, clearRowRequest,
};
