# Copyright (c) 2026 GRAYZONE. All rights reserved.
"""진단: 퀵타임 '동영상 속성'의 '지정 안 됨' / '태그가 달리지 않음' 문구가 어떤 조건의 값인지 찾는다."""
import glob
import os
import plistlib
import subprocess

QT = "/System/Applications/QuickTime Player.app"
print("QuickTime:", subprocess.run(["defaults", "read", QT + "/Contents/Info", "CFBundleShortVersionString"],
                                    capture_output=True, text=True).stdout.strip())
want = ("지정 안 됨", "태그가 달리지 않음", "코드 포인트", "전송 기능")
roots = [QT] + glob.glob("/System/Library/PrivateFrameworks/*Media*.framework") + \
    glob.glob("/System/Library/Frameworks/AV*.framework") + glob.glob("/System/Library/PrivateFrameworks/*Video*.framework")
seen = 0
for root in roots:
    for f in glob.glob(root + "/**/ko.lproj/*", recursive=True) + glob.glob(root + "/**/*.loctable", recursive=True):
        try:
            d = plistlib.load(open(f, "rb"))
        except Exception:
            continue
        if f.endswith(".loctable"):
            d = d.get("ko", {}) if isinstance(d, dict) else {}
        for k, v in (d.items() if isinstance(d, dict) else []):
            if isinstance(v, str) and any(w in v for w in want):
                print(f"{os.path.relpath(f, '/System')}: {k!r} = {v!r}")
                seen += 1
print("찾은 문구", seen)

import Quartz  # noqa: E402  (CoreVideo 함수)
for name in ("CVTransferFunctionGetStringForIntegerCodePoint", "CVColorPrimariesGetStringForIntegerCodePoint"):
    fn = getattr(Quartz, name, None)
    if fn:
        print(name, {i: fn(i) for i in range(0, 4)})
fn = getattr(Quartz, "CVTransferFunctionGetIntegerCodePointForString", None)
if fn:
    for s in ("ITU_R_709_2", "Unspecified", "TransferFunction#2", "Unknown"):
        try:
            print("코드포인트", s, "→", fn(s))
        except Exception as e:
            print("코드포인트", s, "실패", e)
