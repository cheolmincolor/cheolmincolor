'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');

test('날짜: 시트의 일수(serial) ↔ yyyy-mm-dd', () => {
  assert.equal(core.serialToIso(46047), '2026-01-25'); // 실제 장부 「한화 위성」 행의 값
  assert.equal(core.serialToIso(44183), '2020-12-18'); // 실제 장부 「원어공 유연석편」 행의 값
  assert.equal(core.isoToSerial('2026-11-20'), 46346);
  assert.equal(core.isIsoDate('2026-02-31'), false);
  assert.equal(core.isIsoDate('2024-02-29'), true);
  assert.equal(core.localToday(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('행 종류와 묶음 읽기 (값 목록 뒤에서 잘린 빈 행은 마지막 묶음에 붙음)', () => {
  const v = [['납품일'], ['2026년'], ['1월'], [46047, '플랜잇', '', '', '한화 위성', 2000000], [], ['2월']];
  const p = core.parseSheet(v, 9);
  assert.deepEqual(p.blocks.map((b) => [b.year, b.month, b.first, b.last]), [[2026, 1, 4, 5], [2026, 2, 7, 9]]);
  assert.deepEqual([p.kinds[5], p.kinds[8]], ['empty', 'empty']);
  assert.deepEqual(core.planSlot(p, '2026-01-30'), { row: 5, insert: false });
  assert.deepEqual(core.planSlot(p, '2026-02-01'), { row: 7, insert: false });
});

test('미수금 규칙은 시트 S열 수식과 같음', () => {
  const p = core.parseSheet([['h'], ['2026년'], ['6월'],
    [46193, 'A', '', '', '지급 완료', 4000000, '', '', '완료', '완료'],
    [46193, 'B', '', '', '일부 입금', 3000000, '', '', '완료', '', 1000000],
    [46193, 'C', '', '', '과입금', 1000000, '', '', '', '', 1500000],
    [46193, 'D', '', '', '금액 없음', ''],
    [46193, 'E', '', '', '서비스', 0, '서비스'],
  ]);
  assert.deepEqual(p.jobs.map((j) => j.unpaid), [0, 2000000, 0, 0, 0]);
});

test('입력 검사', () => {
  assert.throws(() => core.cleanJob({ date: '2026-11-20', client: '', title: 'B' }, true), /꼭 입력/);
  assert.throws(() => core.cleanJob({ date: '2026/11/20', client: 'A', title: 'B' }, true), /날짜 형식/);
  assert.throws(() => core.cleanJob({ amount: -1 }, false), /0 이상/);
  assert.throws(() => core.cleanJob({ paid: '끝' }, false), /선택할 수 없는/);
  assert.deepEqual(core.cleanJob({ amount: '2500000', note: '  메모 ' }, false), { amount: 2500000, note: '메모' });
});

test('쓰기 요청: 글자는 stringValue 로 보내 수식으로 해석되지 않고, 날짜 칸에 날짜 서식을 검', () => {
  const reqs = core.writeRowRequests(11, 10, { date: '2026-11-20', client: 'A', title: '=SUM(A1)', amount: 5 });
  const cells = reqs[0].updateCells.rows[0].values;
  assert.deepEqual(cells[0], { userEnteredValue: { numberValue: 46346 } });
  assert.deepEqual(cells[4], { userEnteredValue: { stringValue: '=SUM(A1)' } });
  assert.deepEqual(cells[3], {}); // 빠진 항목은 비움
  assert.equal(cells.length, 16);
  assert.equal(reqs.length, 2);
  assert.equal(reqs[1].repeatCell.range.startColumnIndex, 0);
});
