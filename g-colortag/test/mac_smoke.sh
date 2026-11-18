#!/bin/bash
# Copyright (c) 2026 GRAYZONE. All rights reserved.
# 실제 맥(GitHub Actions macOS)에서 앱 묶음을 풀어 확인:
#   1) 앱 안의 파이썬이 표준 라이브러리·pywebview·PyObjC 를 불러오는지
#   2) 앱 안의 ffmpeg 로 미리보기·저장이 되고, 저장한 파일 태그가 1-2-1·픽셀은 그대로인지
# 사용: bash test/mac_smoke.sh release/<버전>/G-ColorTag-<버전>-arm64.tar.gz
set -euo pipefail
PKG=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
W="${RUNNER_TEMP:-$(mktemp -d)}/gct-smoke"
mkdir -p "$W/Applications" "$W/videos"
tar -xzf "$PKG" -C "$W/Applications"
APP="$W/Applications/G-ColorTag.app"; RES="$APP/Contents/Resources"; PY="$APP/Contents/MacOS/G-ColorTag-python"
export PATH="$RES/bin:/usr/bin:/bin:/usr/sbin"

echo "== 1) 앱 안의 파이썬"
"$PY" -I -B -c "
import sys, ssl, json; sys.path.insert(0, '$RES/site')
import webview, objc, AppKit, WebKit, AVFoundation, CoreMedia, Quartz
print('python', sys.version.split()[0], '| prefix', sys.prefix.replace('$APP', 'G-ColorTag.app'))
print('pywebview OK | PyObjC', objc.__version__, '| WebKit OK')"

echo "== 2) 앱 안의 ffmpeg"
ffmpeg -version | head -1
ffmpeg -v error -f lavfi -i testsrc2=d=12:s=1280x720:r=24 -c:v libx264 -pix_fmt yuv420p \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 "$W/videos/h264 테스트.mov"
ffmpeg -v error -f lavfi -i testsrc2=d=3:s=1280x720:r=24 -c:v prores_ks -profile:v 3 \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 "$W/videos/prores.mov"

echo "== 3) 앱 서버: 미리보기·저장"
"$PY" -I -B "$RES/app.py" --serve > "$W/url.txt" 2> "$W/app.log" &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 50); do [ -s "$W/url.txt" ] && break; sleep 0.2; done
"$PY" -I -B - "$(head -1 "$W/url.txt")" "$W/videos" "$RES" <<'EOF'
import json, os, subprocess, sys, time, urllib.request
url, V, RES = sys.argv[1:4]; sys.path.insert(0, RES); import colortag as ct
base, tok = url.split("/?t=")
def api(name, body=None):
    req = urllib.request.Request(f"{base}/api/{name}", data=None if body is None else json.dumps(body).encode(),
                                 headers={"X-Token": tok, "Content-Type": "application/json"}, method="GET" if body is None else "POST")
    with urllib.request.urlopen(req) as r: return json.loads(r.read())
st = api("add", {"paths": [os.path.join(V, f) for f in sorted(os.listdir(V))]})
for f in st["files"]:
    for seg in (0, 1) if f["duration"] > 10 else (0,):
        t0 = time.time()
        while (j := api(f"segment?id={f['id']}&seg={seg}"))["state"] not in ("done", "error"): time.sleep(0.2)
        assert j["state"] == "done", j
        print(f"  미리보기 {f['name']} 구간{seg}: {time.time()-t0:.1f}s")
api("save", {"tag": "mac"})
while api("state")["saving"]: time.sleep(0.3)
for f in api("state")["files"]:
    assert f["status"] == "done", f
    out = os.path.join(V, f["result"].split(" · ")[0])
    tag = ct.tag_str(ct.read_tracks(out)[0]["tag"])
    md5 = lambda p: subprocess.run(["ffmpeg", "-v", "error", "-i", p, "-map", "0:v", "-f", "md5", "-"], capture_output=True, text=True).stdout
    same = md5(out) == md5(f["path"])
    print(f"  저장 {f['result']}: 태그 {tag} | 픽셀 원본과 동일 {same}")
    assert tag == "1-2-1" and same
    assert "퀵타임 (1-2-1) 확인" in f["result"], f["result"]
print("서버 테스트 통과")
EOF
grep -i "traceback\|server error\|preview error\|save error" "$W/app.log" && { echo "앱 기록에 오류가 있습니다"; exit 1; } || true
echo "실제 맥 확인 통과 ✅"
