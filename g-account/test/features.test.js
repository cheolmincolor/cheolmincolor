'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Service } = require('../src/service');
const core = require('../src/core');
const { fixture, memoryStore, ID } = require('./fake-google');
const { makeService, ok, expectOf } = require('./helpers');

/** today 를 바꿀 수 있는 Service */
function at(today, google = fixture()) {
  google.refreshTokens.add('r');
  const store = memoryStore();
  store.set({ client: { id: 'c', secret: 'fake-secret' }, spreadsheetId: ID });
  store.setToken('r');
  const service = new Service({ store, fetch: google.fetch, today: () => today, openExternal: () => {}, pickFile: async () => null, log: () => {} });
  return { service, google, store };
}
const find = (d, title) => d.jobs.find((j) => j.title === title);

// ---------- 부가세 ----------
test('부가세: 별도·포함 계산', () => {
  assert.deepEqual(core.vatOf(3000000, '부가세 별도'), { supply: 3000000, vat: 300000, total: 3300000 });
  assert.deepEqual(core.vatOf(1234567, '부가세 별도'), { supply: 1234567, vat: 123456, total: 1358023 }); // 원 미만 버림 = 시트 ROUNDDOWN
  assert.deepEqual(core.vatOf(1100000, '부가세 포함'), { supply: 1000000, vat: 100000, total: 1100000 });
  assert.deepEqual(core.vatOf(1000000, '부가세 포함'), { supply: 909091, vat: 90909, total: 1000000 }); // 시트 ROUND
  assert.deepEqual(core.vatOf('', '부가세 별도'), { supply: 0, vat: 0, total: 0 });
});

test('부가세: 분기 합계는 납품일 기준, 계산서 미발행 따로', async () => {
  const { service } = makeService();
  const d = await ok(service, 'getData');
  assert.deepEqual(d.vat, { basis: '부가세 별도', hasSheet: true });
  const q = core.vatQuarters(d.jobs, 2026, d.vat.basis);
  assert.deepEqual(q.map((x) => x.count), [7, 10, 9, 6]);
  assert.deepEqual(q.map((x) => x.supply), [23000000, 23000000, 79700000, 19000000]); // 1~3월 2+14.5+6.5 / 4~6월 8+6+9 / 7~9월 6.5+58+15.2 / 10~11월 15+4 (백만 원)
  assert.equal(q.reduce((a, x) => a + x.supply, 0), 144700000); // 연간 = 2026년 매출
  assert.deepEqual(q.map((x) => x.vat), [2300000, 2300000, 7970000, 1900000]);
  assert.deepEqual(q.map((x) => [x.noInvoice, x.noInvoiceSupply]), [[0, 0], [0, 0], [0, 0], [6, 19000000]]); // 10~11월 6건은 계산서 미발행
  // 귀속연도로 2025년에 넣은 2024-12 납품 건은 부가세는 2024년 4분기
  assert.equal(core.vatQuarters(d.jobs, 2024, d.vat.basis)[3].supply, 3000000);
});

test('부가세 기준 바꾸기는 「부가세」 탭 B5 에 씀', async () => {
  const { service, google } = makeService();
  const d = await ok(service, 'setVatBasis', ['부가세 포함']);
  assert.equal(google.vatBasis, '부가세 포함');
  assert.equal(d.vat.basis, '부가세 포함');
  assert.match((await service.run('setVatBasis', ['몰라'])).err, /별도.*포함/);
  google.vatBasis = null; // 탭이 없는 시트
  const r = await ok(service, 'getData');
  assert.deepEqual(r.vat, { basis: '부가세 별도', hasSheet: false });
  assert.match((await service.run('setVatBasis', ['부가세 포함'])).err, /「부가세」 탭이 없습니다/);
});

