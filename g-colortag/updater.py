"""G-ColorTag 자동 업데이트.

GitHub 릴리스(태그 colortag-v*)에서 새 버전을 찾아 뒤에서 받아 두고,
체크섬을 확인한 뒤 앱을 끌 때(또는 '지금 다시 시작'을 누를 때) 교체한다.

릴리스에 올리는 파일 (build_release.sh 가 만듦)
  colortag-latest.json          {"version", "notes", "files": {"arm64": {...}, "x64": {...}}}
  G-ColorTag-<ver>-arm64.tar.gz  .app 묶음 (권한·링크 보존)
  G-ColorTag-<ver>-x64.tar.gz
"""
import hashlib
import json
import os
import platform
import plistlib
import shutil
import subprocess
import sys
import threading
import time

REPO = "cheolmincolor/cheolmincolor"
TAG_PREFIX = "colortag-v"
MANIFEST = "colortag-latest.json"
API = os.environ.get("GCT_UPDATE_API", f"https://api.github.com/repos/{REPO}/releases?per_page=30")
FIRST_CHECK, INTERVAL = 8, 6 * 3600


def vtuple(v):
    try:
        return tuple(int(x) for x in str(v).strip().lstrip("v").split("."))
    except ValueError:
        return ()


def arch():
    return "arm64" if platform.machine() in ("arm64", "aarch64") else "x64"


