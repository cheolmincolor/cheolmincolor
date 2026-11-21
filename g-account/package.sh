#!/usr/bin/env bash
# 데스크톱 앱을 zip 으로 묶습니다.
#
#   bash package.sh                          # 이 컴퓨터에서 만들 수 있는 것 전부
#   TARGETS="win32-x64" bash package.sh      # 하나만
#   OUT=/some/folder bash package.sh         # 결과 위치 (기본: dist)
#
# Mac 용은 서명이 있어야 Apple Silicon 에서 실행되므로 macOS 에서 만듭니다(codesign 의 ad-hoc 서명, Apple 계정 불필요).
# Windows 용은 macOS·Linux·Windows 어디서나 만들 수 있습니다.
set -euo pipefail
cd "$(dirname "$0")"

SLUG="G-Account"
VERSION=$(node -p "require('./package.json').version")
OUT=${OUT:-dist}
if [ -z "${TARGETS:-}" ]; then
  TARGETS="win32-x64"
  [ "$(uname)" = Darwin ] && TARGETS="darwin-arm64 darwin-x64 win32-x64"
fi
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

[ -d node_modules/electron ] || npm ci

for target in $TARGETS; do
  os=${target%-*}; arch=${target#*-}
  # Windows 실행 파일 이름은 한 버전 더 예전 이름으로 둡니다: 1.4.0 까지의 앱은 그 이름의 exe 만 찾아 업데이트합니다.
  NAME="G-Account"; [ "$os" = win32 ] && NAME="GRAYZONE Ledger"
  echo "── $target"
  if [ "$os" = darwin ] && [ "$(uname)" != Darwin ]; then
    echo "   Mac 용은 macOS 에서 만들어야 합니다(서명). 건너뜁니다." >&2
    continue
  fi

  npx electron-packager . "$NAME" --platform="$os" --arch="$arch" --out="$OUT" --overwrite \
    --asar --icon=build/icon \
    --app-bundle-id=com.grayzone.ledger --app-version="$VERSION" \
    --app-category-type=public.app-category.finance --extend-info=build/mac-info.plist \
    --win32metadata.ProductName="G-Account" --win32metadata.FileDescription="G-Account" --win32metadata.CompanyName="GRAYZONE" \
    --app-copyright="GRAYZONE" \
    --ignore='^/(dist|test|scripts|node_modules|package\.sh|README\.md|\.gitignore)($|/)' --ignore='^/build/(icon\.svg|icon\.icns|icon\.ico|mac-info\.plist)$' --quiet

  dir="$OUT/$NAME-$os-$arch"
  if [ "$os" = darwin ]; then
    codesign --force --deep --sign - "$dir/$NAME.app"
    codesign --verify --deep --strict "$dir/$NAME.app"
    zip="$OUT/$SLUG-$VERSION-mac-$arch.zip"
    rm -f "$zip"; (cd "$dir" && zip -qry "$zip" "$NAME.app")   # -y: 앱 안의 심볼릭 링크 유지
  else
    # zip 안의 폴더 이름에는 버전을 넣지 않습니다(자동 업데이트 뒤에도 폴더 이름이 그대로 맞도록).
    label=windows; [ "$os" = linux ] && label=linux   # linux 는 시험용
    stage="$OUT/stage-$os-$arch"
    rm -rf "$stage"; mkdir -p "$stage"; mv "$dir" "$stage/$NAME"
    zip="$OUT/$SLUG-$VERSION-$label-$arch.zip"
    rm -f "$zip"; (cd "$stage" && zip -qry "$zip" "$NAME")
    rm -rf "$stage"
  fi
  echo "   $(du -h "$zip" | cut -f1)  $zip"
done
