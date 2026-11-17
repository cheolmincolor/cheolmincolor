// 화면(Index.html)을 실제 브라우저로 열고, 가짜 시트에 붙인 Code.gs 를 서버로 써서 끝까지 눌러 봅니다.
// 실행: node --test test/   (SHOTS=폴더 를 주면 화면 캡처를 저장합니다)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { chromium } = require('playwright');
const { fixture, load, fmt } = require('./fake');

const SHOTS = process.env.SHOTS;
const page_url = 'file://' + path.join(__dirname, '..', 'Index.html');

async function open(browser, opts = {}) {
  const sheet = fixture();
  const api = load(sheet);
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SHOTS ? 2 : 1, ...opts });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.exposeFunction('__gs', (name, args) => {
    try { return { ok: api[name](...args) }; } catch (e) { return { err: e.message }; }
  });
  await page.addInitScript(() => {
    const make = (ok, fail) => new Proxy({}, {
      get(_, name) {
        if (name === 'withSuccessHandler') return (f) => make(f, fail);
        if (name === 'withFailureHandler') return (f) => make(ok, f);
        return (...args) => window.__gs(name, args).then((r) => (r.err ? fail(new Error(r.err)) : ok(r.ok)));
      },
    });
    window.google = { script: { run: make(() => {}, () => {}) } };
  });
  await page.goto(page_url);
  await page.waitForSelector('.kpis');
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
  return { sheet, page, errors, shot, close: () => ctx.close() };
}
const cells = (sheet, title) => sheet.rows.find((r) => r[4] === title);