// ---------- 장부 점검 ----------
test('점검: 고칠 만한 행을 찾고, 숨긴 항목은 빠짐', async () => {
  const google = fixture();
  const row = (title) => google.rowOf(title);
  const set = (title, col, v) => { google.grid[row(title) - 1].v[col] = v; };
  set('26년 3월 작업 1', 5, '');                         // 금액 없음
  set('26년 3월 작업 2', 10, 9000000);                   // 과입금
  set('26년 3월 작업 3', 0, core.isoToSerial('2026-04-30')); // 3월 묶음에 4월 날짜
  set('26년 2월 작업 1', 0, '2월말');                     // 날짜가 아님
  set('26년 2월 작업 2', 1, '');                          // 거래처 없음
  set('26년 6월 작업 1', 11, core.isoToSerial('2026-07-01')); // 입금일만 있음 (지급 완료 아님으로 바꿈)
  set('26년 6월 작업 1', 9, '');
  set('26년 6월 작업 2', 5, 0);                           // 0원인데 서비스 아님
  set('26년 7월 작업 2', 0, core.isoToSerial('2027-03-01')); // 먼 미래 (+ 묶음 다름)
  const dupe = google.grid[row('26년 5월 작업 1') - 1].v.slice();
  google.grid[row('26년 5월 작업 3')].v = dupe;          // 5월의 빈 행에 똑같은 행
  // 실제 장부의 「영화 목스박」처럼 같은 날·같은 내용이어도 비고(계약금/잔금)가 다르면 중복 아님
  const a = google.grid[row('26년 4월 작업 1') - 1].v; a[13] = '계약금';
  const b2 = a.slice(); b2[13] = '잔금';
  google.grid[row('26년 4월 작업 4')].v = b2;
  const { service } = at('2026-11-17', google);
  const d = await ok(service, 'getData');
  const got = d.checks.map((c) => `${c.type}:${c.row}`);
  const exp = [
    ['notDate', '26년 2월 작업 1'], ['noClient', '26년 2월 작업 2'], ['noAmount', '26년 3월 작업 1'],
    ['overpaid', '26년 3월 작업 2'], ['wrongBlock', '26년 3월 작업 3'], ['duplicate', null],
    ['paidDateOnly', '26년 6월 작업 1'], ['zeroNotService', '26년 6월 작업 2'],
    ['wrongBlock', '26년 7월 작업 2'], ['farFuture', '26년 7월 작업 2'],
  ];
  for (const [type, title] of exp) {
    const r = title ? row(title) : row('26년 5월 작업 3') + 1;
    assert.ok(got.includes(`${type}:${r}`), `${type} ${title} 없음: ${got.join(', ')}`);
  }
  assert.equal(d.checks.length, exp.length, got.join(', '));
  assert.equal(d.checks.find((c) => c.type === 'overpaid').label, '입금액이 견적금액보다 많음');

  // 숨기기 → 빠짐, 다시 보기 → 돌아옴
  const key = d.checks.find((c) => c.type === 'zeroNotService').key;
  const h = await ok(service, 'dismissCheck', [key]);
  assert.equal(h.checks.length, exp.length - 1);
  assert.equal(h.hiddenChecks, 1);
  assert.equal((await ok(service, 'resetChecks')).checks.length, exp.length);
});

test('점검: 서비스 건·기타 묶음·귀속연도 건은 문제로 보지 않음', async () => {
  const { service } = makeService();
  const d = await ok(service, 'getData');
  assert.deepEqual(d.checks, []); // 픽스처에는 서비스 0원 건, 기타 묶음의 2024 납품(귀속 2025) 건이 있음
});

