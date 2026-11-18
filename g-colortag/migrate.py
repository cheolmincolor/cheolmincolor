# Copyright (c) 2026 GRAYZONE. All rights reserved.
"""이름 바꾸기 도우미: G-ColorTag → G-Retag.

예전 G-ColorTag(3.5.0 이하)의 자동 업데이트는 새 앱을 예전 자리(…/G-ColorTag.app)에 넣는다.
앱 실행기(Contents/MacOS/G-Retag)가 파이썬 앱을 띄우기 전에 이 스크립트를 부르고,
  1) 지금 앱이 G-ColorTag.app 이면 같은 폴더의 G-Retag.app 으로 이름을 바꾸고
  2) 같은 폴더에 예전 G-ColorTag.app 이 따로 남아 있으면(DMG 로 새로 설치한 경우) 휴지통으로 옮긴다.
     (같은 앱(번들 ID)이고 버전이 같거나 낮을 때만. 지우지 않고 휴지통으로 옮기므로 되돌릴 수 있음)
이름을 바꿨으면 새 경로를 출력한다 → 실행기가 그 경로로 다시 실행한다.
문제가 생기면 아무것도 하지 않고 그대로 실행되게 한다 (앱 실행을 막지 않음).

사용: python migrate.py <지금 앱 경로(.app)>
"""
import os
import plistlib
import shutil
import sys
import time

NEW, OLD = "G-Retag.app", "G-ColorTag.app"
BUNDLE_ID = "local.colortag"   # 이름을 바꿔도 번들 ID 는 그대로 (같은 앱)
TRASH = os.path.expanduser(os.environ.get("GCT_TRASH", "~/.Trash"))


def info(app):
    try:
        with open(os.path.join(app, "Contents", "Info.plist"), "rb") as f:
            p = plistlib.load(f)
        return p.get("CFBundleIdentifier"), p.get("CFBundleShortVersionString", "")
    except Exception:
        return None, ""


def vtuple(v):
    try:
        return tuple(int(x) for x in str(v).split("."))
    except ValueError:
        return ()


def to_trash(path, log):
    os.makedirs(TRASH, exist_ok=True)
    base = os.path.basename(path)
    dst = os.path.join(TRASH, base)
    if os.path.exists(dst):
        dst = os.path.join(TRASH, f"{base[:-4]} {time.strftime('%H.%M.%S')}.app")
    shutil.move(path, dst)
    log(f"휴지통으로 옮김: {path} → {dst}")


def migrate(app, log=lambda *a: print(*a, file=sys.stderr)):
    app = os.path.abspath(app.rstrip("/"))
    folder, name = os.path.split(app)
    me_id, me_ver = info(app)
    if me_id != BUNDLE_ID or not os.access(folder, os.W_OK):
        return None
    new, old = os.path.join(folder, NEW), os.path.join(folder, OLD)

    def same_or_older(other):
        oid, over = info(other)
        return oid == BUNDLE_ID and vtuple(over) <= vtuple(me_ver)

    if name == OLD:  # 예전 앱의 자동 업데이트로 예전 자리에 들어온 새 앱
        if os.path.lexists(new):
            if not same_or_older(new):
                log("같은 폴더에 G-Retag.app 이 있어 이름을 바꾸지 않음")
                return None
            to_trash(new, log)
        os.rename(app, new)
        log(f"이름 바꿈: {app} → {new}")
        return new
    if name == NEW and os.path.isdir(old) and same_or_older(old):  # DMG 로 새로 설치: 예전 앱 정리
        to_trash(old, log)
    return None


def main():
    if os.environ.get("GRETAG_MIGRATED") == "1":  # 이미 한 번 했음 (무한 반복 방지)
        return
    try:
        out = migrate(sys.argv[1])
    except Exception as e:  # 실패해도 앱은 그대로 실행
        print("migrate 실패:", e, file=sys.stderr)
        out = None
    old_cache = os.path.expanduser("~/Library/Caches/G-ColorTag")  # 예전 업데이트 임시 폴더
    if sys.platform == "darwin" and os.path.isdir(old_cache):
        shutil.rmtree(old_cache, ignore_errors=True)
    if out:
        print(out)


if __name__ == "__main__":
    main()
