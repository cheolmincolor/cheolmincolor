#!/usr/bin/env bash
# Builds the G-Copy desktop app for each target: the Go engine plus the
# Electron shell, zipped and ready to hand out.
#
#   bash package.sh                         # macOS: Apple Silicon and Intel
#   TARGETS="darwin-arm64" bash package.sh  # one target
#   OUT=/some/folder bash package.sh        # where the results go (default: dist)
#
# Works on Linux and macOS. Needs Go, Node.js and zip.
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(node -p "require('./package.json').version")
OUT=${OUT:-dist}
TARGETS=${TARGETS:-"darwin-arm64 darwin-x64"}
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
  (cd .. && CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go build -trimpath -ldflags "-s -w" -o "desktop/engine/gcopy-engine$ext" .)

  # 2. the app: shell in app.asar, engine next to it in the resources folder
  npx electron-packager . G-Copy --platform="$os" --arch="$arch" --out="$OUT" --overwrite \
    --asar --extra-resource=engine --icon=build/icon \
    --app-bundle-id=app.gcopy.desktop --app-version="$VERSION" \
    --app-category-type=public.app-category.utilities --extend-info=build/mac-info.plist \
    --ignore='^/(dist|engine|build|package\.sh|make-release\.mjs|RELEASE_NOTES\.md|README\.md)($|/)' --quiet
  rm -rf engine

  # 3. zip it
  dir="$OUT/G-Copy-$os-$arch"
  if [ "$os" = darwin ]; then
    # Apple Silicon refuses to run code without a signature. An "ad-hoc"
    # signature needs no Apple account and is enough to run the app.
    if [ "$(uname)" = Darwin ]; then
      codesign --force --deep --sign - "$dir/G-Copy.app"
    elif command -v rcodesign >/dev/null; then
      rcodesign sign "$dir/G-Copy.app" >/dev/null 2>&1 || { echo "   signing failed" >&2; exit 1; }
    else
      echo "   warning: rcodesign not found, app left unsigned. It may not run on Apple Silicon." >&2
    fi
    zip="$OUT/G-Copy-$VERSION-mac-$arch.zip"
    rm -f "$zip"; (cd "$dir" && zip -qry "$zip" G-Copy.app)   # -y keeps the symlinks inside the app
  else
    label=windows; [ "$os" = linux ] && label=linux
    name="G-Copy-$VERSION-$label-$arch"
    rm -rf "${OUT:?}/$name" "$OUT/$name.zip"; mv "$dir" "$OUT/$name"
    (cd "$OUT" && zip -qry "$name.zip" "$name")
    zip="$OUT/$name.zip"
  fi
  echo "   $(du -h "$zip" | cut -f1)  $zip"
done
