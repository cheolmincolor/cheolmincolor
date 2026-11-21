'use strict';
// 업데이트 확인 창(app/splash.html)을 실제 브라우저로 열어 상태별 문구와 고지를 확인합니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { chromium } = require('playwright');

const SHOTS = process.env.SHOTS;
const PAGE = 'file://' + path.join(__dirname, '..', 'app', 'splash.html');

test('업데이트 확인 창', async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 460, height: 440 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    window.__skips = 0;
    window.gzSplash = { onState: (fn) => { window.__state = fn; }, skip: () => { window.__skips++; } };
  });
  await page.goto(PAGE);
  const set = (s) => page.evaluate((x) => window.__state(x), s);
  const msg = () => page.locator('#msg').innerText();
  const shot = async (n) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, n + '.png') }); };

  // 고지: 로고, 앱 이름, 그레이존 매출 장부 전용 앱이라는 안내
  assert.equal(await page.title(), 'G-Account');
  assert.equal(await page.locator('h1').innerText(), 'G-Account');
  assert.ok(await page.evaluate(() => document.querySelector('.logo').naturalWidth > 0), '로고가 보이지 않음');
  assert.match(await page.locator('.notice').innerText(), /G-Account는 그레이존\(GRAYZONE\)의 매출 장부 전용 앱/);

  await set({ status: 'checking', current: '1.2.0' });
  assert.equal(await page.locator('#ver').innerText(), '버전 1.2.0');
  assert.equal(await msg(), '업데이트를 확인하고 있습니다…');
  assert.equal(await page.locator('#skip').innerText(), '업데이트 건너뛰고 열기');
  await shot('11-splash-checking');

  await set({ status: 'downloading', current: '1.2.0', latest: '1.3.0', progress: 42 });
  assert.equal(await msg(), '새 버전 1.3.0을 받는 중… 42%');
  assert.equal(await page.evaluate(() => document.getElementById('fill').style.width), '42%');
  await shot('12-splash-downloading');
  await page.click('#skip');
  assert.equal(await page.evaluate(() => window.__skips), 1);

  await set({ status: 'ready', stage: 'install', current: '1.2.0', latest: '1.3.0', progress: 100 });
  assert.equal(await msg(), '새 버전 1.3.0을 설치하고 다시 시작합니다…');
  assert.equal(await page.locator('#skip').count(), 0); // 설치 중에는 버튼 없음
  await shot('13-splash-install');

  await set({ status: 'none', current: '1.2.0', latest: '1.2.0' });
  assert.equal(await msg(), '최신 버전입니다. 장부를 엽니다…');
  await shot('14-splash-latest');

  await set({ status: 'error', current: '1.2.0', error: '인터넷에 연결하지 못했습니다.' });
  assert.match(await msg(), /확인하지 못했습니다\. 장부를 엽니다/);

  await set({ status: 'error', stage: 'install-error', current: '1.2.0', error: '「/Applications」에 쓸 권한이 없어 바꿔 넣을 수 없습니다.' });
  assert.match(await msg(), /쓸 권한이 없어/);
  assert.equal(await page.locator('#skip').innerText(), '장부 열기');
  assert.deepEqual(errors, []);
});
