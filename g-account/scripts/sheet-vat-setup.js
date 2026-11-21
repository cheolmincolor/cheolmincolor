'use strict';
/**
 * 「GRAYZONE 매출 장부」에 부가세를 붙이는 한 번짜리 변경(Sheets API batchUpdate 요청)을 만듭니다.
 *   node scripts/sheet-vat-setup.js > requests.json
 *
 * 하는 일 (기존 칸의 내용은 바꾸지 않습니다)
 * 1. 「장부」 끝에 자동 열 3개: T 공급가(자동) · U 부가세(자동) · V 합계(자동). Q~S 처럼 1행 수식 하나로 계산합니다.
 *    서식·보호(경고만)·조건부 서식·필터·필터 보기 범위를 T~V 까지 넓힙니다.
 * 2. 「부가세」 탭: 연도(B4)와 견적금액 기준(B5: 부가세 별도/포함)을 고르면 분기별 공급가·부가세·합계와
 *    계산서 미발행 건을 보여 줍니다. 앱도 B5 를 읽고 씁니다.
 * 3. 「사용법」 탭에 설명 두 줄.
 *
 * 2026-11-17 의 실제 장부 구조(시트 ID·필터 보기 ID·조건부 서식 순서)를 기준으로 합니다.
 */

const LEDGER = 11;   // 「장부」
const VAT = 15;      // 새 「부가세」 탭
const GUIDE = 14;    // 「사용법」
const ROWS = 3067;   // 「장부」 행 수
const COLS = 22;     // A~V
const FILTER_VIEWS = [184457442, 1391835656, 1937657147, 712831083, 1695454389, 275108955];
const PROTECTED = 386761191; // 「자동 계산 열」 보호(경고만)

const B = "'부가세'!$B$5";
const INCL = '"부가세 포함"';
const JOB = 'ISNUMBER(A2:A)+LEN(B2:B)+LEN(E2:E)+LEN(F2:F)=0';
const auto = (title, incl, excl) => `={"${title}";ARRAYFORMULA(IF(${JOB},"",IF(ISNUMBER(F2:F),IF(${B}=${INCL},${incl},${excl}),"")))}`;
const LEDGER_FORMULAS = [
  auto('공급가(자동)', 'ROUND(F2:F/1.1)', 'F2:F'),
  auto('부가세(자동)', 'F2:F-ROUND(F2:F/1.1)', 'ROUNDDOWN(F2:F*0.1)'),
  auto('합계(자동)', 'F2:F', 'F2:F+ROUNDDOWN(F2:F*0.1)'),
];

const gray = (v) => ({ red: v, green: v, blue: v });
const font = 'Noto Sans KR';
const str = (s) => ({ userEnteredValue: { stringValue: s } });
const num = (n) => ({ userEnteredValue: { numberValue: n } });
const fx = (f) => ({ userEnteredValue: { formulaValue: f } });
const range = (sheetId, r1, r2, c1, c2) => ({ sheetId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 });
const fmt = (sheetId, r1, r2, c1, c2, f, fields) => ({ repeatCell: { range: range(sheetId, r1, r2, c1, c2), cell: { userEnteredFormat: f }, fields } });

// 「부가세」 탭의 표
const crit = (s, e) => `'장부'!$A$2:$A,">="&DATE($B$4,${s},1),'장부'!$A$2:$A,"<"&DATE($B$4,${e},1)`;
const NOT_ISSUED = `'장부'!$I$2:$I,"<>완료"`;
const quarter = (label, period, s, e) => [str(label), str(period),
  fx(`=COUNTIFS(${crit(s, e)})`),
  fx(`=SUMIFS('장부'!$T$2:$T,${crit(s, e)})`),
  fx(`=SUMIFS('장부'!$U$2:$U,${crit(s, e)})`),
  fx(`=SUMIFS('장부'!$V$2:$V,${crit(s, e)})`),
  fx(`=COUNTIFS(${crit(s, e)},${NOT_ISSUED},'장부'!$F$2:$F,">0")`),
  fx(`=SUMIFS('장부'!$T$2:$T,${crit(s, e)},${NOT_ISSUED})`)];
const total = (label, period, a, b) => [str(label), str(period), ...'CDEFGH'.split('').map((c) => fx(`=${c}${a}+${c}${b}`))];

