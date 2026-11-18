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


def colr_first(src, dst):
    """샘플 설명 안에서 fiel 과 colr 의 순서를 바꿈 (colr 를 맨 앞으로)."""
    d = bytearray(open(src, "rb").read())
    c = d.find(b"colrnclc") - 4
    f = d.rfind(b"fiel", 0, c) - 4
    fsz = struct.unpack(">I", d[f:f + 4])[0]
    csz = struct.unpack(">I", d[c:c + 4])[0]
    assert f + fsz == c, "fiel 바로 뒤에 colr 가 아님"
    d[f:c + csz] = d[c:c + csz] + d[f:f + fsz]
    open(dst, "wb").write(bytes(d))


colr_first(j("2_app_121.mov"), j("5_app_121_colrfirst.mov"))


def to_nclx(src, dst, vals, full=0):
    """nclc(18B) colr 를 nclx(19B)로 바꾸고 감싸는 박스 크기를 1씩 늘림 (moov 가 mdat 뒤일 때만 안전)."""
    (c, chain), = ct.colr_boxes(src)
    d = bytearray(open(src, "rb").read())
    for a in chain:
        d[a:a + 4] = struct.pack(">I", struct.unpack(">I", d[a:a + 4])[0] + 1)
    d[c:c + 18] = struct.pack(">I4s4sHHHB", 19, b"colr", b"nclx", *vals, full << 7)
    open(dst, "wb").write(bytes(d))


def drop_colr(src, dst):
    """colr 아톰 이름을 free 로 바꿔 없앰 (크기 그대로)."""
    d = bytearray(open(src, "rb").read())
    c = d.find(b"colrnclc")
    d[c:c + 4] = b"free"
    open(dst, "wb").write(bytes(d))


def headers(src, dst, trc):
    """모든 ProRes 프레임 헤더의 전송 기능 바이트를 trc 로 (리먹스 없이 제자리)."""
    d = bytearray(open(src, "rb").read())
    i, n = 0, 0
    while True:
        i = d.find(b"icpf", i)
        if i < 0:
            break
        d[i + 4 + 15] = trc
        i += 4
        n += 1
    open(dst, "wb").write(bytes(d))
    return n


patch(j("1_apple_111.mov"), j("A_apple_inplace_121.mov"), (1, 2, 1))          # 애플 원본 colr 만 제자리 수정
print("헤더 수정 프레임", headers(j("A_apple_inplace_121.mov"), j("B_apple_inplace_121_hdr2.mov"), 2))
headers(j("1_apple_111.mov"), j("C_apple_hdr2_only.mov"), 2)
def gama(src, dst, trc, g):
    """감마 표시(gama 아톰)를 넣어 다시 씀 (스트림 복사)."""
    ff("-i", src, "-c", "copy", "-color_primaries", "1", "-color_trc", str(trc), "-colorspace", "1",
       "-movflags", "+write_colr+write_gama", "-mov_gamma", str(g), dst)


gama(j("1_apple_111.mov"), j("G1_121_gama24.mov"), 2, 2.4)
gama(j("1_apple_111.mov"), j("G2_121_gama22.mov"), 2, 2.2)
gama(j("1_apple_111.mov"), j("G3_111_gama24.mov"), 1, 2.4)
gama(j("1_apple_111.mov"), j("G4_121_gama196.mov"), 2, 1.961)
to_nclx(j("2_app_121.mov"), j("6_nclx_121.mov"), (1, 2, 1))
drop_colr(j("2_app_121.mov"), j("7_nocolr_head121.mov"))
ff("-f", "lavfi", "-i", SRC.replace("yuv422p10le", "yuv420p"), "-c:v", "libx264", "-pix_fmt", "yuv420p",
   "-color_primaries", "1", "-color_trc", "2", "-colorspace", "1", j("h_tmp.mov"))
drop_colr(j("h_tmp.mov"), j("8_h264_vui121_nocolr.mov"))
shutil.move(j("h_tmp.mov"), j("9_h264_colr121.mov"))
os.remove(j("src.mov"))


def ax_text():
    """접근성 API 로 퀵타임의 모든 창 글자를 읽음."""
    try:
        import AppKit
        import ApplicationServices as AS
        pid = int(subprocess.run(["pgrep", "-x", "QuickTime Player"], capture_output=True, text=True).stdout.split()[0])
        root = AS.AXUIElementCreateApplication(pid)
        out = []

        def get(el, attr):
            err, v = AS.AXUIElementCopyAttributeValue(el, attr, None)
            return v if err == 0 else None

        def walk(el, depth=0):
            if depth > 30 or len(out) > 400:
                return
            for attr in ("AXValue", "AXTitle"):
                v = get(el, attr)
                if isinstance(v, str) and v.strip():
                    out.append(v.strip())
            for ch in get(el, "AXChildren") or []:
                walk(ch, depth + 1)
        def expand(el, depth=0):  # 접힌 'Video Details' 펼치기
            if depth > 30:
                return
            if get(el, "AXRole") == "AXDisclosureTriangle" and get(el, "AXValue") in (0, False):
                AS.AXUIElementPerformAction(el, "AXPress")
            for ch in get(el, "AXChildren") or []:
                expand(ch, depth + 1)
        for w in get(root, "AXWindows") or []:
            expand(w)
        time.sleep(1)
        for w in get(root, "AXWindows") or []:
            walk(w)
        return " | ".join(out)
    except Exception as e:
        return f"AX 실패 {e}"


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


for name in sorted(f for f in os.listdir(OUT) if f.endswith(".mov") and f[0] in "12G"):
    print("■", name, ct.describe(j(name)), flush=True)
    subprocess.run(["open", "-a", "QuickTime Player", j(name)])
    time.sleep(4)
    osa('tell application "QuickTime Player" to activate')
    if "Inspector" not in ax_text():
        osa('tell application "System Events" to keystroke "i" using command down')
    time.sleep(3)
    script = """tell application "System Events" to tell process "QuickTime Player"
  set out to ""
  repeat with w in windows
    if true then
      repeat with e in (entire contents of w)
        try
          set v to value of e
          if v is not missing value and (v as text) is not "" then set out to out & (v as text) & " | "
        end try
        try
          set d to description of e
          if d is not missing value and d is not "" and d is not "text" and d is not "group" then set out to out & "{" & d & "} "
        end try
      end repeat
    end if
  end repeat
  return out
end tell"""
    print("   속성 창:", ax_text()[:2500], flush=True)
    r2 = osa('tell application "System Events" to tell process "QuickTime Player" to get {name, class} of every UI element of every window')
    print("   창 구성:", (r2.stdout.strip() or r2.stderr.strip())[:600], flush=True)
    for k, w in enumerate(windows()):
        shot(w["kCGWindowNumber"], j(f"inspector_{name[:-4]}_{k}.png"))
    subprocess.run(["killall", "QuickTime Player"], capture_output=True)
    time.sleep(2)