// ---------- 다음 해 묶음 ----------
function checkYearBlock(google, year, filled = []) {
  const header = google.grid.findIndex((r) => r.v[0] === `${year}년`) + 1;
  assert.ok(header > 0, `${year}년 머리줄 없음`);
  assert.equal(google.grid[header - 1].f.kind, 'yearHeader');
  assert.equal(google.grid[header - 1].f.validation, undefined);
  assert.match(google.value(header, 2), new RegExp(`VLOOKUP\\(${year},`));
  let r = header + 1;
  for (let m = 1; m <= 12; m++) {
    assert.equal(google.cells(r)[0], `${m}월`);
    assert.equal(google.value(r, 2), `=LET(n,COUNTIFS($Q$2:$Q,${year},$R$2:$R,"${m}월"),IF(n=0,"",n&"건"))`);
    assert.equal(google.grid[r - 1].f.kind, 'monthHeader');
    assert.equal(google.grid[r - 1].f.validation, undefined); // 머리줄에는 드롭다운·날짜 검사 없음
    const n = m === 12 ? 22 : 15;
    for (let i = 1; i <= n; i++) {
      if (!filled.includes(r + i)) assert.equal(google.cells(r + i).slice(0, 16).join(''), '');
      assert.equal(google.grid[r + i - 1].f.validation, 'job');
      assert.equal(google.depth(r + i), 2);
    }
    assert.equal(google.depth(r), 1);
    r += n + 1;
  }
  assert.equal(google.depth(header), 0);
  return { header, end: r - 1 };
}

test('다음 해 묶음: 11월이 되면 앱을 열 때 자동으로 만듦 (이전 해 묶음은 그대로)', async () => {
  const google = fixture();
  const before = JSON.stringify(google.grid.slice(0, google.grid.findIndex((r) => r.v[0] === '2027년') + 1 + 200 - 200));
  const groups2027 = google.groups.filter((g) => g.start >= google.grid.findIndex((r) => r.v[0] === '2027년')).map((g) => ({ ...g }));
  const { service } = at('2027-11-02', google);
  const d = await ok(service, 'getData');
  assert.equal(d.notice, '시트에 2028년 묶음을 만들었습니다.');
  assert.deepEqual(d.years, { last: 2028, next: 2029 });
  const { header } = checkYearBlock(google, 2028);
  const y27 = google.groups.find((g) => g.depth === 1 && g.start === google.grid.findIndex((r) => r.v[0] === '2027년') + 1);
  assert.equal(y27.end, header - 1); // 2027년 묶음은 늘어나지 않음
  assert.deepEqual(google.groups.filter((g) => groups2027.some((x) => x.start === g.start)).map((g) => g.end), groups2027.map((g) => g.end));
  assert.equal(JSON.stringify(google.grid.slice(0, JSON.parse(before).length)), before);
  // 다시 열어도 또 만들지 않음
  assert.equal((await ok(service, 'getData')).notice, '');
  // 새 묶음에 등록이 됨
  const r = await ok(service, 'addJob', [{ date: '2028-01-10', client: 'A', title: '2028 첫 작업', amount: 1000 }]);
  assert.equal(find(r, '2028 첫 작업').row, header + 2);
});

test('다음 해 묶음: 10월엔 자동으로 안 만들지만, 다음 해 날짜로 등록하면 만들고 넣음', async () => {
  const google = fixture();
  const { service } = at('2027-10-20', google);
  assert.equal((await ok(service, 'getData')).years.last, 2027);
  const d = await ok(service, 'addJob', [{ date: '2028-03-05', client: 'B', title: '미리 잡은 작업', amount: 2000000 }]);
  assert.equal(d.notice, '시트에 2028년 묶음을 만들었습니다.');
  const j = find(d, '미리 잡은 작업');
  const { header } = checkYearBlock(google, 2028, [j.row]);
  assert.equal(google.cells(j.row - 1)[0], '3월'); // 3월 묶음의 첫 행
  assert.equal(j.row, header + 1 + 2 * 16 + 1);
  // 몇 년 뒤(오타일 수 있음)는 만들지 않음
  assert.match((await service.run('addJob', [{ date: '2031-01-01', client: 'B', title: 'x', amount: 1 }])).err, /2031년 1월 묶음이 없습니다/);
});

