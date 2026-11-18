# Copyright (c) 2026 GRAYZONE. All rights reserved.
"""최종 확인: 앱이 저장한 파일을 실제 퀵타임 플레이어로 열어 '동영상 속성' 창의 글자를 읽는다.

1-2-1 저장본 → 전송 기능 '지정 안 됨'(Unspecified), 코드 포인트 '(1-2-1)'
1-1-1 저장본 → 전송 기능 'ITU-R BT.709', 코드 포인트 '(1-1-1)'
원본: 애플 ProRes 422(avconvert), ProRes 4444 12비트, H.264 MP4.
사용: python3 mac_inspector_check.py <G-ColorTag.app> <출력 폴더>   (pyobjc ApplicationServices 필요)
"""
import os
import shutil
import subprocess
import sys
import time

APPDIR, OUT = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
RES = os.path.join(APPDIR, "Contents", "Resources")
sys.path.insert(0, RES)
os.environ["PATH"] = os.path.join(RES, "bin") + ":" + os.environ.get("PATH", "/usr/bin:/bin")
os.makedirs(OUT, exist_ok=True)
import colortag as ct  # noqa: E402  (앱에 든 것 그대로, ffmpeg 도 앱에 든 것)

SRC = "nullsrc=s=1280x720:d=2:r=24,geq=lum='16+55*floor(X/256)':cb=128:cr=128,format=yuv422p10le"
j = lambda n: os.path.join(OUT, n)  # noqa: E731


def ff(*a):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *a], check=True)


def osa(script):
    return subprocess.run(["osascript", "-e", script], capture_output=True, text=True)


def ax_text():
    """접근성 API 로 퀵타임의 모든 창 글자를 읽음 (접힌 '비디오 세부사항'은 펼침)."""
    import ApplicationServices as AS
    pid = int(subprocess.run(["pgrep", "-x", "QuickTime Player"], capture_output=True, text=True).stdout.split()[0])
    root = AS.AXUIElementCreateApplication(pid)

    def get(el, attr):
        err, v = AS.AXUIElementCopyAttributeValue(el, attr, None)
        return v if err == 0 else None

    def expand(el, depth=0):
        if depth > 30:
            return
        if get(el, "AXRole") == "AXDisclosureTriangle" and get(el, "AXValue") in (0, False):
            AS.AXUIElementPerformAction(el, "AXPress")
        for ch in get(el, "AXChildren") or []:
            expand(ch, depth + 1)

    out = []

    def walk(el, depth=0):
        if depth > 30 or len(out) > 400:
            return
        for attr in ("AXValue", "AXTitle"):
            v = get(el, attr)
            if isinstance(v, str) and v.strip():
                out.append(v.strip())
        for ch in get(el, "AXChildren") or []:
            walk(ch, depth + 1)
    for w in get(root, "AXWindows") or []:
        expand(w)
    time.sleep(1)
    for w in get(root, "AXWindows") or []:
        walk(w)
    return " | ".join(out)


def inspector(path):
    subprocess.run(["killall", "QuickTime Player"], capture_output=True)
    time.sleep(1.5)
    subprocess.run(["open", "-a", "QuickTime Player", path])
    time.sleep(4)
    osa('tell application "QuickTime Player" to activate')
    if "Inspector" not in ax_text() and "속성" not in ax_text():
        osa('tell application "System Events" to keystroke "i" using command down')
    time.sleep(3)
    text = ax_text()
    subprocess.run(["killall", "QuickTime Player"], capture_output=True)
    pick = lambda label: (text.split(label + ": | ", 1)[1].split(" | ")[0] if label + ": | " in text else "?")  # noqa: E731
    return pick("Transfer Function"), pick("Code Points")


ff("-f", "lavfi", "-i", SRC, "-c:v", "prores_ks", "-profile:v", "1", "-color_primaries", "1", "-color_trc", "1",
   "-colorspace", "1", j("tmp.mov"))
subprocess.run(["avconvert", "-s", j("tmp.mov"), "-o", j("apple_prores422.mov"), "-p", "PresetAppleProRes422LPCM",
                "--replace"], check=True, capture_output=True)
os.remove(j("tmp.mov"))
ff("-f", "lavfi", "-i", SRC, "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuv444p12le",
   "-color_primaries", "1", "-color_trc", "1", "-colorspace", "1", j("prores4444_12bit.mov"))
ff("-f", "lavfi", "-i", SRC.replace("yuv422p10le", "yuv420p"), "-c:v", "libx264", "-pix_fmt", "yuv420p",
   "-color_primaries", "1", "-color_trc", "1", "-colorspace", "1", j("h264.mp4"))

bad = 0
for src in ("apple_prores422.mov", "prores4444_12bit.mov", "h264.mp4"):
    out121 = ct.convert_file(j(src), (1, 2, 1))
    out111 = ct.convert_file(out121, (1, 1, 1))
    for path, want_tf, want_cp in ((out121, "Unspecified", "(1-2-1)"), (out111, "ITU-R BT.709", "(1-1-1)")):
        tf, cp = inspector(path)
        good = tf == want_tf and cp == want_cp
        bad += not good
        print(f"{'✅' if good else '❌'} {os.path.basename(path):34} 퀵타임 속성: 전송 기능 '{tf}' · 코드 포인트 '{cp}'"
              f"  (기대 '{want_tf}' · '{want_cp}') | {ct.describe(path)}", flush=True)
print("결과:", "모두 통과 ✅" if not bad else f"{bad}개 실패 ❌")
sys.exit(1 if bad else 0)
