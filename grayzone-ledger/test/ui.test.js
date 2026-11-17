'use strict';
// 화면(app/index.html)을 실제 브라우저(Chromium)로 열고, 가짜 구글에 연결된 Service 를 앱 본체 대신 붙여 끝까지 눌러 봅니다.
// SHOTS=폴더 를 주면 화면 캡처를 저장합니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { chromium } = require('playwright');
const { makeService } = require('./helpers');
const { serialToIso } = require('../src/core');
const { ID } = require('./fake-google');

const SHOTS = process.env.SHOTS;
const PAGE = 'file://' + path.join(__dirname, '..', 'app', 'index.html');

async function open(browser, opts = {}) {
  const env = makeService({ ready: opts.ready !== false });
  if (opts.before) opts.before(env.google);
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 980, height: 860 }, colorScheme: 'light', deviceScaleFactor: SHOTS ? 2 : 1, ...(opts.ctx || {}) });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.exposeFunction('__gz', (name, args) => env.service.run(name, args));
  await page.addInitScript(() => {
    window.gz = { call: (n, a) => window.__gz(n, a), onMenu: (fn) => { window.__menu = fn; } };
    window.confirm = () => true;
  });
  await page.goto(PAGE);
  await page.waitForSelector(opts.ready === false ? '.steps' : '.kpis');
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
  return { ...env, page, errors, shot, close: () => ctx.close() };
}
const done = (page) => page.waitForSelector('.scrim', { state: 'detached' });

