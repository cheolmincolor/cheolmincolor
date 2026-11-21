'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeService, ok, expectOf } = require('./helpers');
const { serialToIso } = require('../src/core');

const sum = (jobs, f) => jobs.reduce((a, j) => a + (f(j) || 0), 0);
const find = (d, title) => d.jobs.find((j) => j.title === title);

test('읽기: 연도·월·미수금 계산', async () => {
  const { service } = makeService();
  const d = await ok(service, 'getData');
  assert.equal(d.today, '2026-11-17');
  assert.match(d.sheetUrl, /\/spreadsheets\/d\/FAKE_SPREADSHEET_ID_0123456789\/edit#gid=11$/);
  const y26 = d.jobs.filter((j) => j.year === 2026);
  assert.deepEqual([y26.length, sum(y26, (j) => j.amount), sum(y26, (j) => j.unpaid)], [32, 144700000, 76200000]);
  const carried = find(d, '브랜드 필름');
  assert.deepEqual([carried.date, carried.year, carried.month, carried.unpaid], ['2024-12-20', 2025, 0, 3000000]);
});

test('등록: 그 달의 첫 빈 행에 들어가고 행 삽입 없음', async () => {
  const { service, google } = makeService();
  const before = google.grid.length;
  const header = google.grid.findIndex((r, i) => r.v[0] === '11월' && i > 60) + 1;
  const d = await ok(service, 'addJob', [{ date: '2026-11-20', client: '새 거래처', director: '김감독', title: '신규 광고', amount: 2500000 }]);
  const row = google.rowOf('신규 광고');
  assert.equal(row, header + 3);
  assert.equal(google.grid.length, before);
  assert.deepEqual(google.cells(row).slice(0, 6), [46346, '새 거래처', '김감독', '', '신규 광고', 2500000]);
  assert.deepEqual(google.cells(row).slice(16), ['', '', '']); // Q~S 는 그대로
  assert.deepEqual([find(d, '신규 광고').row, find(d, '신규 광고').unpaid], [row, 2500000]);
});

test('등록: 빈 행이 없는 달은 마지막 행 아래에 삽입 → 월·연도 묶음이 늘어나고 서식을 물려받음', async () => {
  const { service, google } = makeService();
  const header4 = google.grid.findIndex((r) => r.v[0] === '4월') + 1; // 2025년 4월
  const yearGroup = google.groups.find((g) => g.depth === 1);
  const yearEnd = yearGroup.end;
  await ok(service, 'addJob', [{ date: '2025-03-30', client: '모노 스튜디오', title: '늦게 넣은 건', amount: 1000000 }]);
  const row = google.rowOf('늦게 넣은 건');
  assert.equal(row, header4);               // 3월 묶음의 마지막 행 바로 아래
  assert.equal(google.cells(row + 1)[0], '4월');
  assert.equal(google.depth(row), 2);       // 월 묶음 안
  assert.equal(yearGroup.end, yearEnd + 1); // 연도 묶음도 한 줄 늘어남
  assert.equal(google.grid[row - 1].f[0], 'yyyy-mm-dd');
  assert.equal(google.grid[row - 1].f.validation, 'job');
});

test('등록: 작업 1건뿐인 달(실제 장부 2026년 1월 모양)에도 들어감', async () => {
  const { service, google } = makeService();
  await ok(service, 'addJob', [{ date: '2026-01-28', client: 'A', title: '1월 추가', amount: 1 }]);
  const row = google.rowOf('1월 추가');
  assert.equal(google.cells(row - 1)[4], '26년 1월 작업 1');
  assert.equal(google.cells(row + 1)[0], '2월');
  assert.equal(google.depth(row), 2);
});

test('등록: 잘못된 입력·없는 연도는 시트를 건드리지 않음', async () => {
  const { service, google } = makeService();
  const snap = JSON.stringify(google.grid);
  for (const [job, msg] of [
    [{ date: '2030-01-05', client: 'A', title: 'B', amount: 1 }, /2030년 1월 묶음이 없습니다/],
    [{ date: '2026-11-20', client: '', title: 'B', amount: 1 }, /꼭 입력/],
    [{ date: '2026-11-20', client: 'A', title: 'B', amount: -5 }, /0 이상/],
  ]) {
    const r = await service.run('addJob', [job]);
    assert.match(r.err, msg);
  }
  assert.equal(JSON.stringify(google.grid), snap);
  assert.equal(google.batches || 0, 0);
});

test('계산서·입금: 바꾼 칸만 쓰고 미수금이 따라 바뀜', async () => {
  const { service, google } = makeService();
  let j = find(await ok(service, 'getData'), '26년 11월 작업 2');
  const untouched = JSON.stringify(google.cells(j.row).slice(0, 8));
  j = find(await ok(service, 'updateJob', [j.row, expectOf(j), { invoice: '완료' }]), j.title);
  assert.deepEqual([j.invoice, j.paid, j.unpaid], ['완료', '', 3000000]);
  j = find(await ok(service, 'updateJob', [j.row, expectOf(j), { paidAmount: 1000000, paidDate: '2026-11-25' }]), j.title);
  assert.deepEqual([j.paidAmount, j.paidDate, j.unpaid], [1000000, '2026-11-25', 2000000]);
  assert.equal(google.grid[j.row - 1].f[11], 'yyyy-mm-dd');
  j = find(await ok(service, 'updateJob', [j.row, expectOf(j), { paid: '완료', paidDate: '2026-12-01' }]), j.title);
  assert.deepEqual([j.paid, j.paidDate, j.unpaid], ['완료', '2026-12-01', 0]);
  assert.equal(serialToIso(google.cells(j.row)[11]), '2026-12-01');
  assert.equal(JSON.stringify(google.cells(j.row).slice(0, 8)), untouched);
});

test('수정: 다른 달로 옮기면 원래 행은 비고 새 달 묶음에 들어감 (한 번에 적용)', async () => {
  const { service, google } = makeService();
  const j = find(await ok(service, 'getData'), '26년 10월 작업 1');
  const before = google.batches || 0;
  const d = await ok(service, 'updateJob', [j.row, expectOf(j), { date: '2026-12-02', amount: 3500000 }]);
  assert.equal(google.batches, before + 1);
  assert.equal(google.cells(j.row).slice(0, 16).join(''), '');
  const m = find(d, j.title);
  assert.deepEqual([m.date, m.month, m.amount, m.client, m.director], ['2026-12-02', 12, 3500000, j.client, j.director]);
  assert.equal(google.cells(m.row - 1)[0], '12월');
});

test('안전장치: 시트에서 행이 밀렸으면 다른 행을 고치지 않음', async () => {
  const { service, google } = makeService();
  const j = find(await ok(service, 'getData'), '26년 11월 작업 1');
  google.apply({ insertDimension: { range: { sheetId: 11, dimension: 'ROWS', startIndex: 5, endIndex: 6 } } }); // 누군가 위쪽에 행 삽입
  const snap = JSON.stringify(google.grid);
  assert.match((await service.run('updateJob', [j.row, expectOf(j), { paid: '완료' }])).err, /그 사이에 바뀌었습니다/);
  assert.match((await service.run('deleteJob', [j.row, expectOf(j)])).err, /그 사이에 바뀌었습니다/);
  assert.equal(JSON.stringify(google.grid), snap);
});

test('삭제: 내용만 지우고 빈 행은 다음 등록 때 다시 쓰임', async () => {
  const { service, google } = makeService();
  const j = find(await ok(service, 'getData'), '26년 11월 작업 1');
  const n = google.grid.length;
  const d = await ok(service, 'deleteJob', [j.row, expectOf(j)]);
  assert.equal(find(d, j.title), undefined);
  assert.equal(google.grid.length, n);
  await ok(service, 'addJob', [{ date: '2026-11-05', client: 'A', title: '빈 행 재사용', amount: 1 }]);
  assert.equal(google.rowOf('빈 행 재사용'), j.row);
});

test('구글 오류는 알아들을 수 있는 문장으로', async () => {
  const { service, google } = makeService();
  google.failNext = { status: 403, body: { error: { code: 403, message: 'The caller does not have permission' } } };
  assert.match((await service.run('getData')).err, /권한이 없습니다/);
  google.failNext = { status: 429, body: { error: { message: 'Quota exceeded' } } };
  assert.match((await service.run('getData')).err, /잠시 후/);
  const offline = makeService();
  offline.service.o.fetch = async () => { throw new TypeError('fetch failed'); };
  offline.service.auth.fetch = offline.service.o.fetch;
  offline.service.ledger = null;
  assert.match((await offline.service.run('getData')).err, /인터넷 연결/);
});