test('화면', async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());

  await t.test('요약: 숫자가 장부와 맞고 차트·표가 그려짐', async () => {
    const { page, errors, shot, close } = await open(browser);
    const kpi = await page.locator('.kpi .value').allInnerTexts();
    assert.equal(kpi[0], '144,700,000원');                       // 2026년 매출
    assert.match(await page.locator('.kpi .sub').first().innerText(), /32건 · 평균 4,521,875원/);
    assert.equal(await page.locator('svg.chart path').count(), 23); // 2026년 11달 + 2025년 12달
    await page.locator('svg.chart .hit[data-m="8"]').click();
    assert.match(await page.locator('#readout').innerText(), /8월 · 2026년 58,000,000원 \(4건\) · 2025년 8,000,000원 · \+625\.0%/);
    assert.match(await page.locator('tfoot').innerText(), /합계\s+32\s+144,700,000/);
    await shot('1-summary');
    await page.selectOption('#year', '2025');
    assert.equal(await page.locator('.kpi .value').first().innerText(), '137,000,000원');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); // 가로 넘침 없음
    assert.deepEqual(errors, []);
    await close();
  });

  await t.test('등록 → 장부에 보이고 시트의 11월 묶음에 저장됨', async () => {
    const { sheet, page, errors, shot, close } = await open(browser);
    await page.click('#add');
    await page.fill('#fDate', '2026-11-20');
    await page.fill('#fClient', '블루도트');
    await page.locator('#fClient').dispatchEvent('change');
    assert.notEqual(await page.inputValue('#fDirector'), ''); // 같은 거래처의 최근 감독 자동 입력
    await page.fill('#fTitle', '겨울 캠페인');
    await page.locator('#fAmount').pressSequentially('4500000');
    assert.equal(await page.inputValue('#fAmount'), '4,500,000');
    await shot('2-add');
    await page.click('[data-a=save]');
    await page.waitForSelector('.toast');
    const item = page.locator('.item', { hasText: '겨울 캠페인' });
    assert.match(await item.innerText(), /11\.20[\s\S]*블루도트[\s\S]*4,500,000[\s\S]*계산서 미발행/);
    const r = cells(sheet, '겨울 캠페인');
    assert.deepEqual([fmt(r[0]), r[1], r[5], r[8], r[9]], ['2026-11-20', '블루도트', 4500000, '', '']);
    await shot('3-ledger');
    assert.deepEqual(errors, []);
    await close();
  });

  await t.test('미수금: 계산서 발행 → 되돌리기 → 일부 입금 → 전액 입금', async () => {
    const { sheet, page, errors, shot, close } = await open(browser);
    await page.click('nav [data-tab=unpaid]');
    const total = () => page.locator('.kpi .value').first().innerText();
    assert.equal(await total(), '79,200,000원');
    await shot('4-unpaid');
    const title = '26년 11월 작업 2';
    const row = () => page.locator('.item', { hasText: title });

    await row().locator('[data-act=invoice]').click();
    await page.waitForSelector('.toast');
    assert.equal(cells(sheet, title)[8], '완료');
    await page.click('.toast button'); // 되돌리기
    await page.waitForFunction(() => document.querySelector('.toast span').textContent === '되돌렸습니다');
    assert.equal(cells(sheet, title)[8], '');

    await row().locator('[data-act=pay]').click();
    await page.click('[data-mode=part]');
    await page.locator('#pAmt').pressSequentially('1000000');
    await page.fill('#pDate', '2026-11-25');
    await shot('5-pay');
    await page.click('[data-a=ok]');
    await page.waitForSelector('.scrim', { state: 'detached' });
    assert.deepEqual([cells(sheet, title)[9], cells(sheet, title)[10], fmt(cells(sheet, title)[11])], ['', 1000000, '2026-11-25']);
    assert.equal(await total(), '78,200,000원');
    assert.match(await row().innerText(), /2,000,000[\s\S]*일부 입금/);

    await row().locator('[data-act=pay]').click();
    await page.click('[data-a=ok]'); // 전액 입금, 입금일 = 오늘
    await page.waitForSelector('.scrim', { state: 'detached' });
    assert.deepEqual([cells(sheet, title)[9], fmt(cells(sheet, title)[11])], ['완료', '2026-11-17']);
    assert.equal(await row().count(), 0);
    assert.equal(await total(), '76,200,000원');
    assert.deepEqual(errors, []);
    await close();
  });

  await t.test('검색 → 자세히 → 수정 → 삭제', async () => {
    const { sheet, page, errors, close } = await open(browser);
    await page.click('nav [data-tab=ledger]');
    await page.locator('#q').pressSequentially('25년 3월');
    assert.equal(await page.locator('.item').count(), 2);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'q'); // 입력 중 초점 유지
    await page.locator('.item', { hasText: '25년 3월 작업 2' }).click();
    await page.click('[data-a=edit]');
    await page.fill('#fTitle', '고친 제목');
    await page.fill('#fAmount', '5500000');
    await page.click('[data-a=save]');
    await page.waitForSelector('.scrim', { state: 'detached' });
    const r = cells(sheet, '고친 제목');
    assert.deepEqual([fmt(r[0]), r[5], r[8], r[9]], ['2025-03-12', 5500000, '완료', '완료']); // 안 고친 칸은 그대로

    await page.fill('#q', '고친');
    await page.locator('.item').click();
    await page.click('[data-a=edit]');
    await page.click('[data-a=del]');
    assert.ok(cells(sheet, '고친 제목'));   // 한 번 눌러서는 지워지지 않음
    await page.click('[data-a=del]');
    await page.waitForSelector('.scrim', { state: 'detached' });
    assert.equal(cells(sheet, '고친 제목'), undefined);
    assert.deepEqual(errors, []);
    await close();
  });

  await t.test('서버 오류는 화면에 그대로 알림 (없는 연도 등록)', async () => {
    const { sheet, page, close } = await open(browser);
    const before = sheet.rows.length;
    await page.click('#add');
    await page.fill('#fDate', '2031-05-05');
    await page.fill('#fClient', 'A'); await page.fill('#fTitle', 'B'); await page.fill('#fAmount', '1');
    await page.click('[data-a=save]');
    await page.waitForFunction(() => document.querySelector('.sheet .err').textContent.includes('2031년 5월 묶음이 없습니다'));
    assert.equal(sheet.rows.length, before);
    assert.equal(await page.inputValue('#fTitle'), 'B'); // 입력한 내용은 남아 있음
    await close();
  });

  if (SHOTS) await t.test('캡처: PC·다크 모드', async () => {
    const { page, shot, close } = await open(browser, { viewport: { width: 1100, height: 900 }, colorScheme: 'dark' });
    await page.locator('svg.chart .hit[data-m="8"]').hover();
    await shot('6-desktop-dark');
    await close();
  });
});