test('화면', async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());

  await t.test('처음 설정 화면 → 로그인 → 시트 연결 → 요약', async () => {
    const { page, errors, shot, close, store } = await open(browser, { ready: false });
    assert.equal(await page.isVisible('nav'), false);
    await shot('0-setup');
    await page.click('[data-setup=pickClient]');
    await page.waitForSelector('[data-setup=signIn]');
    await page.click('[data-setup=signIn]');
    await page.waitForSelector('#sheetUrl');
    assert.match(await page.locator('.step.done').nth(1).innerText(), /owner@example.com/);
    await page.fill('#sheetUrl', 'https://example.com/nope');
    await page.click('[data-setup=setSheet]');
    await page.waitForFunction(() => /시트 주소가 아닙니다/.test(document.querySelector('#setupErr').textContent));
    await page.fill('#sheetUrl', `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=11`);
    await page.press('#sheetUrl', 'Enter');
    await page.waitForSelector('.kpis');
    assert.equal(await page.isVisible('nav'), true);
    assert.equal(store.get().spreadsheetId, ID);
    assert.deepEqual(errors, []);
    await close();
  });

  await t.test('요약: 숫자·차트·표', async () => {
    const { page, errors, shot, close } = await open(browser);
    // 운영체제가 밝은 모드여도 어두운 바탕
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(13, 13, 13)');
    assert.equal(await page.locator('.kpi .value').first().innerText(), '144,700,000원');
    assert.match(await page.locator('.kpi .sub').first().innerText(), /32건 · 평균 4,521,875원/);
    assert.equal(await page.locator('svg.chart path').count(), 23);
    await page.locator('svg.chart .hit[data-m="8"]').click();
    assert.match(await page.locator('#readout').innerText(), /8월 · 2026년 58,000,000원 \(4건\) · 2025년 8,000,000원 · \+625\.0%/);
    assert.match(await page.locator('tfoot').first().innerText(), /합계\s+32\s+144,700,000/);
    await shot('1-summary');
    await page.selectOption('#year', '2025');
    assert.equal(await page.locator('.kpi .value').first().innerText(), '137,000,000원');
    assert.deepEqual(errors, []);
    await close();
  });

  await t.test('등록(메뉴 ⌘N) → 장부에 보이고 시트에 저장', async () => {
    const { page, errors, shot, close, google } = await open(browser);
    await page.evaluate(() => window.__menu('add'));
    await page.fill('#fDate', '2026-11-20');
    await page.fill('#fClient', '블루도트');
    await page.locator('#fClient').dispatchEvent('change');
    assert.notEqual(await page.inputValue('#fDirector'), '');
    await page.fill('#fTitle', '겨울 캠페인');
    await page.locator('#fAmount').pressSequentially('4500000');
    assert.equal(await page.inputValue('#fAmount'), '4,500,000');
    await shot('2-add');
    await page.click('[data-a=save]');
    await page.waitForSelector('.toast');
    assert.match(await page.locator('.item', { hasText: '겨울 캠페인' }).innerText(), /11\.20[\s\S]*블루도트[\s\S]*4,500,000[\s\S]*계산서 미발행/);
    const r = google.cells(google.rowOf('겨울 캠페인'));
    assert.deepEqual([serialToIso(r[0]), r[1], r[5], r[8], r[9]], ['2026-11-20', '블루도트', 4500000, '', '']);
    await shot('3-ledger');
    assert.deepEqual(errors, []);
    await close();
  });

  await t.test('미수금: 계산서 발행 → 되돌리기 → 일부 입금 → 전액 입금', async () => {
    const { page, errors, shot, close, google } = await open(browser);
    await page.evaluate(() => window.__menu('tab:unpaid'));
    const total = () => page.locator('.kpi .value').first().innerText();
    assert.equal(await total(), '79,200,000원');
    await shot('4-unpaid');
    const title = '26년 11월 작업 2';
    const row = () => page.locator('.item', { hasText: title });
    const cells = () => google.cells(google.rowOf(title));

    await row().locator('[data-act=invoice]').click();
    await page.waitForSelector('.toast');
    assert.equal(cells()[8], '완료');
    await page.click('.toast button');
    await page.waitForFunction(() => document.querySelector('.toast span').textContent === '되돌렸습니다');
    assert.equal(cells()[8], '');

    await row().locator('[data-act=pay]').click();
    await page.click('[data-mode=part]');
    await page.locator('#pAmt').pressSequentially('1000000');
    await page.fill('#pDate', '2026-11-25');
    await shot('5-pay');
    await page.click('[data-a=ok]');
    await done(page);
    assert.deepEqual([cells()[9], cells()[10], serialToIso(cells()[11])], ['', 1000000, '2026-11-25']);
    assert.equal(await total(), '78,200,000원');

    await row().locator('[data-act=pay]').click();
    await page.click('[data-a=ok]');
    await done(page);
    assert.deepEqual([cells()[9], serialToIso(cells()[11])], ['완료', '2026-11-17']);
    assert.equal(await row().count(), 0);
    assert.equal(await total(), '76,200,000원');
    assert.deepEqual(errors, []);
    await close();
  });

  await t.test('검색 → 수정 → 삭제', async () => {
    const { page, errors, close, google } = await open(browser);
    await page.click('nav [data-tab=ledger]');
    await page.locator('#q').pressSequentially('25년 3월');
    assert.equal(await page.locator('.item').count(), 2);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'q');
    await page.locator('.item', { hasText: '25년 3월 작업 2' }).click();
    await page.click('[data-a=edit]');
    await page.fill('#fTitle', '고친 제목');
    await page.fill('#fAmount', '5500000');
    await page.click('[data-a=save]');
    await done(page);
    const r = google.cells(google.rowOf('고친 제목'));
    assert.deepEqual([serialToIso(r[0]), r[5], r[8], r[9]], ['2025-03-12', 5500000, '완료', '완료']);
    await page.fill('#q', '고친');
    await page.locator('.item').click();
    await page.click('[data-a=edit]');
    await page.click('[data-a=del]');
    assert.ok(google.rowOf('고친 제목') > 0);
    await page.click('[data-a=del]');
    await done(page);
    assert.equal(google.rowOf('고친 제목'), 0);
    assert.deepEqual(errors, []);
    await close();
  });

  await t.test('로그인이 취소된 상태에서 저장하면 설정 화면으로', async () => {
    const { page, close, google } = await open(browser);
    google.refreshTokens.clear();
    google.expireTokens();
    await page.click('#add');
    await page.fill('#fDate', '2026-11-20');
    await page.fill('#fClient', 'A'); await page.fill('#fTitle', 'B'); await page.fill('#fAmount', '1');
    await page.click('[data-a=save]');
    await page.waitForSelector('.steps');
    assert.match(await page.locator('#setupErr').innerText(), /다시 로그인/);
    assert.equal(await page.locator('.step.now h2').innerText(), '구글 로그인');
    await close();
  });

  await t.test('설정 창: 계정·시트 표시', async () => {
    const { page, close, shot } = await open(browser);
    await page.click('#settings');
    await page.waitForSelector('.sheet .facts');
    assert.match(await page.locator('.sheet .facts').innerText(), /owner@example\.com[\s\S]*가짜 매출 장부/);
    await shot('6-settings');
    await close();
  });

  await t.test('부가세: 요약의 분기 표와 등록 창의 안내', async () => {
    const { page, errors, shot, close } = await open(browser);
    const rows = await page.locator('table.vat tbody tr').allInnerTexts();
    assert.match(rows[0], /1분기[\s\S]*23,000,000[\s\S]*2,300,000[\s\S]*25,300,000/);
    assert.match(rows[2], /1기 합계[\s\S]*46,000,000[\s\S]*4,600,000[\s\S]*50,600,000/);
    assert.match(rows[4], /4분기[\s\S]*19,000,000[\s\S]*1,900,000[\s\S]*20,900,000[\s\S]*6건[\s\S]*19,000,000/);
    assert.match(await page.locator('table.vat tfoot').innerText(), /연간[\s\S]*144,700,000[\s\S]*14,470,000[\s\S]*159,170,000/);
    await page.locator('table.vat').scrollIntoViewIfNeeded();
    await shot('8-vat');
    await page.click('#add');
    await page.locator('#fAmount').pressSequentially('3000000');
    assert.equal(await page.locator('#vatHint').innerText(), '공급가 3,000,000 · 부가세 300,000 · 합계 3,300,000');
    await page.keyboard.press('Escape');
    // 미수금 화면에 부가세 포함 금액
    await page.click('nav [data-tab=unpaid]');
    assert.match(await page.locator('.kpi .sub').first().innerText(), /11건 · 부가세 포함 87,120,000원/);
    assert.deepEqual(errors, []);
    await close();
  });

  await t.test('설정에서 부가세 기준을 바꾸면 시트와 화면이 함께 바뀜', async () => {
    const { page, close, google } = await open(browser);
    await page.click('#settings');
    await page.selectOption('#vatBasis', '부가세 포함');
    await page.waitForSelector('.toast');
    assert.equal(google.vatBasis, '부가세 포함');
    assert.match(await page.locator('table.vat tfoot').innerText(), /연간[\s\S]*131,545,456[\s\S]*13,154,544[\s\S]*144,700,000/);
    await close();
  });

  await t.test('장부 점검: 요약 알림 → 목록 → 자세히 → 문제없음', async () => {
    const { page, errors, shot, close, google } = await open(browser, { before: (g) => { g.grid[g.rowOf('26년 6월 작업 2') - 1].v[5] = ''; } });
    await page.waitForSelector('.banner');
    assert.match(await page.locator('.banner').innerText(), /장부 점검[\s\S]*1건/);
    await page.click('.banner');
    assert.equal(await page.locator('.chip.on').innerText(), '점검 1');
    assert.match(await page.locator('#ledgerList .group').innerText(), /견적금액이 비어 있음/);
    await shot('9-checks');
    await page.locator('#ledgerList .item').click();
    assert.match(await page.locator('.issue').innerText(), /견적금액이 비어 있음/);
    await page.click('.issue button');
    await page.waitForFunction(() => !document.querySelector('.issue'));
    await page.keyboard.press('Escape');
    assert.match(await page.locator('#ledgerList').innerText(), /확인할 항목이 없습니다[\s\S]*숨긴 항목 1건/);
    assert.equal(await page.isVisible('.banner'), false);
    assert.equal(google.grid[google.rowOf('26년 6월 작업 2') - 1].v[5], ''); // 시트는 그대로
    assert.deepEqual(errors, []);
    await close();
  });

  await t.test('설정의 「다음 해 묶음 지금 만들기」', async () => {
    const { page, close, google } = await open(browser);
    await page.click('#settings');
    await page.click('[data-a=nextYear]');
    await page.waitForFunction(() => /2028년 묶음을 만들었습니다/.test((document.querySelector('.toast span') || {}).textContent || ''));
    assert.ok(google.grid.some((r) => r.v[0] === '2028년'));
    await page.click('#settings');
    assert.match(await page.locator('[data-a=nextYear]').innerText(), /2029년/);
    await close();
  });

  await t.test('좁은 창·다크 모드에서 넘침 없음', async () => {
    const { page, shot, close, errors } = await open(browser, { ctx: { viewport: { width: 390, height: 844 }, colorScheme: 'dark' } });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await shot('7-narrow-dark');
    assert.deepEqual(errors, []);
    await close();
  });
});