test('다음 해 묶음: 설정의 버튼으로도 만들 수 있고, 아래에 내용이 있으면 만들지 않음', async () => {
  const google = fixture();
  const { service } = at('2026-11-17', google);
  const d = await ok(service, 'createNextYear');
  assert.equal(d.notice, '시트에 2028년 묶음을 만들었습니다.');
  checkYearBlock(google, 2028);

  const g2 = fixture();
  const end27 = g2.groups.filter((g) => g.depth === 1).pop().end;
  g2.grid[end27 + 5].v[4] = '누가 적어 둔 메모';
  const s2 = at('2026-11-17', g2).service;
  const snap = JSON.stringify(g2.grid);
  assert.match((await s2.run('createNextYear')).err, /내용이 있어 2028년 묶음을 만들지 않았습니다/);
  assert.equal(JSON.stringify(g2.grid), snap);
});

test('다음 해 묶음: 몇 해 건너뛰고 열면 차례로 만들되 한 번에 최대 3년', async () => {
  const google = fixture();
  const { service } = at('2032-01-05', google);
  const d = await ok(service, 'getData');
  assert.equal(d.notice, '시트에 2028·2029·2030년 묶음을 만들었습니다.');
  for (const y of [2028, 2029, 2030]) checkYearBlock(google, y);
});

test('다음 해 묶음 요청: 서식 → 값 → 묶음 순서, Q열 이후는 건드리지 않음', () => {
  const { requests, rows } = core.yearBlockRequests({
    sheetId: 11, year: 2028, fromYear: 2027, start: 799, rowCount: 3067, columnCount: 22,
    templates: { yearRow: 599, monthRow: 600, jobRow: 601, yearCells: ['2027년', '', "=IFERROR(VLOOKUP(2027,'요약'!$H$10:$L$40,2,FALSE),\"\")"], monthCells: ['1월', '', '=COUNTIFS($Q$2:$Q,2027,$R$2:$R,"1월")'] },
  });
  assert.equal(rows, 200);
  assert.equal(requests.some((r) => r.appendDimension), false); // 3067행 안에 들어감
  const kinds = requests.map((r) => Object.keys(r)[0]);
  assert.deepEqual([...new Set(kinds)], ['copyPaste', 'setDataValidation', 'updateCells', 'addDimensionGroup']);
  assert.equal(kinds.filter((k) => k === 'setDataValidation').length, 13);
  // 작업 행 서식은 작업 행에만 (머리줄 행에는 머리줄 서식만)
  const pastes = requests.filter((r) => r.copyPaste).map((r) => r.copyPaste);
  const jobPastes = pastes.filter((p) => p.source.startRowIndex === 600);
  assert.equal(jobPastes.length, 12);
  assert.ok(jobPastes.every((p) => p.destination.startRowIndex >= 800 && ![798, 799, 815, 831, 975].includes(p.destination.startRowIndex)));
  assert.equal(kinds.filter((k) => k === 'addDimensionGroup').length, 13);
  const cells = requests.find((r) => r.updateCells).updateCells;
  assert.equal(cells.rows.length, 200);
  assert.ok(cells.rows.every((r) => r.values.length <= 16));
  assert.equal(cells.rows[0].values[2].userEnteredValue.formulaValue, "=IFERROR(VLOOKUP(2028,'요약'!$H$10:$L$40,2,FALSE),\"\")");
  assert.equal(cells.rows[1 + 16 * 10].values[2].userEnteredValue.formulaValue, '=COUNTIFS($Q$2:$Q,2028,$R$2:$R,"11월")');
  assert.equal(cells.rows[1 + 16 * 10].values[0].userEnteredValue.stringValue, '11월');
  assert.deepEqual(requests.find((r) => r.addDimensionGroup).addDimensionGroup.range, { sheetId: 11, dimension: 'ROWS', startIndex: 799, endIndex: 998 });
});
