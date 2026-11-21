'use strict';
// build/icon.svg 로 앱 아이콘(icon.png · icon.icns · icon.ico)을 만듭니다. 실행: npm run icons
// SVG 를 그리는 데 Playwright 의 Chromium 을 씁니다.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const dir = path.join(__dirname, '..', 'build');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');

async function render(browser, size) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  const png = await page.screenshot({ omitBackground: true });
  await page.close();
  return png;
}

// ICNS: 'icns' 머리 + (종류 4바이트, 길이 4바이트, PNG) 묶음
function icns(entries) {
  const parts = entries.map(([type, png]) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 'ascii');
    h.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([h, png]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(8 + parts.reduce((a, b) => a + b.length, 0), 4);
  return Buffer.concat([head, ...parts]);
}

// ICO: 머리 6바이트 + 항목 16바이트씩 + PNG 들
function ico(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dirs = entries.map(([size, png]) => {
    const d = Buffer.alloc(16);
    d.writeUInt8(size >= 256 ? 0 : size, 0); d.writeUInt8(size >= 256 ? 0 : size, 1);
    d.writeUInt16LE(1, 4); d.writeUInt16LE(32, 6);
    d.writeUInt32LE(png.length, 8); d.writeUInt32LE(offset, 12);
    offset += png.length;
    return d;
  });
  return Buffer.concat([head, ...dirs, ...entries.map((e) => e[1])]);
}

(async () => {
  const browser = await chromium.launch();
  const png = {};
  for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) png[s] = await render(browser, s);
  await browser.close();
  fs.writeFileSync(path.join(dir, 'icon.png'), png[512]);
  fs.writeFileSync(path.join(dir, 'icon.icns'), icns([['ic07', png[128]], ['ic08', png[256]], ['ic09', png[512]], ['ic10', png[1024]]]));
  fs.writeFileSync(path.join(dir, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((s) => [s, png[s]])));
  console.log('build/icon.png, icon.icns, icon.ico');
})();