const VAT_ROWS = [
  [str('GRAYZONE 부가세')],
  [str('장부의 납품일 기준으로 분기별 공급가·부가세를 모읍니다. 실제 신고는 세금계산서 작성일 기준이니, 날짜가 다른 건은 신고 때 확인하세요.')],
  [],
  [str('연도'), num(2026)],
  [str('견적금액 기준'), str('부가세 별도'), str('← 견적금액에 부가세가 들어 있으면 「부가세 포함」으로 바꾸세요. 장부의 공급가·부가세·합계 열과 앱이 함께 바뀝니다.')],
  [],
  ['구분', '기간', '건수', '공급가', '부가세', '합계', '계산서 미발행', '미발행 공급가'].map(str),
  quarter('1분기', '1기 예정 · 1~3월', 1, 4),
  quarter('2분기', '1기 확정 · 4~6월', 4, 7),
  total('1기 합계', '1~6월', 8, 9),
  quarter('3분기', '2기 예정 · 7~9월', 7, 10),
  quarter('4분기', '2기 확정 · 10~12월', 10, 13),
  total('2기 합계', '7~12월', 11, 12),
  total('연간', '1~12월', 10, 13),
];

const GUIDE_ROWS = [
  [str('부가세'), str('장부의 공급가·부가세·합계(T~V열, 회색 글씨)는 자동 계산입니다. 견적금액이 부가세 별도인지 포함인지는 「부가세」 탭 B5에서 고릅니다(기본: 부가세 별도, 부가세는 원 미만 버림). 「부가세」 탭에서 연도를 고르면 분기별 합계와 계산서 미발행 건이 보입니다. 납품일 기준이라 세금계산서 작성일과 다르면 신고 때 확인하세요.')],
  [str('다음 해 묶음'), str('GRAYZONE 장부 앱이 11월부터 다음 해 연도·월 묶음을 마지막 연도 아래에 자동으로 만듭니다(달마다 빈 행 15개, 12월 22개). 앱의 설정에서 바로 만들 수도 있습니다.')],
];

