#!/bin/bash
# Copyright (c) 2026 GRAYZONE. All rights reserved.
# 실제 맥에서: 예전 G-ColorTag 3.5.0(릴리스에 올라간 그대로)이 자동 업데이트로 새 버전을 받고,
# 새 앱이 처음 켜질 때 G-Retag.app 으로 이름을 바꾸는지 확인.
#  1) 릴리스의 G-ColorTag 3.5.0 을 임시 Applications 에 설치
#  2) 그 앱 안의 업데이트 기능으로, 이번에 만든 릴리스 파일(file://)에서 새 버전을 받아 교체
#  3) 교체된 앱(아직 G-ColorTag.app 자리)의 실행기를 실제로 실행 → G-Retag.app 으로 이름 바꾸고 앱이 뜨는지
# 사용: GH_TOKEN=… bash test/mac_migrate_check.sh release/<버전>
set -euo pipefail
REL=$(cd "$1" && pwd)
V=$(basename "$REL")
W=$(mktemp -d); A="$W/Applications"; mkdir -p "$A" "$W/trash"
echo "== 1) 예전 G-ColorTag 3.5.0 설치"
gh release download colortag-v3.5.0 --repo "${GITHUB_REPOSITORY:-cheolmincolor/cheolmincolor}" \
   -p 'G-ColorTag-3.5.0-arm64.tar.gz' -D "$W"
tar -xzf "$W/G-ColorTag-3.5.0-arm64.tar.gz" -C "$A"
OLD="$A/G-ColorTag.app"
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$OLD/Contents/Info.plist"

echo "== 2) 예전 앱의 업데이트 기능으로 $V 받기"
python3 - "$REL" "$W/releases.json" "$V" <<'EOF'
import json, os, sys
rel, out, v = sys.argv[1:4]
assets = [{"name": n, "browser_download_url": "file://" + os.path.join(rel, n)} for n in os.listdir(rel)]
json.dump([{"tag_name": f"colortag-v{v}", "draft": False, "prerelease": False, "assets": assets}], open(out, "w"))
EOF
GCT_UPDATE_API="file://$W/releases.json" GCT_UPDATE_CACHE="$W/cache" \
  "$OLD/Contents/MacOS/G-ColorTag-python" -I -B - "$OLD/Contents/Resources" "$V" <<'EOF'
import sys
R, V = sys.argv[1:3]
sys.path.insert(0, R)
import updater  # 예전 앱에 들어 있는 3.5.0 업데이트 코드 그대로
u = updater.Updater("3.5.0", R)
st = u.check()
print("  예전 앱 업데이트 상태:", st["status"], st["latest"], st["error"])
assert st["status"] == "ready" and st["latest"] == V, st
assert u.apply(relaunch=False)
EOF
for i in $(seq 1 100); do
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$OLD/Contents/Info.plist" 2>/dev/null)" = "G-Retag" ] && break
  sleep 0.3
done
echo "  교체 후 예전 자리의 앱: $(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$OLD/Contents/Info.plist")" \
     "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$OLD/Contents/Info.plist")"
[ -x "$OLD/Contents/MacOS/G-Retag" ] || { echo "❌ 교체 실패"; ls "$A"; exit 1; }

echo "== 3) 새 앱 첫 실행 (실행기 그대로) → G-Retag.app 으로 이름 바꾸기"
LOG="$HOME/Library/Logs/G-Retag.log"
: > "$LOG" 2>/dev/null || true
GCT_TRASH="$W/trash" "$OLD/Contents/MacOS/G-Retag" &
L=$!
ok=0
for i in $(seq 1 80); do
  if [ -d "$A/G-Retag.app" ] && [ ! -e "$OLD" ] && grep -q "native player\|pywebview" "$LOG" 2>/dev/null; then ok=1; break; fi
  sleep 0.5
done
sleep 2
pkill -f "G-Retag.app/Contents/Resources/app.py" 2>/dev/null || true
kill $L 2>/dev/null || true
echo "  설치 폴더: $(ls "$A" | tr '\n' ' ')"
echo "  기록:"; sed 's/^/    /' "$LOG" | head -20
[ "$ok" = 1 ] || { echo "❌ 이름 바꾸기 또는 앱 시작 실패"; exit 1; }
grep -q "이름 바꿈" "$LOG" || { echo "❌ 기록에 이름 바꿈 없음"; exit 1; }
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$A/G-Retag.app/Contents/Info.plist")" = "$V" ]
echo "예전 3.5.0 → $V 자동 업데이트 + G-Retag 이름 바꾸기 통과 ✅"
