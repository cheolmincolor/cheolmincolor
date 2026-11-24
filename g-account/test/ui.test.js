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
    window.gz = { call: (n, a) => window.__gz(n, a), onMenu: (fn) => { window.__menu = fn; }, onUpdate: (fn) => { window.__update = fn; } };
    window.confirm = () => true;
  });
  await page.goto(PAGE);
  await page.waitForSelector(opts.wait || (opts.ready === false ? '.steps' : '.kpis'));
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
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(18, 18, 18)');
    assert.equal(await page.locator('.kpi .value').first().innerText(), '144,700,000원');
    assert.match(await page.locator('.kpi .sub').first().innerText(), /32건 · 평균 4,521,875원/);
    assert.equal(await page.locator('svg.chart path').count(), 23);
    await page.locator('svg.chart .hit[data-m="8"]').click();
    assert.match(await page.locator('#readout').innerText(), /8월 · 2026년 58,000,000원 \(4건\) · 2025년 8,000,000원 · \+625\.0%/);
    assert.match(await page.locator('tfoot').first().innerText(), /합계\s+32\s+144,700,000/);
    await shot('1-summary');
    // 연간 흐름판: 12달 × 5주, 칸의 합 = 연 매출, 누르면 그 주의 작업
    assert.equal(await page.locator('.flow .fc').count(), 60);
    const labels = await page.locator('.flow button.fc').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
    const totals = labels.map((l) => /(\d+)건 ([\d,]+)원/.exec(l)).reduce((a, m) => [a[0] + Number(m[1]), a[1] + Number(m[2].replace(/,/g, ''))], [0, 0]);
    assert.deepEqual(totals, [32, 144700000]);
    const cell = page.locator('.flow button.fc[aria-label^="8월"]').first();
    const n = Number(/(\d+)건/.exec(await cell.getAttribute('aria-label'))[1]);
    await cell.click();
    assert.equal(await page.locator('.flow button.fc.on').count(), 1);
    assert.equal(await page.locator('.flow ~ .list .item').count(), n);
    await page.locator('.flow').scrollIntoViewIfNeeded();
    await shot('49-flow');
    await page.locator('.flow ~ .list .item').first().click();
    await page.waitForSelector('.sheet'); await page.keyboard.press('Escape');
    await page.locator('.flow button.fc.on').click();
    assert.equal(await page.locator('.flow ~ .list').count(), 0);
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
    // 처음에는 최신순: 가장 최근에 납품한 미수금이 맨 위
    assert.equal(await page.locator('.chip.on[data-us]').innerText(), '최신순');
    const days = await page.locator('.item .day').allInnerTexts();
    assert.equal(days.length, 11);
    assert.deepEqual(days, [...days].sort().reverse());
    await shot('48-unpaid-newest');
    await page.click('[data-us=old]');
    // 월별로 접혀 있고 가장 오래된 달만 펼쳐 있음
    const heads = page.locator('.month-head');
    assert.equal(await heads.count(), 5); // 2024-12, 2026-08·09·10·11
    assert.match(await heads.first().innerText(), /2024년 12월[\s\S]*1건 · 3,000,000원 · 90일 넘음 1건/);
    assert.equal(await page.locator('.item').count(), 1);
    await shot('4-unpaid');
    await page.locator('.month-head', { hasText: '2026년 10월' }).click();
    assert.equal(await page.locator('.item').count(), 5);
    await page.click('[data-umonths=close]');
    assert.equal(await page.locator('.item').count(), 0);
    await page.click('[data-us=big]'); // 금액순은 접지 않고 전부
    assert.equal(await page.locator('.item').count(), 11);
    await page.click('[data-us=old]');
    await page.click('[data-umonths=open]');
    assert.equal(await page.locator('.item').count(), 11);
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

  await t.test('장부: 달마다 접고 펴기 (가장 최근 달만 펼친 채로 시작, 기억함)', async () => {
    const { page, errors, shot, close } = await open(browser);
    await page.click('nav [data-tab=ledger]');
    const heads = page.locator('.month-head');
    assert.equal(await heads.count(), 11); // 2026년 1~11월
    assert.match(await heads.first().innerText(), /11월[\s\S]*2건 · 4,000,000원 · 미수 4,000,000원/);
    assert.deepEqual(await page.locator('.month').evaluateAll((ms) => ms.map((m) => m.classList.contains('open'))).then((a) => a.filter(Boolean).length), 1);
    assert.equal(await page.locator('.item').count(), 2); // 11월 2건만 보임
    await shot('15-months');
    await page.locator('.month-head', { hasText: '8월' }).click();
    assert.equal(await page.locator('.item').count(), 6);
    await page.locator('.month-head', { hasText: '11월' }).click();
    assert.equal(await page.locator('.item').count(), 4);
    // 다른 탭에 갔다 와도 그대로
    await page.click('nav [data-tab=home]');
    await page.click('nav [data-tab=ledger]');
    assert.equal(await page.locator('.item').count(), 4);
    await page.click('[data-months=open]');
    assert.equal(await page.locator('.item').count(), 32);
    await page.click('[data-months=close]');
    assert.equal(await page.locator('.item').count(), 0);
    // 검색·미수 보기는 모두 펼쳐서
    await page.click('[data-lf=unpaid]');
    assert.equal(await page.locator('.month').count(), 0);
    assert.ok(await page.locator('.item').count() > 0);
    await page.click('[data-lf=all]');
    // 접힌 달에 등록하면 그 달이 펼쳐져 보임
    await page.click('#add');
    await page.fill('#fDate', '2026-03-20'); await page.fill('#fClient', 'A'); await page.fill('#fTitle', '3월 추가'); await page.fill('#fAmount', '1000');
    await page.click('[data-a=save]');
    await page.waitForSelector('.item:has-text("3월 추가")');
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
    assert.match(await page.locator('.sheet .facts').first().innerText(), /owner@example\.com[\s\S]*가짜 매출 장부/);
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

  await t.test('업데이트 창: 새 버전이면 한 번 저절로, 입력 중이면 끝난 뒤, 「나중에」·「지금 다시 시작」', async () => {
    const env = await open(browser);
    const { page, service, shot, close, errors } = env;
    let installed = null, quit = 0;
    const u = { state: { status: 'idle', current: '1.10.0', latest: '', notes: '', progress: 0, error: '' } };
    u.check = async () => { u.state = { ...u.state, status: 'none', latest: '1.10.0' }; return u.state; };
    u.install = (o) => { installed = o; u.state = { ...u.state, status: 'installing' }; return true; };
    service.o.updater = u;
    service.o.quit = () => { quit++; };
    const push = (patch) => page.evaluate((st) => window.__update(st), (u.state = { ...u.state, ...patch }));
    const dlg = page.locator('#upd .sheet');

    // 설정의 「업데이트 확인」: 같은 창에서 결과
    await page.click('#settings');
    await page.click('#updateBox [data-upd=check]');
    await page.waitForFunction(() => /최신 버전이에요/.test(document.querySelector('#upd').textContent));
    assert.match(await dlg.innerText(), /v1\.10\.0/);
    await page.keyboard.press('Escape');
    assert.equal(await dlg.count(), 0);
    assert.equal(await page.locator('.sheet').count(), 1, 'Esc 는 위의 업데이트 창만 닫음');
    await page.keyboard.press('Escape');
    // 메뉴 「업데이트 확인…」: 확인하지 못하면 「다시 확인」
    u.check = async () => { u.state = { ...u.state, status: 'error', error: '인터넷에 연결되어 있지 않습니다.' }; return u.state; };
    await page.evaluate(() => window.__menu('update'));
    await page.waitForFunction(() => /확인하지 못했어요/.test(document.querySelector('#upd').textContent));
    assert.equal(await page.locator('#upd [data-upd=check]').innerText(), '다시 확인');
    await shot('50-update-failed');
    await page.click('#upd [data-upd=later]');
    u.check = async () => u.state;

    // 입력 창이 열린 채로 새 버전을 찾음 → 닫은 뒤에 뜸
    assert.equal(await page.isVisible('#updBadge'), false);
    await page.click('#add'); await page.fill('#fTitle', '쓰는 중');
    await push({ status: 'downloading', latest: '1.11.0', notes: '- 연간 흐름판\n- 최신순', progress: 0 });
    await push({ progress: 40 });
    assert.equal(await dlg.count(), 0, '입력 중에 떠서는 안 됨');
    assert.equal(await page.isVisible('#updBadge'), true);
    await page.evaluate(() => { window.confirm = () => true; });
    await page.keyboard.press('Escape');
    await dlg.waitFor();
    const text = await dlg.innerText();
    assert.match(text, /새 버전이 있어요/);
    assert.match(text, /v1\.10\.0 → v1\.11\.0/);
    assert.match(text, /연간 흐름판/);
    assert.equal(await page.locator('#upd progress').getAttribute('value'), '40');
    assert.match(text, /40%/);
    assert.equal(await page.locator('#upd [data-upd=install]').isDisabled(), true);
    assert.equal(await page.locator('#upd h3 .upd-dot').evaluate((el) => getComputedStyle(el, '::before').color), 'rgb(91, 140, 255)');
    await shot('51-update-downloading');
    // 다 받음 → 「지금 다시 시작」 활성 + 안내
    await push({ status: 'ready', progress: 100 });
    assert.equal(await page.locator('#upd [data-upd=install]').isDisabled(), false);
    assert.match(await dlg.innerText(), /‘나중에’를 누르면 앱을 끌 때 저절로 설치돼요\./);
    await shot('52-update-ready');
    // 「나중에」: 창만 닫힘, 같은 버전으로는 다시 저절로 뜨지 않음(다시 불러와도)
    await page.click('#upd [data-upd=later]');
    assert.equal(await dlg.count(), 0);
    assert.equal(installed, null);
    await page.reload();
    await page.waitForSelector('.kpis');
    await page.evaluate((st) => window.__update(st), u.state);
    assert.equal(await dlg.count(), 0, '같은 버전으로 다시 뜸');
    assert.equal(await page.isVisible('#updBadge'), true);
    // 머리줄 표시로 다시 열기. 입력 창 위에서 열면(바뀐 내용 있음) 다시 시작은 막힘
    await page.click('#add'); await page.fill('#fTitle', '쓰는 중');
    await page.evaluate(() => window.__menu('update'));
    await dlg.waitFor();
    assert.equal(await page.locator('#upd [data-upd=install]').isDisabled(), true);
    assert.match(await dlg.innerText(), /입력을 마치면 다시 시작할 수 있어요\./);
    await page.mouse.click(5, 5); // 바깥 = 「나중에」
    assert.equal(await dlg.count(), 0);
    assert.equal(await page.inputValue('#fTitle'), '쓰는 중');
    await page.click('.sheet [data-a=close]');
    await page.click('#updBadge');
    await page.click('#upd [data-upd=install]');
    await page.waitForFunction(() => /설치하는 중/.test(document.querySelector('#upd').textContent));
    assert.deepEqual([installed, quit], [{ relaunch: true }, 1]);
    // 새 버전이 또 나오면 그 버전으로 한 번 더
    await page.click('#upd [data-upd=later]');
    await push({ status: 'ready', latest: '1.12.0' });
    await dlg.waitFor();
    assert.deepEqual(errors, []);
    await close();
  });

  await t.test('업데이트 창: 처음 설정 화면에서는 뜨지 않음', async () => {
    const { page, close } = await open(browser, { ready: false });
    await page.evaluate(() => window.__update({ status: 'ready', current: '1.10.0', latest: '1.11.0', notes: '', progress: 100, error: '' }));
    assert.equal(await page.locator('#upd .sheet').count(), 0);
    await close();
  });

  await t.test('인체공학: 큰 버튼, 가리지 않는 등록 버튼, 붙는 달 머리줄, 키보드, 탭 기억', async () => {
    const { page, errors, shot, close, google } = await open(browser);
    const h = (sel) => page.locator(sel).first().evaluate((el) => el.getBoundingClientRect().height);
    await page.click('nav [data-tab=ledger]');
    assert.ok(await h('.chip') >= 36 && await h('#refresh') >= 40 && await h('#q') >= 44);
    assert.equal(await page.locator('#refresh .lbl').isVisible(), true); // 넓은 창: 아이콘 옆 이름
    // 등록 버튼은 탭 줄 안(위쪽)에 있어 목록과 겹치지 않음
    const fab = await page.locator('#add').boundingBox();
    assert.ok(fab.y + fab.height <= 50, 'fab y=' + fab.y);
    // 긴 달을 스크롤해도 달 머리줄이 위에 붙어 있음
    await page.click('[data-months=open]');
    await page.evaluate(() => window.scrollTo(0, 500));
    const tops = await page.locator('.month-head').evaluateAll((hs) => hs.map((x) => Math.round(x.getBoundingClientRect().top)));
    assert.ok(tops.includes(114), '붙은 머리줄 없음: ' + tops.join());
    await shot('16-sticky-month');
    // ⌘F → 검색 칸, Enter → 저장
    await page.click('nav [data-tab=home]');
    await page.keyboard.press('Control+f');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'q');
    await page.click('#add');
    await page.fill('#fDate', '2026-11-21'); await page.fill('#fClient', 'A'); await page.fill('#fAmount', '5000');
    await page.fill('#fTitle', '엔터로 저장');
    await page.press('#fTitle', 'Enter');
    await page.waitForSelector('.item:has-text("엔터로 저장")');
    assert.ok(google.rowOf('엔터로 저장') > 0);
    // 긴 수정 창: 저장 버튼이 스크롤 없이 보임
    await page.setViewportSize({ width: 980, height: 560 });
    await page.locator('.item:has-text("엔터로 저장")').click();
    await page.click('[data-a=edit]');
    const save = await page.locator('[data-a=save]').boundingBox();
    assert.ok(save.y + save.height <= 560, '저장 버튼이 화면 밖: ' + save.y);
    await shot('17-sticky-save');
    await page.keyboard.press('Escape');
    // 마지막 탭 기억
    await page.click('nav [data-tab=unpaid]');
    await page.reload();
    await page.waitForSelector('.kpis');
    assert.equal(await page.locator('nav button.on').innerText().then((x) => x.replace(/\d+/, '').trim()), '미수금');
    assert.deepEqual(errors, []);
    await close();
  });

  await t.test('GRAY ZONE 디자인 규칙: 저작권 표기, 글꼴, 무채색(강조 아이콘만 색)', async () => {
    const { page, errors, shot, close } = await open(browser, { before: (g) => { g.grid[g.rowOf('26년 6월 작업 2') - 1].v[5] = ''; } });
    const ACCENTS = ['rgb(66, 211, 146)', 'rgb(242, 184, 75)', 'rgb(255, 107, 107)', 'rgb(91, 140, 255)'];
    const audit = () => page.evaluate((accents) => {
      const bad = [];
      const gray = (c) => { const m = c.match(/[\d.]+/g).map(Number); return m[0] === m[1] && m[1] === m[2]; };
      for (const el of document.querySelectorAll('body, body *')) {
        if (el.closest('svg') && el.tagName !== 'svg') { const f = getComputedStyle(el).fill; if (f !== 'none' && !gray(f)) bad.push('fill ' + f); continue; }
        const s = getComputedStyle(el);
        for (const p of ['color', 'backgroundColor', 'borderTopColor', 'outlineColor']) if (!gray(s[p])) bad.push(el.className + ' ' + p + ' ' + s[p]);
        for (const pe of ['::before', '::after']) { const c = getComputedStyle(el, pe); if (c.content !== 'none' && !gray(c.color) && !accents.includes(c.color)) bad.push(el.className + pe + ' ' + c.color); }
      }
      return bad;
    }, ACCENTS);
    for (const tab of ['home', 'ledger', 'unpaid']) {
      await page.click(`nav [data-tab=${tab}]`);
      if (tab === 'unpaid') await page.click('[data-us=old]');
      if (tab !== 'home') await page.locator('[data-months=open], [data-umonths=open]').first().click();
      assert.deepEqual(await audit(), [], tab + ' 화면에 유채색');
      // 저작권 표기: 실제 글자, 우상단 버튼 왼쪽, 늘 보임
      const c = page.locator('.copyright');
      assert.equal(await c.innerText(), '© GRAY ZONE');
      assert.deepEqual(await c.evaluate((el) => { const s = getComputedStyle(el); return [s.fontSize, s.fontWeight, s.letterSpacing, s.color]; }), ['11px', '500', '1.54px', 'rgb(138, 138, 138)']);
      const cb = await c.boundingBox(), yb = await page.locator('#year').boundingBox();
      assert.ok(cb.y >= 0 && cb.y + cb.height <= 860 && Math.abs(yb.x - (cb.x + cb.width) - 12) < 0.6, '표기 위치: ' + JSON.stringify([cb, yb.x]));
      assert.ok(Math.abs((cb.y + cb.height / 2) - (yb.y + yb.height / 2)) <= 1);
      await shot('30-rules-' + tab);
    }
    await page.evaluate(() => window.scrollTo(0, 2000)); // 스크롤해도 보임
    assert.ok((await page.locator('.copyright').boundingBox()).y >= 0);
    assert.equal(await page.locator('.copyright').evaluate((el) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + 2, r.y + r.height / 2) === el; }), true);
    // 글꼴 Pretendard 내장, 배경 #121212
    assert.match(await page.evaluate(() => getComputedStyle(document.body).fontFamily), /^Pretendard/);
    assert.ok(await page.evaluate(() => [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Pretendard' && f.status === 'loaded')));
    // 상태는 기호와 함께: 완료 ✓, 주의 ⚠
    await page.click('nav [data-tab=ledger]');
    assert.equal(await page.locator('.tag.ok').first().evaluate((el) => getComputedStyle(el, '::before').content), '"✓ "');
    assert.equal(await page.locator('.tag.bad').first().evaluate((el) => getComputedStyle(el, '::before').content), '"⚠ "');
    // 입력 창과 오류 표시도 무채색 + ✕
    await page.click('#add'); await page.click('[data-a=save]');
    assert.equal(await page.locator('.sheet .err').evaluate((el) => getComputedStyle(el, '::before').content), '"✕ "');
    assert.deepEqual(await audit(), [], '등록 창에 유채색');
    await shot('31-rules-form');
    assert.deepEqual(errors, []);
    await close();
  });

  await t.test('사용성: 주 버튼 글자, 숨김, 알림 위치, 탭·삭제·닫기 확인', async () => {
    const rgbOf = (sel, prop) => page.locator(sel).first().evaluate((el, p) => getComputedStyle(el)[p], prop);
    const { page, shot, close, errors, google } = await open(browser);
    // 1. 대화상자의 주 버튼: 글자색 ≠ 바탕색
    await page.click('#add');
    assert.equal(await rgbOf('.sheet .btn.pri', 'backgroundColor'), 'rgb(224, 224, 224)');
    assert.equal(await rgbOf('.sheet .btn.pri', 'color'), 'rgb(18, 18, 18)');
    assert.equal(await rgbOf('#fTitle', 'color'), 'rgb(232, 232, 232)');
    await page.focus('#fDate');
    await shot('40-form-primary');
    // 6. 오류 줄은 버튼 줄과 한 묶음으로 아래에, 입력하면 지워짐
    await page.click('[data-a=save]');
    assert.notEqual(await page.locator('.sheet .err').innerText(), '');
    assert.equal(await page.evaluate(() => { const e = document.querySelector('.sheet .err').getBoundingClientRect(); return [...document.querySelectorAll('.sheet input')].some((i) => { const r = i.getBoundingClientRect(); return r.bottom > e.top && r.top < e.bottom && r.height > 0; }); }), false, '오류 줄이 입력 칸을 덮음');
    await shot('41-form-error');
    await page.fill('#fTitle', '쓰다 만 작업');
    assert.equal(await page.locator('.sheet .err').innerText(), '');
    // 20. 입력한 뒤: 바깥 클릭으로 닫히지 않고, Esc·취소는 한 번 물어봄
    await page.mouse.click(5, 300);
    assert.equal(await page.locator('.sheet').count(), 1);
    await page.evaluate(() => { window.__asked = []; window.confirm = (m) => { window.__asked.push(m); return window.__answer; }; window.__answer = false; });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.sheet').count(), 1);
    await page.evaluate(() => { window.__answer = true; });
    await page.click('.sheet [data-a=close]');
    assert.equal(await page.locator('.sheet').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__asked), ['입력한 내용을 버릴까요?', '입력한 내용을 버릴까요?']);
    // 메뉴 단축키(⌘1~3, ⌘,)도 입력 중이면 물어봄
    await page.click('#add'); await page.fill('#fTitle', '쓰다 만 작업');
    await page.evaluate(() => { window.__answer = false; window.__menu('tab:ledger'); window.__menu('settings'); });
    assert.equal(await page.inputValue('#fTitle'), '쓰다 만 작업');
    assert.equal(await page.evaluate(() => window.__asked.length), 4);
    // 자동완성 목록이 있는 칸: 첫 Esc 는 목록 닫기, 창은 그대로
    await page.fill('#fClient', '오'); await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.__asked.length), 4);
    assert.equal(await page.locator('.sheet').count(), 1);
    await page.evaluate(() => { window.__answer = true; window.__menu('tab:home'); window.__asked.length = 2; });
    assert.equal(await page.locator('.sheet').count(), 0);
    // 바뀐 것이 없으면 묻지 않고 바로 닫힘
    await page.click('#add'); await page.keyboard.press('Escape');
    assert.equal(await page.locator('.sheet').count(), 0);
    await page.click('#add'); await page.mouse.click(5, 300);
    assert.equal(await page.locator('.sheet').count(), 0);
    assert.equal(await page.evaluate(() => window.__asked.length), 2);

    // 2. 전액 입금에서는 금액 칸이 숨겨지고, 미수금이 없으면 배지도 숨김
    await page.click('nav [data-tab=unpaid]');
    await page.locator('.item').first().click();
    await page.click('[data-a=pay]');
    await page.waitForSelector('#pAmtWrap', { state: 'attached' });
    assert.equal(await page.isVisible('#pAmtWrap'), false);
    await shot('42-pay-full');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('[hidden]')].every((el) => getComputedStyle(el).display === 'none')), true);

    // 3. 넓은 창의 알림은 머리줄 아래, 오류 알림은 ✕ + 굵게
    google.failNext = { status: 500, body: { error: { message: '서버 오류' } } };
    await page.click('#refresh');
    await page.waitForSelector('.toast.error');
    const top = await page.locator('.toast').evaluate((el) => el.getBoundingClientRect().top);
    const headBottom = await page.locator('nav').evaluate((el) => el.getBoundingClientRect().bottom);
    assert.ok(top >= headBottom, `알림(${top})이 머리줄(${headBottom})을 가림`);
    assert.equal(await page.locator('.toast span').evaluate((el) => getComputedStyle(el, '::before').content), '"✕ "');
    assert.equal(await page.locator('.toast span').evaluate((el) => getComputedStyle(el, '::before').color), 'rgb(255, 107, 107)');
    assert.deepEqual(await page.locator('.toast').evaluate((el) => { const s = getComputedStyle(el); return [s.backgroundColor, s.color, s.borderTopColor]; }), ['rgb(27, 27, 27)', 'rgb(232, 232, 232)', 'rgb(232, 232, 232)']);
    await shot('43-toast');

    // 10. 삭제: 첫 클릭에 무엇을 지우는지 알리고 0.6초 동안 버튼이 잠김
    await page.click('nav [data-tab=ledger]');
    const title = await page.locator('.item .t').first().innerText();
    await page.locator('.item').first().click();
    await page.click('[data-a=edit]');
    await page.click('[data-a=del]');
    assert.match(await page.locator('.confirm-note').innerText(), /^「.+」\(.+\)을 시트에서 지웁니다\. 되돌릴 수 없습니다\.$/);
    assert.equal(await page.locator('[data-a=del]').isDisabled(), true);
    await shot('44-delete-confirm');
    await page.waitForFunction(() => !document.querySelector('[data-a=del]').disabled);
    assert.equal(await page.locator('[data-a=del]').innerText(), '정말 삭제');
    assert.ok(google.grid.length > 0 && title);
    await page.evaluate(() => { window.confirm = () => true; });
    await page.click('.sheet [data-a=close]');
    assert.deepEqual(errors, []);
    await close();
  });

  await t.test('사용성: 불러오기 실패 안내는 탭을 눌러도 남음, 설정 화면 안내는 가려지지 않음', async () => {
    const { page, shot, close } = await open(browser, { wait: '.errbox', before: (g) => { g.failNext = { status: 500, body: { error: { message: '서버 오류' } } }; } });
    const text = await page.locator('.errbox').innerText();
    await shot('45-load-failed');
    await page.click('nav [data-tab=ledger]');
    await page.click('nav [data-tab=unpaid]');
    assert.equal(await page.locator('.errbox').innerText(), text);
    assert.equal(await page.locator('.empty', { hasText: '해당하는 작업이 없습니다' }).count(), 0);
    await close();

    const s = await open(browser, { ready: false });
    // 5. 설정 화면의 첫 안내가 머리줄에 가려지지 않음
    assert.equal(await s.page.evaluate(() => { const h = document.querySelector('header').getBoundingClientRect(); const f = document.querySelector('.steps').previousElementSibling || document.querySelector('.steps'); return f.getBoundingClientRect().top >= h.bottom - 1; }), true);
    await s.shot('46-setup');
    // 9. 로그인 대기 안내는 오류 줄이 아님
    await s.page.click('[data-setup=pickClient]');
    await s.page.waitForSelector('[data-setup=signIn]');
    assert.equal(await s.page.locator('#setupNote').count(), 1);
    assert.equal(await s.page.locator('#setupErr').innerText(), '');
    await s.close();
  });

  await t.test('가장 작은 창(500)·다크 모드에서 넘침 없음', async () => {
    const { page, shot, close, errors } = await open(browser, { ctx: { viewport: { width: 500, height: 700 }, colorScheme: 'dark' } });
    // 새 버전 표시가 있어도 머리줄이 넘치지 않고, 업데이트 창이 화면 안에 들어옴
    await page.evaluate(() => window.__update({ status: 'ready', current: '1.10.0', latest: '1.11.0', notes: '- 바뀐 점', progress: 100, error: '' }));
    await page.waitForSelector('#upd .sheet');
    assert.equal(await page.isVisible('#updBadge'), true);
    assert.equal(await page.locator('#upd .sheet').evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && el.scrollWidth <= el.clientWidth; }), true);
    await shot('53-update-narrow');
    await page.click('#upd [data-upd=later]');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.evaluate(() => { const h = document.querySelector('header'); const t = h.querySelector('h1'); return h.scrollWidth <= h.clientWidth && t.scrollWidth <= t.clientWidth && t.getBoundingClientRect().height < 30; }), true, '머리줄이 넘치거나 줄바꿈됨');
    await shot('7-narrow-dark');
    assert.deepEqual(errors, []);
    await close();
  });
});
