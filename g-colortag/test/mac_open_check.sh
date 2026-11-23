#!/bin/bash
# Copyright (c) 2026 GRAYZONE. All rights reserved.
# 실제 맥에서: 영상을 '다음으로 열기'(파인더 더블클릭, Dock 아이콘에 끌어다 놓기와 같은 경로)로 앱에 넘기면 목록에 들어가는지.
# 사용: bash test/mac_open_check.sh release/<버전>/G-Retag-<버전>-arm64.tar.gz
set -euo pipefail
W=$(mktemp -d); mkdir -p "$W/Applications"
tar -xzf "$1" -C "$W/Applications"
APP="$W/Applications/G-Retag.app"
/usr/libexec/PlistBuddy -c "Print :CFBundleDocumentTypes:0:LSItemContentTypes" "$APP/Contents/Info.plist"
"$APP/Contents/Resources/bin/ffmpeg" -v error -f lavfi -i testsrc2=d=2:s=640x360:r=24 -c:v libx264 -pix_fmt yuv420p \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 "$W/열어 볼 영상.mov"
LOG="$HOME/Library/Logs/G-Retag.log"; : > "$LOG" 2>/dev/null || true
open -a "$APP" "$W/열어 볼 영상.mov"
ok=0
for i in $(seq 1 80); do grep -q "open files: 1" "$LOG" 2>/dev/null && { ok=1; break; }; sleep 0.5; done
sleep 2
pkill -f "G-Retag.app/Contents/Resources/app.py" 2>/dev/null || true
echo "  기록:"; sed 's/^/    /' "$LOG" | head -12
[ "$ok" = 1 ] || { echo "❌ 앱이 넘겨받은 영상을 열지 못함"; exit 1; }
N=$(grep -c "open files:" "$LOG" || true)
[ "$N" = 1 ] || { echo "❌ 열기 요청이 $N 번 처리됨 (영상 하나만 넘겼으므로 1번이어야 함)"; exit 1; }
echo "'다음으로 열기'로 영상 열기 통과 ✅"
