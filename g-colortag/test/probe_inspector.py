# Copyright (c) 2026 GRAYZONE. All rights reserved.
"""진단: 퀵타임 '동영상 속성' 창을 실제로 열어 캡처 (파일마다 inspector_<이름>.png)."""
import os
import shutil
import struct
import subprocess
import sys
import time

OUT = os.path.abspath(sys.argv[1])
os.makedirs(OUT, exist_ok=True)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import colortag as ct  # noqa: E402
import Quartz  # noqa: E402

SRC = "nullsrc=s=1280x720:d=2:r=24,geq=lum='16+55*floor(X/256)':cb=128:cr=128,format=yuv422p10le"
j = lambda n: os.path.join(OUT, n)  # noqa: E731


def ff(*a):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *a], check=True)


def patch(src, dst, vals):
    shutil.copy(src, dst)
    d = bytearray(open(dst, "rb").read())
    i = d.find(b"colrnclc")
    d[i + 8:i + 14] = struct.pack(">HHH", *vals)
    open(dst, "wb").write(bytes(d))


ff("-f", "lavfi", "-i", SRC, "-c:v", "prores_ks", "-profile:v", "1", "-color_primaries", "1", "-color_trc", "1",
   "-colorspace", "1", j("src.mov"))
subprocess.run(["avconvert", "-s", j("src.mov"), "-o", j("1_apple_111.mov"), "-p", "PresetAppleProRes422LPCM", "--replace"],
               check=True, capture_output=True)
shutil.move(ct.convert_file(j("1_apple_111.mov"), (1, 2, 1)), j("2_app_121.mov"))
patch(j("2_app_121.mov"), j("3_patched_131.mov"), (1, 3, 1))
patch(j("2_app_121.mov"), j("4_patched_101.mov"), (1, 0, 1))
os.remove(j("src.mov"))


def osa(script):
    return subprocess.run(["osascript", "-e", script], capture_output=True, text=True)


def windows():
    return [w for w in Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID) or []
            if w.get("kCGWindowOwnerName") == "QuickTime Player" and w.get("kCGWindowLayer", 9) <= 3]


def shot(number, path):
    img = Quartz.CGWindowListCreateImage(Quartz.CGRectNull, Quartz.kCGWindowListOptionIncludingWindow, number,
                                         Quartz.kCGWindowImageBoundsIgnoreFraming | Quartz.kCGWindowImageBestResolution)
    url = Quartz.CFURLCreateWithFileSystemPath(None, path, Quartz.kCFURLPOSIXPathStyle, False)
    d = Quartz.CGImageDestinationCreateWithURL(url, "public.png", 1, None)
    Quartz.CGImageDestinationAddImage(d, img, None)
    Quartz.CGImageDestinationFinalize(d)


for name in sorted(f for f in os.listdir(OUT) if f.endswith(".mov")):
    print("■", name, ct.describe(j(name)), flush=True)
    subprocess.run(["open", "-a", "QuickTime Player", j(name)])
    time.sleep(4)
    osa('tell application "QuickTime Player" to activate')
    r = osa('tell application "System Events" to keystroke "i" using command down')
    if r.returncode:
        print("   속성 창 열기 실패:", r.stderr.strip()[:200])
    time.sleep(3)
    # 접근성 권한이 있으면 속성 창의 글자도 읽음
    r = osa('tell application "System Events" to tell process "QuickTime Player" to get value of every static text of every window')
    print("   창 글자:", (r.stdout.strip() or r.stderr.strip())[:900])
    for k, w in enumerate(windows()):
        shot(w["kCGWindowNumber"], j(f"inspector_{name[:-4]}_{k}.png"))
    subprocess.run(["killall", "QuickTime Player"], capture_output=True)
    time.sleep(2)
