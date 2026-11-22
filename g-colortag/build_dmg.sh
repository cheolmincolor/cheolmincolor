#!/bin/bash
# Copyright (c) 2026 GRAYZONE. All rights reserved.
# G-Retag for QuickTime 맥 설치파일(DMG) 만들기
# 번들 ID(local.colortag)는 예전 G-ColorTag 와 같게 둠 (같은 앱, 이름만 바뀜)
# 사용: ./build_dmg.sh arm64   (Apple Silicon: M1/M2/M3/M4…)
#       ./build_dmg.sh x64     (Intel 맥)
# 결과: dist/G-Retag-<arch>.dmg
set -euo pipefail
ARCH=${1:?"arm64 또는 x64 를 지정하세요"}
cd "$(dirname "$0")"
ROOT=$(pwd)
CACHE="$ROOT/cache"; WHEELS="$CACHE/wheels"; DIST="$ROOT/dist"; WORK="$ROOT/build/$ARCH"
mkdir -p "$CACHE" "$WHEELS" "$DIST"

FF_TAG=b6.1.1; PY_TAG=20251014; PY_VER=3.12.12
VERSION=$(sed -n 's/^APP_VERSION = "\(.*\)"/\1/p' app.py)   # 앱 버전은 app.py 한 곳에서 관리
case "$ARCH" in
  arm64) PY_ARCH=aarch64; MINOS=12.0
         FF_SHA=8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa
         PY_SHA=84cb7acbf75264982c8bdd818bfa1ff0f1eb76007b48a5f3e01d28633b46afdf ;;
  x64)   PY_ARCH=x86_64; MINOS=10.15
         FF_SHA=929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106
         PY_SHA=f76a921e71e9c8954cccd00f176b7083041527b3b4223670d05bbb2f51209d3f ;;
  *) echo "arm64 또는 x64 만 가능"; exit 1 ;;
esac

fetch() {  # url 파일 sha256  → 받아두고 체크섬 검증
  [ -f "$2" ] || { curl -fsSL --retry 4 -o "$2.part" "$1" && mv "$2.part" "$2"; }
  echo "$3  $2" | sha256sum -c --quiet || { echo "체크섬 불일치: $2"; rm -f "$2"; exit 1; }
}
FF_GZ="$CACHE/ffmpeg-darwin-$ARCH.gz"
PY_TGZ="$CACHE/python-$PY_ARCH.tar.gz"
fetch "https://github.com/eugeneware/ffmpeg-static/releases/download/$FF_TAG/ffmpeg-darwin-$ARCH.gz" "$FF_GZ" "$FF_SHA"
fetch "https://github.com/astral-sh/python-build-standalone/releases/download/$PY_TAG/cpython-$PY_VER+$PY_TAG-$PY_ARCH-apple-darwin-install_only_stripped.tar.gz" "$PY_TGZ" "$PY_SHA"
while read -r fn sha url; do  # pywebview + PyObjC (wheels.lock 에 해시 고정)
  case "$fn" in ''|\#*) continue ;; esac
  fetch "$url" "$WHEELS/$fn" "$sha"
done < wheels.lock

