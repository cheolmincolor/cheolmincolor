'use strict';
/**
 * 설정 저장소. 설정(config.json)과 로그인 토큰(token.bin)을 앱 데이터 폴더에 둡니다.
 * 토큰은 운영체제의 보안 저장소(macOS 키체인, Windows DPAPI)로 암호화합니다.
 * 암호화를 쓸 수 없는 환경에서는 토큰을 디스크에 쓰지 않고 앱을 켜 둔 동안만 기억합니다.
 */

const fs = require('fs');
const path = require('path');

class Store {
  /**
   * @param {string} dir
   * @param {{ available: () => boolean, encrypt: (s: string) => Buffer, decrypt: (b: Buffer) => string }} cipher
   */
  constructor(dir, cipher) {
    this.dir = dir;
    this.cipher = cipher;
    this.configPath = path.join(dir, 'config.json');
    this.tokenPath = path.join(dir, 'token.bin');
    this.memoryToken = null;
    try { this.config = JSON.parse(fs.readFileSync(this.configPath, 'utf8')); } catch { this.config = {}; }
  }

  get() { return this.config; }

  set(patch) {
    this.config = { ...this.config, ...patch };
    this.write(this.configPath, JSON.stringify(this.config, null, 2));
  }

  getToken() {
    if (this.memoryToken) return this.memoryToken;
    if (!this.cipher.available()) return null;
    try { this.memoryToken = this.cipher.decrypt(fs.readFileSync(this.tokenPath)); } catch { return null; }
    return this.memoryToken;
  }

  setToken(token) {
    this.memoryToken = token || null;
    if (!token) { fs.rmSync(this.tokenPath, { force: true }); return; }
    if (this.cipher.available()) this.write(this.tokenPath, this.cipher.encrypt(token));
  }

  write(file, data) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

module.exports = { Store };
