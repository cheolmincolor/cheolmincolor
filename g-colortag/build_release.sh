#!/bin/bash
# 릴리스용 파일 만들기 → release/<버전>/
#   G-ColorTag-<ver>-arm64.dmg / -x64.dmg      처음 설치용
#   G-ColorTag-<ver>-arm64.tar.gz / -x64.tar.gz 자동 업데이트용 (.app 묶음)
#   colortag-latest.json                        자동 업데이트 정보 (버전·바뀐 점·크기·체크섬)
# 버전은 app.py 의 APP_VERSION, 바뀐 점은 CHANGELOG.md 맨 위 항목에서 가져옴.
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(sed -n 's/^APP_VERSION = "\(.*\)"/\1/p' app.py)
[ -n "$VERSION" ] || { echo "app.py 에서 버전을 찾지 못함"; exit 1; }
grep -q "^## $VERSION\$" CHANGELOG.md || { echo "CHANGELOG.md 에 '## $VERSION' 항목을 먼저 적어 주세요"; exit 1; }
OUT="release/$VERSION"
mkdir -p "$OUT"
NOTES=$(awk -v v="## $VERSION" '$0==v{f=1;next} /^## /{f=0} f' CHANGELOG.md | sed '/^$/d')
printf '%s\n' "$NOTES" > "$OUT/notes.md"

for A in arm64 x64; do
  ./build_dmg.sh "$A" | grep 완성
  cp "dist/G-ColorTag-$A.dmg" "$OUT/G-ColorTag-$VERSION-$A.dmg"
  tar -czf "$OUT/G-ColorTag-$VERSION-$A.tar.gz" -C "build/$A/dmg" G-ColorTag.app
done

python3 - "$OUT" "$VERSION" <<'EOF'
import hashlib, json, os, sys
out, ver = sys.argv[1:3]
files = {}
for a in ("arm64", "x64"):
    name = f"G-ColorTag-{ver}-{a}.tar.gz"
    p = os.path.join(out, name)
    files[a] = {"name": name, "size": os.path.getsize(p), "sha256": hashlib.sha256(open(p, "rb").read()).hexdigest()}
notes = open(os.path.join(out, "notes.md"), encoding="utf-8").read().strip()
json.dump({"version": ver, "notes": notes, "files": files}, open(os.path.join(out, "colortag-latest.json"), "w"),
          ensure_ascii=False, indent=2)
print(json.dumps(files, indent=2))
EOF
echo
echo "릴리스 파일 준비 완료: $OUT"
echo "올리는 명령:"
echo "  gh release create colortag-v$VERSION $OUT/*.dmg $OUT/*.tar.gz $OUT/colortag-latest.json \\"
echo "     --repo cheolmincolor/cheolmincolor --title \"G-ColorTag $VERSION\" --notes-file $OUT/notes.md --latest=false"
echo "  (--latest=false: 같은 저장소의 장부 앱 '최신 릴리스' 표시를 건드리지 않음)"
