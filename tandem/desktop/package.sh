#!/usr/bin/env bash
# Builds the Tandem desktop app for each target: the Go engine plus the
# Electron shell, zipped and ready to hand out.
#
#   bash package.sh                         # macOS (Apple Silicon, Intel) and Windows
#   TARGETS="darwin-arm64" bash package.sh  # one target
#   OUT=/some/folder bash package.sh        # where the results go (default: dist)
#
# Works on Linux and macOS. Needs Go, Node.js and zip.
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(node -p "require('./package.json').version")
OUT=${OUT:-dist}
TARGETS=${TARGETS:-"darwin-arm64 darwin-x64 win32-x64"}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

[ -d node_modules/electron ] || npm ci

for target in $TARGETS; do
  os=${target%-*}; arch=${target#*-}
  goos=$os;     [ "$os" = win32 ] && goos=windows
  goarch=$arch; [ "$arch" = x64 ] && goarch=amd64
  ext="";       [ "$os" = win32 ] && ext=.exe
  echo "── $target"

  # 1. the engine for this platform
  rm -rf engine && mkdir engine
  (cd .. && CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go build -trimpath -ldflags "-s -w" -o "desktop/engine/tandem-engine$ext" .)

  # 2. the app: shell in app.asar, engine next to it in the resources folder
  npx electron-packager . Tandem --platform="$os" --arch="$arch" --out="$OUT" --overwrite \
    --asar --extra-resource=engine --icon=build/icon \
    --app-bundle-id=app.tandem.desktop --app-version="$VERSION" \
    --app-category-type=public.app-category.utilities --extend-info=build/mac-info.plist \
    --ignore='^/(dist|engine|build|package\.sh|README\.md)($|/)' --quiet
  rm -rf engine

  # 3. zip it
  dir="$OUT/Tandem-$os-$arch"
  if [ "$os" = darwin ]; then
    # Apple Silicon refuses to run code without a signature. An "ad-hoc"
    # signature needs no Apple account and is enough to run the app.
    if [ "$(uname)" = Darwin ]; then
      codesign --force --deep --sign - "$dir/Tandem.app"
    elif command -v rcodesign >/dev/null; then
      rcodesign sign "$dir/Tandem.app" >/dev/null 2>&1 || { echo "   서명에 실패했습니다" >&2; exit 1; }
    else
      echo "   주의: 서명 도구(rcodesign)가 없어 서명하지 않았습니다. Apple Silicon에서 실행되지 않을 수 있습니다." >&2
    fi
    zip="$OUT/Tandem-$VERSION-mac-$arch.zip"
    rm -f "$zip"; (cd "$dir" && zip -qry "$zip" Tandem.app)   # -y keeps the symlinks inside the app
  else
    label=windows; [ "$os" = linux ] && label=linux
    name="Tandem-$VERSION-$label-$arch"
    rm -rf "${OUT:?}/$name" "$OUT/$name.zip"; mv "$dir" "$OUT/$name"
    (cd "$OUT" && zip -qry "$name.zip" "$name")
    zip="$OUT/$name.zip"
  fi
  echo "   $(du -h "$zip" | cut -f1)  $zip"
done