function requests() {
  const reqs = [];
  // 1. 「장부」 T~V
  reqs.push({ appendDimension: { sheetId: LEDGER, dimension: 'COLUMNS', length: 3 } });
  reqs.push({ addSheet: { properties: { sheetId: VAT, title: '부가세', index: 4, gridProperties: { rowCount: 30, columnCount: 9, hideGridlines: true } } } });
  reqs.push({ updateCells: { start: { sheetId: VAT, rowIndex: 0, columnIndex: 0 }, rows: VAT_ROWS.map((values) => ({ values })), fields: 'userEnteredValue' } });
  reqs.push({ updateCells: { start: { sheetId: LEDGER, rowIndex: 0, columnIndex: 19 }, rows: [{ values: LEDGER_FORMULAS.map(fx) }], fields: 'userEnteredValue' } });
  reqs.push({ copyPaste: { source: range(LEDGER, 0, ROWS, 18, 19), destination: range(LEDGER, 0, ROWS, 19, 22), pasteType: 'PASTE_FORMAT' } });
  reqs.push({ updateDimensionProperties: { range: { sheetId: LEDGER, dimension: 'COLUMNS', startIndex: 19, endIndex: 22 }, properties: { pixelSize: 100 }, fields: 'pixelSize' } });
  reqs.push({ updateProtectedRange: { protectedRange: { protectedRangeId: PROTECTED, range: range(LEDGER, 0, ROWS, 16, COLS) }, fields: 'range' } });
  // 조건부 서식: 0 = 미수 행 빨간색(A~S), 2 = 월 머리줄 회색(B~S) → V 까지
  reqs.push({ updateConditionalFormatRule: { sheetId: LEDGER, index: 0, rule: {
    ranges: [range(LEDGER, 1, ROWS, 0, COLS)],
    booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=AND(ISNUMBER($S2),$S2>0)' }] },
      format: { backgroundColorStyle: { rgbColor: { red: 0.9882353, green: 0.92156863, blue: 0.91764706 } }, textFormat: { foregroundColorStyle: { rgbColor: { red: 0.5568628, green: 0.105882354, blue: 0.0627451 } } } } } } } });
  reqs.push({ updateConditionalFormatRule: { sheetId: LEDGER, index: 2, rule: {
    ranges: [range(LEDGER, 1, ROWS, 1, COLS)],
    booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=AND(ISTEXT($A2),RIGHT($A2,1)<>"년")' }] },
      format: { backgroundColorStyle: { rgbColor: gray(0.9372549) }, textFormat: { foregroundColorStyle: { rgbColor: gray(0.2901961) } } } } } } });
  for (const id of FILTER_VIEWS) reqs.push({ updateFilterView: { filter: { filterViewId: id, range: range(LEDGER, 0, ROWS, 0, COLS) }, fields: 'range' } });
  reqs.push({ setBasicFilter: { filter: { range: range(LEDGER, 0, ROWS, 0, COLS) } } });

  // 2. 「부가세」 탭 서식
  reqs.push(fmt(VAT, 0, 30, 0, 9, { textFormat: { fontFamily: font, fontSize: 10 }, verticalAlignment: 'MIDDLE' }, 'userEnteredFormat.textFormat,userEnteredFormat.verticalAlignment'));
  reqs.push(fmt(VAT, 0, 1, 0, 1, { textFormat: { fontFamily: font, fontSize: 14, bold: true } }, 'userEnteredFormat.textFormat'));
  reqs.push(fmt(VAT, 1, 2, 0, 1, { textFormat: { fontFamily: font, foregroundColorStyle: { rgbColor: gray(0.45) } } }, 'userEnteredFormat.textFormat'));
  reqs.push(fmt(VAT, 3, 5, 0, 1, { textFormat: { fontFamily: font, bold: true } }, 'userEnteredFormat.textFormat'));
  reqs.push(fmt(VAT, 3, 5, 1, 2, { backgroundColorStyle: { rgbColor: { red: 1, green: 0.94509804, blue: 0.8 } }, textFormat: { fontFamily: font, bold: true }, horizontalAlignment: 'LEFT' }, 'userEnteredFormat.backgroundColorStyle,userEnteredFormat.textFormat,userEnteredFormat.horizontalAlignment'));
  reqs.push(fmt(VAT, 4, 5, 2, 3, { textFormat: { fontFamily: font, foregroundColorStyle: { rgbColor: gray(0.45) } } }, 'userEnteredFormat.textFormat'));
  reqs.push(fmt(VAT, 6, 7, 0, 8, { backgroundColorStyle: { rgbColor: gray(0.12941177) }, textFormat: { fontFamily: font, bold: true, foregroundColorStyle: { rgbColor: gray(1) } }, horizontalAlignment: 'CENTER' }, 'userEnteredFormat.backgroundColorStyle,userEnteredFormat.textFormat,userEnteredFormat.horizontalAlignment'));
  reqs.push(fmt(VAT, 7, 14, 2, 8, { numberFormat: { type: 'NUMBER', pattern: '#,##0;(#,##0);"-"' } }, 'userEnteredFormat.numberFormat'));
  reqs.push(fmt(VAT, 7, 14, 1, 2, { textFormat: { fontFamily: font, foregroundColorStyle: { rgbColor: gray(0.45) } } }, 'userEnteredFormat.textFormat'));
  for (const r of [9, 12, 13]) reqs.push(fmt(VAT, r, r + 1, 0, 8, { backgroundColorStyle: { rgbColor: gray(0.92156863) }, textFormat: { fontFamily: font, bold: true } }, 'userEnteredFormat.backgroundColorStyle,userEnteredFormat.textFormat'));
  reqs.push({ updateBorders: { range: range(VAT, 6, 14, 0, 8), innerHorizontal: { style: 'SOLID', colorStyle: { rgbColor: gray(0.89) } }, bottom: { style: 'SOLID', colorStyle: { rgbColor: gray(0.62) } } } });
  for (const [c, w] of [[0, 110], [1, 150], [2, 70], [3, 130], [4, 120], [5, 130], [6, 110], [7, 130]]) {
    reqs.push({ updateDimensionProperties: { range: { sheetId: VAT, dimension: 'COLUMNS', startIndex: c, endIndex: c + 1 }, properties: { pixelSize: w }, fields: 'pixelSize' } });
  }
  reqs.push({ setDataValidation: { range: range(VAT, 3, 4, 1, 2), rule: { condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: "='요약'!$H$10:$H$40" }] }, showCustomUi: true, strict: true } } });
  reqs.push({ setDataValidation: { range: range(VAT, 4, 5, 1, 2), rule: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: '부가세 별도' }, { userEnteredValue: '부가세 포함' }] }, showCustomUi: true, strict: true } } });
  reqs.push({ updateSheetProperties: { properties: { sheetId: VAT, gridProperties: { frozenRowCount: 0 }, tabColorStyle: { rgbColor: gray(0.35) } }, fields: 'tabColorStyle' } });

  // 3. 「사용법」 두 줄 (14·15행, 13행 서식을 그대로)
  reqs.push({ updateCells: { start: { sheetId: GUIDE, rowIndex: 13, columnIndex: 0 }, rows: GUIDE_ROWS.map((values) => ({ values })), fields: 'userEnteredValue' } });
  reqs.push({ copyPaste: { source: range(GUIDE, 12, 13, 0, 2), destination: range(GUIDE, 13, 15, 0, 2), pasteType: 'PASTE_FORMAT' } });
  return reqs;
}

if (require.main === module) process.stdout.write(JSON.stringify(requests()));
module.exports = { requests, LEDGER_FORMULAS, VAT_ROWS };