def curl(url, out=None):
    """시스템 curl 사용 (맥 인증서·프록시 설정을 그대로 씀)."""
    cmd = ["curl", "-fsSL", "--retry", "2", "--connect-timeout", "15",
           "-H", "User-Agent: G-ColorTag", "-H", "Accept: application/vnd.github+json, */*", url]
    if out:
        return subprocess.Popen(cmd[:1] + ["-o", out] + cmd[1:], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    r = subprocess.run(cmd, capture_output=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError("인터넷 연결을 확인해 주세요")
    return r.stdout


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class Updater:
    def __init__(self, version, resources_dir, log=print):
        self.version, self.log = version, log
        app = os.path.abspath(os.path.join(resources_dir, "..", ".."))
        self.app_path = app if app.endswith(".app") else None
        self.cache = os.path.expanduser(os.environ.get("GCT_UPDATE_CACHE", "~/Library/Caches/G-ColorTag/updates"))
        self.lock = threading.Lock()
        self.prepared = None       # 준비된 새 .app 경로
        self.applied = False
        self.st = {"status": "idle", "current": version, "latest": "", "notes": "", "progress": 0,
                   "error": "", "page": f"https://github.com/{REPO}/releases"}

    # ---- 상태
    def state(self):
        return dict(self.st)

    def _set(self, **kw):
        self.st.update(kw)

    def install_problem(self):
        """앱을 바꿔 넣을 수 없는 이유 (없으면 '')."""
        p = self.app_path
        if not p or (sys.platform != "darwin" and os.environ.get("GCT_UPDATE_TEST") != "1"):
            return "설치된 앱에서만 업데이트할 수 있습니다"
        if p.startswith("/Volumes/") or "/AppTranslocation/" in p:
            return "응용 프로그램 폴더로 옮긴 뒤 실행해야 업데이트할 수 있습니다"
        if not os.access(os.path.dirname(p), os.W_OK):
            return "앱이 있는 폴더에 쓸 권한이 없습니다"
        return ""

    # ---- 확인·다운로드
    def start(self):
        def loop():
            time.sleep(FIRST_CHECK)
            while True:
                self.check()
                time.sleep(INTERVAL)
        threading.Thread(target=loop, daemon=True).start()

    def check(self, manual=False):
        if not self.lock.acquire(blocking=False):
            return self.state()
        try:
            if self.st["status"] in ("ready",):
                return self.state()
            self._set(status="checking", error="")
            self._check()
        except Exception as e:  # 업데이트 실패는 앱 기능에 영향 없음
            self.log("update error:", e)
            self._set(status="error", error=str(e)[:120] or "업데이트 확인 실패")
        finally:
            self.lock.release()
        return self.state()

    def _check(self):
        rels = json.loads(curl(API))
        rels = [r for r in rels if str(r.get("tag_name", "")).startswith(TAG_PREFIX)
                and not r.get("draft") and not r.get("prerelease")]
        if not rels:
            return self._set(status="uptodate")
        rel = max(rels, key=lambda r: vtuple(r["tag_name"][len(TAG_PREFIX):]))
        latest = rel["tag_name"][len(TAG_PREFIX):]
        if vtuple(latest) <= vtuple(self.version):
            return self._set(status="uptodate", latest=latest)
        assets = {a["name"]: a["browser_download_url"] for a in rel.get("assets", [])}
        if MANIFEST not in assets:
            raise RuntimeError("릴리스에 업데이트 정보가 없습니다")
        man = json.loads(curl(assets[MANIFEST]))
        if str(man.get("version")) != latest:
            raise RuntimeError("업데이트 정보의 버전이 맞지 않습니다")
        info = (man.get("files") or {}).get(arch())
        if not info or info.get("name") not in assets:
            raise RuntimeError("이 맥에 맞는 업데이트 파일이 없습니다")
        self._set(latest=latest, notes=str(man.get("notes", ""))[:2000])
        problem = self.install_problem()
        if problem:
            return self._set(status="manual", error=problem)
        self._download(latest, info, assets[info["name"]])

    def _download(self, latest, info, url):
        shutil.rmtree(self.cache, ignore_errors=True)  # 예전 버전 찌꺼기 정리
        d = os.path.join(self.cache, latest)
        os.makedirs(d, exist_ok=True)
        pkg = os.path.join(d, info["name"])
        size = int(info["size"])
        self._set(status="downloading", progress=0)
        p = curl(url, pkg)
        while p.poll() is None:
            if os.path.exists(pkg):
                self._set(progress=min(99, int(os.path.getsize(pkg) * 100 / max(size, 1))))
            time.sleep(0.3)
        if p.returncode != 0:
            raise RuntimeError("다운로드에 실패했습니다")
        if os.path.getsize(pkg) != size or sha256(pkg) != info["sha256"]:
            raise RuntimeError("받은 파일이 손상되어 설치하지 않았습니다")
        x = os.path.join(d, "x")
        os.makedirs(x)
        r = subprocess.run(["tar", "-xzf", pkg, "-C", x], capture_output=True)
        app = os.path.join(x, "G-ColorTag.app")
        if r.returncode != 0 or not os.path.isdir(app):
            raise RuntimeError("업데이트 파일을 풀지 못했습니다")
        with open(os.path.join(app, "Contents", "Info.plist"), "rb") as f:
            if plistlib.load(f).get("CFBundleShortVersionString") != latest:
                raise RuntimeError("업데이트 파일의 버전이 맞지 않습니다")
        os.remove(pkg)
        self.prepared = app
        self._set(status="ready", progress=100)

    # ---- 교체
    def apply(self, relaunch):
        """앱이 끝나면 새 앱으로 바꿔 넣는 도우미를 띄움."""
        if not self.prepared or self.applied or self.install_problem():
            return False
        self.applied = True
        script = os.path.join(self.cache, "swap.sh")
        with open(script, "w") as f:
            f.write(SWAP_SH)
        subprocess.Popen(["/bin/bash", script, str(os.getpid()), self.app_path, self.prepared,
                          "1" if relaunch else "0"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        return True


SWAP_SH = r"""#!/bin/bash
# 앱이 끝날 때까지 기다렸다가 새 앱으로 교체. 실패하면 원래 앱을 되돌림.
PID="$1"; OLD="$2"; NEW="$3"; RELAUNCH="$4"
for i in $(seq 1 600); do  # 앱이 끝날 때까지 (좀비 상태도 끝난 것으로 봄)
  s=$(ps -o stat= -p "$PID" 2>/dev/null | tr -d ' ')
  { [ -z "$s" ] || [ "${s#Z}" != "$s" ]; } && break
  sleep 0.2
done
BAK="$OLD.old-$$"
if mv "$OLD" "$BAK"; then
  if mv "$NEW" "$OLD"; then rm -rf "$BAK"; else mv "$BAK" "$OLD"; fi
fi
/usr/bin/xattr -dr com.apple.quarantine "$OLD" 2>/dev/null
[ "$RELAUNCH" = "1" ] && /usr/bin/open "$OLD"
exit 0
"""
