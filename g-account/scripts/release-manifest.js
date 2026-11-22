'use strict';
// 릴리스에 함께 올릴 latest.json 을 만듭니다: 버전, 바뀐 점(CHANGELOG.md), 컴퓨터별 zip 의 크기·SHA-256.
//   node scripts/release-manifest.js dist [https://github.com/…/releases/download/g-account-v1.10.0/] > latest.json
// 두 번째 인자(내려받을 주소의 앞부분)를 주면 파일마다 url 을 넣습니다. 고정 주소(ledger-updates)의 latest.json 에 필요합니다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const dir = path.resolve(process.argv[2] || 'dist');
const baseUrl = process.argv[3] || '';
const { version } = require(path.join(root, 'package.json'));

const log = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const m = log.match(new RegExp(`^## ${version.replace(/\./g, '\\.')}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
if (!m) { console.error(`CHANGELOG.md 에 ## ${version} 이 없습니다.`); process.exit(1); }

const KEYS = { 'mac-arm64': 'darwin-arm64', 'mac-x64': 'darwin-x64', 'windows-x64': 'win32-x64' };
const files = {};
for (const name of fs.readdirSync(dir)) {
  const k = name.match(new RegExp(`^G-Account-${version.replace(/\./g, '\\.')}-(mac-arm64|mac-x64|windows-x64)\\.zip$`));
  if (!k) continue;
  const buf = fs.readFileSync(path.join(dir, name));
  files[KEYS[k[1]]] = { name, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), ...(baseUrl ? { url: baseUrl + name } : {}) };
}
for (const key of Object.values(KEYS)) if (!files[key]) { console.error(`${key} 용 zip 이 ${dir} 에 없습니다.`); process.exit(1); }
process.stdout.write(JSON.stringify({ version, notes: m[1].trim(), files }, null, 2) + '\n');
