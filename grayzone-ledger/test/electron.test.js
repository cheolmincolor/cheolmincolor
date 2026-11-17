'use strict';
// 실제 Electron 으로 앱을 띄워 봅니다(설정 화면까지). Linux 에서는 화면이 필요해 xvfb-run 으로 실행합니다:
//   xvfb-run -a node --test test/electron.test.js
// 패키징된 앱:  GZ_EXE="dist/…/GRAYZONE Ledger" node --test test/electron.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');

const needsDisplay = process.platform === 'linux' && !process.env.DISPLAY;

test('Electron 앱: 창·메뉴·격리', { skip: needsDisplay && 'DISPLAY 없음 (xvfb-run 으로 실행)' }, async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gz-electron-'));
  // GZ_EXE 를 주면 패키징된 앱(zip 안의 실행 파일)을 띄웁니다.
  const exe = process.env.GZ_EXE;
  const app = await electron.launch({
    executablePath: exe || require('electron'),
    args: [...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []), ...(exe ? [] : [path.join(__dirname, '..')])],
    env: { ...process.env, GZ_USER_DATA: userData, GZ_NO_UPDATE: '1' },
  });
  try {
    const win = await app.firstWindow();
    const errors = [];
    win.on('pageerror', (e) => errors.push(String(e)));
    await win.waitForSelector('.steps');
    assert.equal(await win.title(), 'GRAYZONE 장부');
    assert.equal(await win.locator('.step.now h2').innerText(), 'OAuth 클라이언트 파일 고르기');

    // 화면은 Node.js 에 접근할 수 없고, gz 두 가지만 씁니다.
    assert.deepEqual(await win.evaluate(() => [typeof window.require, typeof window.process, Object.keys(window.gz).sort().join()]), ['undefined', 'undefined', 'call,onMenu,onUpdate']);
    const up = (await win.evaluate(() => window.gz.call('update:status'))).ok;
    assert.deepEqual([up.status, up.current], ['idle', require('../package.json').version]);
    assert.deepEqual(await win.evaluate(() => window.gz.call('status')), { ok: { hasClient: false, signedIn: false, email: '', spreadsheetId: '', spreadsheetTitle: '' } });
    assert.match((await win.evaluate(() => window.gz.call('setSheet', ['nope']))).err, /시트 주소가 아닙니다/);
    assert.match((await win.evaluate(() => window.gz.call('rm -rf'))).err, /알 수 없는 요청/);

    // 화면 안의 링크는 앱 창에서 열리지 않습니다(기본 브라우저로 넘김).
    const before = app.windows().length;
    await win.evaluate(() => window.open('about:blank', '_blank'));
    assert.equal(app.windows().length, before);

    const menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((i) => i.label));
    assert.ok(menu.includes('파일') && menu.includes('편집') && menu.includes('보기'));
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
