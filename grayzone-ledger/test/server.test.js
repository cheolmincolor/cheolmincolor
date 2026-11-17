const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, load, fmt } = require('./fake');

const setup = () => { const sheet = fixture(); return { sheet, api: load(sheet) }; };
const data = (json) => JSON.parse(json);
const rowOf = (sheet, title) => sheet.rows.findIndex((r) => r[4] === title) + 1;
const expectOf = (j) => ({ date: j.date, client: j.client, title: j.title, amount: j.amount });
const sum = (jobs, f) => jobs.reduce((a, j) => a + (f(j) || 0), 0);

test('읽기: 연도·월·미수금을 시트 수식과 같은 규칙으로 계산', () => {
  const { api } = setup();
  const { jobs, today } = data(api.getData());
  assert.equal(today, '2026-11-17');
  const y26 = jobs.filter((j) => j.year === 2026);
  assert.equal(y26.length, 32);
  assert.equal(sum(y26, (j) => j.amount), 144700000);
  // 귀속연도가 있는 2024년 납품 건은 2025년의 '기타'
  const carried = jobs.find((j) => j.title === '브랜드 필름');
  assert.deepEqual([carried.year, carried.month, carried.unpaid], [2025, 0, 3000000]);
  // 지급 완료 = 미수 0, 서비스 건 = 미수 0
  assert.equal(jobs.find((j) => j.title === '26년 1월 작업 1').unpaid, 0);
  assert.equal(jobs.find((j) => j.type === '서비스').unpaid, 0);
  assert.equal(jobs.find((j) => j.title === '26년 11월 작업 2').unpaid, 3000000);
});

test('등록: 그 달 묶음의 첫 빈 행에 들어가고 행 삽입은 없음', () => {
  const { sheet, api } = setup();
  const before = sheet.rows.length;
  const header = sheet.rows.findIndex((r, i) => r[0] === '11월' && i > 60) + 1;
  const out = data(api.addJob({ date: '2026-11-20', client: '새 거래처', director: '김감독', pd: '', title: '신규 광고', amount: 2500000 }));
  const row = rowOf(sheet, '신규 광고');
  assert.equal(row, header + 3); // 11월 머리줄 + 기존 2건 다음
  assert.equal(sheet.rows.length, before);
  assert.equal(fmt(sheet.rows[row - 1][0]), '2026-11-20'); // 날짜는 Date 로 저장
  assert.equal(sheet.rows[row - 1][5], 2500000);           // 금액은 숫자로 저장
  const j = out.jobs.find((x) => x.title === '신규 광고');
  assert.deepEqual([j.row, j.year, j.month, j.unpaid], [row, 2026, 11, 2500000]);
});

test('등록: 빈 행이 없는 달은 묶음 끝에 행을 삽입하고 서식·묶음 깊이를 맞춤', () => {
  const { sheet, api } = setup();
  const before = sheet.rows.length;
  const nextHeader = sheet.rows.findIndex((r) => r[0] === '4월') + 1;
  api.addJob({ date: '2025-03-30', client: '모노 스튜디오', title: '늦게 넣은 건', amount: 1000000 });
  const row = rowOf(sheet, '늦게 넣은 건');
  assert.equal(sheet.rows.length, before + 1);
  assert.equal(row, nextHeader);                // 3월 묶음의 마지막 = 예전 4월 머리줄 자리
  assert.equal(sheet.rows[row][0], '4월');      // 4월 머리줄은 한 칸 밀림
  assert.equal(sheet.getRowGroupDepth(row), 2);
  assert.ok(sheet.log.some((l) => l[0] === 'copyFormat'));
});

test('등록: 없는 연도·잘못된 값은 시트를 건드리지 않고 거절', () => {
  const { sheet, api } = setup();
  const snap = JSON.stringify(sheet.rows);
  assert.throws(() => api.addJob({ date: '2030-01-05', client: 'A', title: 'B', amount: 1 }), /2030년 1월 묶음이 없습니다/);
  assert.throws(() => api.addJob({ date: '2026-11-20', client: '', title: 'B', amount: 1 }), /꼭 입력/);
  assert.throws(() => api.addJob({ date: '2026-11-20', client: 'A', title: 'B', amount: -5 }), /0 이상/);
  assert.throws(() => api.addJob({ date: '2026-11-20', client: 'A', title: '=SUM(A1)', amount: 1 }), /= 로 시작/);
  assert.throws(() => api.addJob({ date: '2026-11-20', client: 'A', title: 'B', amount: 1, paid: '끝' }), /선택할 수 없는/);
  assert.equal(JSON.stringify(sheet.rows), snap);
});

