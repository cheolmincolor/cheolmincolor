// Writes and signs the update manifest for a release.
//
//   node make-release.mjs <dist-folder> <base-url> [notes-file]
//
// Reads the zips package.sh made in <dist-folder>, and writes
//   latest.json      version, notes and, per Mac type, url + sha256 + size
//   latest.json.sig  Ed25519 signature of latest.json (base64)
//
// The private key comes from GCOPY_UPDATE_KEY (the PEM text) or from the
// file named by GCOPY_UPDATE_KEY_FILE. It must match update-key.pem, the
// public key built into the app; the script refuses to sign otherwise.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [dist, baseUrl, notesFile] = process.argv.slice(2);
if (!dist || !baseUrl) {
  console.error('usage: node make-release.mjs <dist-folder> <base-url> [notes-file]');
  process.exit(2);
}
const here = path.dirname(new URL(import.meta.url).pathname);
const { version } = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));

const pem = process.env.GCOPY_UPDATE_KEY || (process.env.GCOPY_UPDATE_KEY_FILE && fs.readFileSync(process.env.GCOPY_UPDATE_KEY_FILE, 'utf8'));
if (!pem) { console.error('Set GCOPY_UPDATE_KEY or GCOPY_UPDATE_KEY_FILE to the signing key.'); process.exit(2); }
const privateKey = crypto.createPrivateKey(pem);
const publicKey = crypto.createPublicKey(fs.readFileSync(path.join(here, 'update-key.pem')));
const probe = Buffer.from('g-copy key check');
if (!crypto.verify(null, probe, publicKey, crypto.sign(null, probe, privateKey))) {
  console.error('This signing key does not match update-key.pem — the app would reject the update.');
  process.exit(1);
}

// zips are named G-Copy-<version>-mac-arm64.zip, …-mac-x64.zip, …-linux-x64.zip
const keyFor = { 'mac-arm64': 'darwin-arm64', 'mac-x64': 'darwin-x64', 'linux-x64': 'linux-x64' };
const files = {};
for (const name of fs.readdirSync(dist)) {
  const m = name.match(/^G-Copy-(.+)-(mac-arm64|mac-x64|linux-x64)\.zip$/);
  if (!m) continue;
  if (m[1] !== version) { console.error(`${name} is not version ${version}`); process.exit(1); }
  const data = fs.readFileSync(path.join(dist, name));
  files[keyFor[m[2]]] = {
    url: baseUrl.replace(/\/+$/, '') + '/' + encodeURIComponent(name),
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    size: data.length,
  };
}
if (!Object.keys(files).length) { console.error('No G-Copy zips found in ' + dist); process.exit(1); }

const manifest = {
  version,
  date: new Date().toISOString(),
  notes: notesFile ? fs.readFileSync(notesFile, 'utf8').trim() : '',
  files,
};
const text = JSON.stringify(manifest, null, 2) + '\n';
fs.writeFileSync(path.join(dist, 'latest.json'), text);
fs.writeFileSync(path.join(dist, 'latest.json.sig'), crypto.sign(null, Buffer.from(text), privateKey).toString('base64') + '\n');
console.log(`latest.json for ${version}: ${Object.keys(files).join(', ')}`);