# ---------- .app 번들 ----------
rm -rf "$WORK"; mkdir -p "$WORK/dmg"
APP="$WORK/dmg/G-Retag.app"; RES="$APP/Contents/Resources"
mkdir -p "$APP/Contents/MacOS" "$RES/bin" "$RES/web" "$RES/site"
cp app.py colortag.py updater.py qtplayer.py migrate.py LICENSE.txt "$RES/"
cp web/index.html web/launch.html "$RES/web/"
mkdir -p "$RES/web/fonts"; cp web/fonts/*.woff2 "$RES/web/fonts/"   # 앱 글꼴 Pretendard, GRAY ZONE 워드마크 Manrope (OFL)
gunzip -c "$FF_GZ" > "$RES/bin/ffmpeg"; chmod 755 "$RES/bin/ffmpeg"
tar xzf "$PY_TGZ" -C "$RES"                      # → $RES/python
P="$RES/python"; PL="$P/lib/python3.12"           # 필요 없는 부분 정리 (용량 절약)
rm -rf "$P/include" "$P/share" "$P/lib/pkgconfig" "$P"/bin/{pip*,idle*,pydoc*,2to3*,python3*-config}
rm -rf "$PL"/{idlelib,ensurepip,turtledemo,lib2to3,pydoc_data,site-packages,config-3.12-darwin,tkinter,turtle.py}
rm -rf "$P"/lib/{tcl8,tcl8.6,tk8.6,itcl*,thread2*,libtcl*,libtk*} "$PL"/lib-dynload/_tkinter*
python3 -m pip install -q --no-deps --no-compile --disable-pip-version-check --target "$RES/site" \
  --only-binary=:all: --python-version 3.12 --implementation cp --abi cp312 \
  --platform macosx_10_13_universal2 --platform macosx_11_0_arm64 --platform macosx_10_9_x86_64 "$WHEELS"/*.whl
mkdir -p "$RES/site/proxy_tools"  # 휠이 없는 순수 파이썬 모듈 1개: 빌드 스크립트 실행 없이 파일만 꺼냄
tar xzf "$WHEELS/proxy_tools-0.1.0.tar.gz" -O proxy_tools-0.1.0/proxy_tools/__init__.py > "$RES/site/proxy_tools/__init__.py"
rm -rf "$RES/site/bin" "$RES/site/PyObjCTest" "$RES/site/webview/lib"/{*.dll,*.jar,runtimes}  # 테스트·윈도우·안드로이드용
find "$RES/site" -name "*.dSYM" -prune -exec rm -rf {} +                                            # 디버그 기호
# 메뉴 막대·Dock 에 'G-Retag' 로 보이도록 파이썬 실행 파일을 Contents/MacOS 에 둠
cp "$P/bin/python3.12" "$APP/Contents/MacOS/G-Retag-python"
ln -s Resources/python/lib "$APP/Contents/lib"     # 실행 파일 기준 ../lib 에서 표준 라이브러리 찾기
python3 make_icon.py "$RES/AppIcon.icns" "$RES/web/appicon.png"   # 런치 화면은 아이콘 파일 안의 그림을 그대로 씀

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>G-Retag</string>
  <key>CFBundleDisplayName</key><string>G-Retag</string>
  <key>CFBundleIdentifier</key><string>local.colortag</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>G-Retag</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>$MINOS</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.video</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>© $(date +%Y) GRAY ZONE. All rights reserved.</string>
  <key>GZBuildDate</key><string>$(date +%Y-%m-%d)</string>
  <key>NSAppTransportSecurity</key><dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict></plist>
EOF

cat > "$APP/Contents/MacOS/G-Retag" <<'EOF'
#!/bin/bash
APP="$(cd "$(dirname "$0")/../.." && pwd)"
RES="$APP/Contents/Resources"
PY="$APP/Contents/MacOS/G-Retag-python"
LOG="$HOME/Library/Logs/G-Retag.log"
alert() { /usr/bin/osascript -e "display alert \"$1\" message \"$2\"" >/dev/null 2>&1; }
case "$APP" in
  /Volumes/*|*/AppTranslocation/*)
    alert "응용 프로그램 폴더로 옮겨주세요" "G-Retag를 Applications(응용 프로그램) 폴더로 드래그한 뒤 거기서 실행하세요."
    exit 0 ;;
esac
# 앱 실행이 허용된 뒤, 안에 든 python/ffmpeg 의 다운로드 격리 표시를 지움
/usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
mkdir -p "$HOME/Library/Logs"
[ -f "$LOG" ] && [ "$(stat -f %z "$LOG" 2>/dev/null || echo 0)" -gt 1000000 ] && : > "$LOG"
export PATH="$RES/bin:/usr/bin:/bin"
if ! "$PY" -I -c "import json, ssl" >>"$LOG" 2>&1; then
  alert "G-Retag를 시작할 수 없습니다" "앱을 다시 설치해 주세요. 기록: ~/Library/Logs/G-Retag.log"
  exit 1
fi
echo "---- $(date) 시작" >>"$LOG"
# 예전 이름(G-ColorTag.app)에서 업데이트된 경우 G-Retag.app 으로 이름을 바꾸고 새 자리에서 다시 실행
NEWAPP=$("$PY" -I -B "$RES/migrate.py" "$APP" 2>>"$LOG")
if [ -n "$NEWAPP" ] && [ -x "$NEWAPP/Contents/MacOS/G-Retag" ]; then
  export GRETAG_MIGRATED=1
  exec "$NEWAPP/Contents/MacOS/G-Retag" "$@"
fi
exec "$PY" -I -B "$RES/app.py" >>"$LOG" 2>&1
EOF
chmod 755 "$APP/Contents/MacOS/G-Retag"

# ---------- DMG ----------
ln -s /Applications "$WORK/dmg/Applications"
cat > "$WORK/dmg/HOW-TO-INSTALL.txt" <<'EOF'
G-Retag for QuickTime 설치 방법   © @YEAR@ GRAY ZONE. All rights reserved.
==========================
1. G-Retag.app 을 옆의 Applications 폴더로 드래그하세요.
2. 응용 프로그램 폴더에서 G-Retag 를 실행하세요.
3. "확인할 수 없음" 경고가 뜨면:
   시스템 설정 > 개인정보 보호 및 보안 > 맨 아래 "그래도 열기" 클릭
   (구버전 macOS: 앱 우클릭 > 열기)
   ※ 처음 한 번만 하면 됩니다.

그래도 열리지 않으면 터미널에서 아래 한 줄 실행 후 다시 여세요:
   xattr -dr com.apple.quarantine /Applications/G-Retag.app

예전 이름(G-ColorTag)으로 설치한 앱이 있으면, G-Retag 를 처음 켤 때 예전 앱을 휴지통으로 옮깁니다.

태그 안내
==========================
태그는 영상 파일에 붙은 색 정보 꼬리표입니다 (원색 - 전달 특성 - 행렬 번호).
플레이어는 이 번호를 보고 화면에 어떤 밝기로 보여줄지 정합니다.

Rec709 1-1-1  General            일반 Rec709
Rec709 1-2-1  For Mac QuickTime  맥 퀵타임에서 정확하게 보이는 Rec709
              (퀵타임 '동영상 속성': 전송 기능 '지정 안 됨', 코드 포인트 (1-2-1) · MOV 로 저장)

태그를 바꿔도 픽셀 밝기는 변하지 않습니다. 다시 인코딩하지 않고 태그만 바꿉니다.
맥 퀵타임에서 밝기가 다르게 보이는 문제를 해결하기 위한 것입니다.
잘 모르겠다면 앱에서 두 화면을 재생해 비교해 보세요.

문제가 생기면 이 파일을 보내 주세요: ~/Library/Logs/G-Retag.log
ffmpeg 와 Python 이 앱 안에 들어있어 따로 설치할 필요가 없습니다.

저작권: 이 소프트웨어의 저작권은 GRAY ZONE에 있습니다.
GRAY ZONE의 허락 없이 복제·배포·수정할 수 없습니다. 자세한 내용은 앱 안의 LICENSE.txt 를 보세요.
EOF
sed -i "s/@YEAR@/$(date +%Y)/" "$WORK/dmg/HOW-TO-INSTALL.txt"   # 연도는 빌드 날짜에서
OUT="$DIST/G-Retag-$ARCH.dmg"
rm -f "$OUT"
genisoimage -quiet -V "G-Retag" -R -D -l -no-pad -o "$OUT" "$WORK/dmg"
echo "완성: $OUT ($(du -h "$OUT" | cut -f1))"