test('계산서·입금: 바꾼 칸만 쓰고 미수금이 따라 바뀜', () => {
  const { sheet, api } = setup();
  let j = data(api.getData()).jobs.find((x) => x.title === '26년 11월 작업 2');
  const untouched = JSON.stringify(sheet.rows[j.row - 1].slice(0, 8));

  let out = data(api.updateJob(j.row, expectOf(j), { invoice: '완료' }));
  j = out.jobs.find((x) => x.row === j.row);
  assert.deepEqual([j.invoice, j.paid, j.unpaid], ['완료', '', 3000000]);

  out = data(api.updateJob(j.row, expectOf(j), { paidAmount: 1000000, paidDate: '2026-11-25' })); // 일부 입금
  j = out.jobs.find((x) => x.row === j.row);
  assert.deepEqual([j.paidAmount, j.paidDate, j.unpaid], [1000000, '2026-11-25', 2000000]);

  out = data(api.updateJob(j.row, expectOf(j), { paid: '완료', paidDate: '2026-12-01' })); // 전액 입금
  j = out.jobs.find((x) => x.row === j.row);
  assert.deepEqual([j.paid, j.paidDate, j.unpaid], ['완료', '2026-12-01', 0]);
  assert.equal(JSON.stringify(sheet.rows[j.row - 1].slice(0, 8)), untouched);
});

test('수정: 납품일을 다른 달로 바꾸면 그 달 묶음으로 옮기고 나머지 내용은 유지', () => {
  const { sheet, api } = setup();
  const j = data(api.getData()).jobs.find((x) => x.title === '26년 10월 작업 1');
  const out = data(api.updateJob(j.row, expectOf(j), { date: '2026-12-02', amount: 3500000 }));
  assert.equal(sheet.rows[j.row - 1].slice(0, 16).join(''), ''); // 원래 행은 빈 행
  const moved = out.jobs.find((x) => x.title === '26년 10월 작업 1');
  assert.deepEqual([moved.date, moved.month, moved.amount, moved.client, moved.director], ['2026-12-02', 12, 3500000, j.client, j.director]);
  assert.equal(sheet.rows[moved.row - 2][0], '12월');
  assert.equal(out.jobs.length, data(api.getData()).jobs.length);
});

test('안전장치: 시트의 행이 밀렸으면 다른 행을 고치지 않고 거절', () => {
  const { sheet, api } = setup();
  const j = data(api.getData()).jobs.find((x) => x.title === '26년 11월 작업 1');
  sheet.insertRowAfter(5); // 누군가 시트에서 위쪽에 행을 삽입
  const snap = JSON.stringify(sheet.rows);
  assert.throws(() => api.updateJob(j.row, expectOf(j), { paid: '완료' }), /그 사이에 바뀌었습니다/);
  assert.throws(() => api.deleteJob(j.row, expectOf(j)), /그 사이에 바뀌었습니다/);
  assert.equal(JSON.stringify(sheet.rows), snap);
});

test('삭제: 내용만 지우고, 그 빈 행은 다음 등록 때 다시 쓰임', () => {
  const { sheet, api } = setup();
  const j = data(api.getData()).jobs.find((x) => x.title === '26년 11월 작업 1');
  const before = sheet.rows.length;
  const out = data(api.deleteJob(j.row, expectOf(j)));
  assert.equal(out.jobs.some((x) => x.title === j.title), false);
  assert.equal(sheet.rows.length, before);
  api.addJob({ date: '2026-11-05', client: 'A', title: '빈 행 재사용', amount: 1 });
  assert.equal(rowOf(sheet, '빈 행 재사용'), j.row);
});
