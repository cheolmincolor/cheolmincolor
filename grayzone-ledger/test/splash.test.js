'use strict';
// GRAYZONE 런치 화면(app/splash.html)을 실제 브라우저로 열어 규격의 수치와 대조합니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const SHOTS = process.env.SHOTS;
const PAGE = 'file://' + path.join(__dirname, '..', 'app', 'splash.html');
const GRAYS = ['#000000', '#1B1B1B', '#303030', '#474747', '#5E5E5E', '#777777', '#919191', '#ABABAB', '#C6C6C6', '#E0E0E0', '#FFFFFF'];
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };

test('런치 화면: 규격 대조', async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(PAGE);
  await page.evaluate(() => document.fonts.ready);
  const css = (sel, props) => page.locator(sel).first().evaluate((el, ps) => { const c = getComputedStyle(el); return ps.map((p) => c[p]); }, props);
  const box = (sel) => page.locator(sel).first().boundingBox();
  const set = (s) => page.evaluate((x) => window.__render(x), s);
  const shot = async (n) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, n + '.png') }); };

  await set({ version: '9.8.7', filled: 0, text: '설정을 읽는 중…' });

  // 창: 배경, 안쪽 여백(위 36, 좌우 40, 아래 32), 세 구역 균등 배치
  assert.deepEqual(await css('body', ['backgroundColor', 'paddingTop', 'paddingLeft', 'paddingRight', 'paddingBottom', 'justifyContent']),
    ['rgb(18, 18, 18)', '36px', '40px', '40px', '32px', 'space-between']);
  const top = await box('.top'), mid = await box('.mid'), wedge = await box('.wedge');
  assert.deepEqual([top.x, top.y, top.width], [40, 36, 560]);
  assert.equal(Math.round(wedge.y + wedge.height), 400 - 32);
  assert.ok(Math.abs((mid.y - (top.y + top.height)) - (wedge.y - (mid.y + mid.height))) <= 1, '세 구역 간격이 같지 않음');

  // 상단 줄
  assert.deepEqual(await css('.top', ['fontSize', 'letterSpacing', 'color']), ['11px', '1.54px', rgb('#8A8A8A')]);
  assert.deepEqual(await page.locator('.top span').allInnerTexts(), ['DIGITAL INTERMEDIATE LAB', '9.8.7']);

  // 가운데 블록
  assert.deepEqual(await css('.mid', ['gap', 'alignItems']), ['24px', 'center']);
  const icon = await box('#icon');
  assert.deepEqual([icon.width, icon.height], [72, 72]);
  assert.deepEqual(await css('.gz', ['fontSize', 'fontWeight', 'letterSpacing', 'color']), ['52px', '600', '8.32px', rgb('#E8E8E8')]);
  assert.deepEqual(await css('.app', ['fontSize', 'fontWeight', 'letterSpacing', 'color']), ['18px', '400', '0.72px', rgb('#9A9A9A')]);
  assert.equal((await css('.mid .txt', ['gap']))[0], '10px');
  assert.deepEqual([await page.locator('.gz').innerText(), await page.locator('.app').innerText()], ['GRAY ZONE', 'G-Account']);
  assert.ok(await page.evaluate(() => document.fonts.check('600 52px Inter') && [...document.fonts].filter((f) => f.status === 'loaded').length >= 2), 'Inter 글꼴이 내장되지 않음');

  // 아이콘 = 실제 앱 아이콘(build/icon.png). Dock 아이콘(icon.icns)의 512px 그림과 같은 파일입니다.
  const png = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.png'));
  assert.match(await page.locator('#icon').getAttribute('src'), /build\/icon\.png$/);
  assert.ok(await page.evaluate(() => document.getElementById('icon').naturalWidth === 512));
  const icns = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.icns'));
  let inIcns = null;
  for (let o = 8; o < icns.length;) { const type = icns.toString('ascii', o, o + 4), len = icns.readUInt32BE(o + 4); if (type === 'ic09') inIcns = icns.subarray(o + 8, o + len); o += len; }
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  assert.equal(sha(inIcns), sha(png), '런치 화면 아이콘과 Dock 아이콘(icns 512px)이 다름');

  // 웨지: 11칸, 간격 3, 높이 12, 같은 너비
  const cells = page.locator('.cell');
  assert.equal(await cells.count(), 11);
  const boxes = await cells.evaluateAll((cs) => cs.map((c) => { const r = c.getBoundingClientRect(); return [r.x, r.width, r.height]; }));
  assert.ok(boxes.every((b) => b[2] === 12 && Math.abs(b[1] - boxes[0][1]) < 0.02)) // 브라우저 배치 단위(1/64px) 오차;
  assert.ok(boxes.slice(1).every((b, i) => Math.abs(b[0] - (boxes[i][0] + boxes[i][1]) - 3) < 0.02));
  assert.ok(Math.abs(boxes[0][0] - 40) < 0.02 && Math.abs(boxes[10][0] + boxes[10][1] - 600) < 0.02);
  const look = () => cells.evaluateAll((cs) => cs.map((c) => { const s = getComputedStyle(c); return [s.backgroundColor, s.borderTopColor, s.borderTopWidth]; }));

  // 0%: 빈 칸은 1pt #333333 테두리만, 존 0 은 #2A2A2A
  let v = await look();
  assert.ok(v.every((x) => x[0] === 'rgba(0, 0, 0, 0)' && x[2] === '1px'));
  assert.equal(v[0][1], rgb('#2A2A2A'));
  assert.ok(v.slice(1).every((x) => x[1] === rgb('#333333')));
  assert.deepEqual(await page.locator('.foot span').allInnerTexts(), ['0', '설정을 읽는 중…', 'X']);
  assert.deepEqual(await css('.foot', ['fontSize', 'color']), ['11px', rgb('#8A8A8A')]);
  await shot('20-launch-0');

  // 중간: 왼쪽 6칸이 제 회색 값으로, 나머지는 빈 칸. 존 0 은 채워져도 #2A2A2A 외곽선
  await set({ version: '9.8.7', filled: 6, text: '새 버전 9.9.0을 받는 중… 62%' });
  v = await look();
  assert.deepEqual(v.slice(0, 6).map((x) => x[0]), GRAYS.slice(0, 6).map(rgb));
  assert.equal(v[0][1], rgb('#2A2A2A'));
  assert.ok(v.slice(6).every((x) => x[0] === 'rgba(0, 0, 0, 0)' && x[1] === rgb('#333333')));
  await shot('21-launch-mid');

  // 100%: 11칸 모두
  await set({ version: '9.8.7', filled: 11, text: '준비 완료' });
  assert.deepEqual((await look()).map((x) => x[0]), GRAYS.map(rgb));
  await shot('22-launch-100');

  // 오류: 무엇이 실패했는지 한 줄
  await set({ version: '9.8.7', filled: 8, text: '장부 창 준비 실패: ERR_FILE_NOT_FOUND' });
  assert.equal(await page.locator('#msg').innerText(), '장부 창 준비 실패: ERR_FILE_NOT_FOUND');

  // 규격에 없는 요소가 없음: 버튼·진행 막대·스피너·유채색
  assert.equal(await page.locator('button, progress, a, input').count(), 0);
  const colors = await page.evaluate(() => [...document.querySelectorAll('body, body *')].flatMap((el) => { const s = getComputedStyle(el); return [s.color, s.backgroundColor, s.borderTopColor]; }));
  assert.ok(colors.every((c) => { const m = c.match(/\d+/g).map(Number); return m[0] === m[1] && m[1] === m[2]; }), '유채색이 있음');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > 640 || document.documentElement.scrollHeight > 400), false);
  // 이 앱의 존 번호는 아직 정해지지 않아 존 표시는 없음
  assert.equal(await page.locator('.cell.mine').count(), 0);
  assert.deepEqual(errors, []);
});
