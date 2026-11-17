// Apps Script 없이 Code.gs 를 돌리기 위한 가짜 시트. 테스트 데이터는 모두 지어낸 것입니다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const COLS = 19;
const blankRow = () => Array(COLS).fill('');
const d = (s) => new Date(s + 'T00:00:00Z'); // 가짜 시트의 시간대는 UTC 로 둡니다.

class FakeSheet {
  constructor(rows) {
    this.rows = rows.map((r) => r.row);
    this.depth = rows.map((r) => r.depth);
    this.log = [];
  }
  getDataRange() { return this.getRange(1, 1, this.rows.length, COLS); }
  getLastColumn() { return COLS; }
  getSheetId() { return 11; }
  getRowGroupDepth(row) { return this.depth[row - 1]; }
  insertRowAfter(row) {
    this.rows.splice(row, 0, blankRow());
    this.depth.splice(row, 0, 0); // 일부러 묶음 밖으로 넣어, 코드가 깊이를 맞추는지 봅니다.
    this.log.push(['insertRowAfter', row]);
  }
  getRange(row, col, nr = 1, nc = 1) {
    const sheet = this;
    return {
      getNumRows: () => nr,
      getValues: () => sheet.rows.slice(row - 1, row - 1 + nr).map((r) => r.slice(col - 1, col - 1 + nc)),
      setValues(vals) {
        if (col + nc - 1 > 16) throw new Error('자동 계산 열(Q~S)에 쓰려고 했습니다');
        vals.forEach((v, i) => v.forEach((x, k) => { sheet.rows[row - 1 + i][col - 1 + k] = x; }));
      },
      setValue(v) { this.setValues([[v]]); },
      clearContent() { this.setValues(Array.from({ length: nr }, () => Array(nc).fill(''))); },
      copyTo() { sheet.log.push(['copyFormat', row]); },
      shiftRowGroupDepth(delta) { sheet.depth[row - 1] += delta; },
    };
  }
}

// 지어낸 장부: 2025년(빈 행 없음), 2026년(달마다 빈 행 2개), 2027년(빈 행만)
function fixture() {
  const rows = [];
  const push = (cells, depth) => { const r = blankRow(); cells.forEach((c, i) => { r[i] = c; }); rows.push({ row: r, depth }); };
  const job = (date, client, director, pd, title, amount, o = {}) => push([
    d(date), client, director, pd, title, amount, o.type || '', o.quote || '', o.invoice || '', o.paid || '',
    o.paidAmount ?? '', o.paidDate ? d(o.paidDate) : '', '', o.note || '', '', o.attrYear ?? ''], 2);
  const done = { invoice: '완료', paid: '완료' };
  push(['납품일', '거래처', '감독', 'PD', '내용', '견적금액', '구분', '견적서', '계산서', '지급', '입금액', '입금일', '인센티브', '비고', '원본 추가정보', '귀속연도(필요시)'], 0);

  push(['2025년', '', '(합계 수식)'], 0);
  push(['기타 (2024 납품)', '', '(합계 수식)'], 1);
  job('2024-12-20', '오로라 필름', '한지우', '', '브랜드 필름', 3000000, { attrYear: 2025 });
  const y25 = [[4, 5, 3], [6, 2, 4, 3], [5, 5], [3, 4, 6], [2, 8], [7, 3], [4, 4, 2], [5, 3], [6, 6], [3, 5, 4], [8, 2], [5, 4, 3]];
  const clients = ['오로라 필름', '모노 스튜디오', '하늘 프로덕션', '블루도트'];
  y25.forEach((amts, m) => {
    push([`${m + 1}월`, '', '(합계 수식)'], 1);
    amts.forEach((a, k) => job(`2025-${String(m + 1).padStart(2, '0')}-${String(5 + k * 7).padStart(2, '0')}`,
      clients[(m + k) % 4], '감독' + ((m + k) % 3 + 1), '', `25년 ${m + 1}월 작업 ${k + 1}`, a * 1000000, done));
  });

  push(['2026년', '', '(합계 수식)'], 0);
  const y26 = [[2], [8, 4, 2.5], [2, 3, 1.5], [1.5, 4, 2.5, 0], [3, 1, 2], [3, 4, 2], [5, 1.5], [36, 6, 12, 4], [8, 6, 1.2], [3, 2, 4, 6], [1, 3]];
  y26.forEach((amts, m) => {
    push([`${m + 1}월`, '', '(합계 수식)'], 1);
    amts.forEach((a, k) => {
      const date = `2026-${String(m + 1).padStart(2, '0')}-${String(3 + k * 6).padStart(2, '0')}`;
      const o = a === 0 ? { type: '서비스', ...done }
        : m >= 9 ? {}                                   // 10~11월: 계산서 미발행
        : m >= 7 && k % 2 === 0 ? { invoice: '완료' }   // 8~9월 일부: 계산서만 발행
        : done;
      job(date, clients[(m + k) % 4], '감독' + ((m + k) % 3 + 1), k % 2 ? '피디' + (k + 1) : '', `26년 ${m + 1}월 작업 ${k + 1}`, a * 1000000, o);
    });
    push([], 2); push([], 2);
  });
  push(['12월'], 1); push([], 2); push([], 2);

  push(['2027년'], 0);
  for (let m = 1; m <= 12; m++) { push([`${m}월`], 1); push([], 2); }
  return new FakeSheet(rows);
}

function fmt(date) { return date.toISOString().slice(0, 10); }

// Code.gs 를 가짜 Apps Script 전역과 함께 불러옵니다.
function load(sheet, today = '2026-11-17') {
  const sandbox = {
    module: { exports: {} },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n) => (n === '장부' ? sheet : null),
        getSpreadsheetTimeZone: () => 'UTC',
        getUrl: () => 'https://docs.google.com/spreadsheets/d/FAKE/edit',
      }),
      flush() {},
      CopyPasteType: { PASTE_FORMAT: 'F', PASTE_DATA_VALIDATION: 'V' },
    },
    LockService: { getDocumentLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      formatDate: (date) => (date instanceof RealDate ? fmt(date) : today),
      parseDate: (s) => d(s),
    },
    HtmlService: {},
  };
  // 샌드박스 안의 `new Date()`(오늘)만 고정하고, 시트에서 온 Date 는 그대로 씁니다.
  const RealDate = Date;
  sandbox.Date = class extends RealDate {};
  sandbox.Utilities.formatDate = (date) => (date instanceof sandbox.Date ? today : fmt(date));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), sandbox);
  return sandbox.module.exports;
}

module.exports = { FakeSheet, fixture, load, d, fmt };
