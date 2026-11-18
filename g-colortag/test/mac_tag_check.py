# Copyright (c) 2026 GRAYZONE. All rights reserved.
"""실제 맥에서: 앱이 저장한 _1-2-1 파일을 퀵타임이 (1-2-1)로 읽는지 확인.

퀵타임 '동영상 속성'의 색상 프라이머리·전송 기능·YCbCr 매트릭스는 AVFoundation 포맷 설명의
색 확장값에서 나온다. 그 값을 직접 읽어 확인한다.
원본은 애플 ProRes 인코더(avconvert)로 만든 ProRes 422 / 4444 와 ffmpeg ProRes 4444 12비트·H.264.

사용: <앱>/Contents/MacOS/G-ColorTag-python -I -B test/mac_tag_check.py <G-ColorTag.app> <출력 폴더>
"""
import os
import subprocess
import sys

APPDIR, OUT = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
RES = os.path.join(APPDIR, "Contents", "Resources")
sys.path[:0] = [RES, os.path.join(RES, "site")]
os.environ["PATH"] = os.path.join(RES, "bin") + ":/usr/bin:/bin:/usr/sbin"
os.makedirs(OUT, exist_ok=True)
import AVFoundation as AV  # noqa: E402
import CoreMedia as CM  # noqa: E402
from Foundation import NSURL  # noqa: E402

import colortag as ct  # noqa: E402

SRC = "nullsrc=s=1280x720:d=2:r=24,geq=lum='16+55*floor(X/256)':cb=128:cr=128,format=yuv420p"
WANT = ("ITU_R_709_2", None, "ITU_R_709_2")  # (1-2-1): 전송 기능 지정 안 됨


def inspector(path):
    asset = AV.AVURLAsset.URLAssetWithURL_options_(NSURL.fileURLWithPath_(path), None)
    tr = asset.tracksWithMediaType_(AV.AVMediaTypeVideo)[0]
    fds = tr.formatDescriptions()
    e = CM.CMFormatDescriptionGetExtensions(fds[0]) or {}
    get = lambda k: (str(e[k]) if k in e and e[k] is not None else None)  # noqa: E731
    return (get("CVImageBufferColorPrimaries"), get("CVImageBufferTransferFunction"),
            get("CVImageBufferYCbCrMatrix")), {"gamma": get("CVImageBufferGammaLevel"), "n_fd": len(fds),
                                               "codec": CM.CMFormatDescriptionGetMediaSubType(fds[0])}


def atoms(path):
    """영상 샘플 설명 안의 자식 아톰 목록과 colr 값."""
    out = []
    with open(path, "rb") as f:
        size = os.path.getsize(path)
        hd = [None]

        def walk(s, e, parent=""):
            for t, b, end in ct._boxes(f, s, e):
                if t in ct.CONTAINERS:
                    walk(b, end, t)
                elif t == "hdlr" and parent == "mdia":
                    f.seek(b + 8)
                    hd[0] = f.read(4).decode("latin-1")
                elif t == "stsd" and hd[0] == "vide":
                    f.seek(b + 4)
                    for c, eb, ee in ct._boxes(f, b + 8, end):
                        kids = []
                        for k, kb, ke in ct._boxes(f, eb + 78, ee):
                            if k == "colr":
                                f.seek(kb)
                                kind = f.read(4).decode("latin-1")
                                kids.append(f"colr:{kind}:" + "-".join(str(int.from_bytes(f.read(2), 'big')) for _ in range(3)))
                            else:
                                kids.append(k)
                        out.append(f"{c}[{', '.join(kids)}]")
        walk(0, size)
    return " ".join(out)


def ff(*a):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *a], check=True)


h264 = os.path.join(OUT, "src_h264_111.mov")
ff("-f", "lavfi", "-i", SRC, "-c:v", "libx264", "-crf", "1", "-pix_fmt", "yuv420p",
   "-color_primaries", "1", "-color_trc", "1", "-colorspace", "1", h264)
srcs = [h264]
for preset, name in (("PresetAppleProRes422LPCM", "src_apple_prores422.mov"),
                     ("PresetAppleProRes4444LPCM", "src_apple_prores4444.mov")):
    dst = os.path.join(OUT, name)
    r = subprocess.run(["avconvert", "-s", h264, "-o", dst, "-p", preset, "--replace"], capture_output=True, text=True)
    if r.returncode == 0 and os.path.exists(dst):
        srcs.append(dst)
    else:
        print("avconvert 실패", preset, r.stderr.strip()[:200])
p4444 = os.path.join(OUT, "src_ffmpeg_prores4444_12bit.mov")
ff("-f", "lavfi", "-i", SRC, "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuv444p12le",
   "-color_primaries", "1", "-color_trc", "1", "-colorspace", "1", p4444)
srcs.append(p4444)

print(subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True).stdout.splitlines()[0])
bad = 0
for s in srcs:
    base = os.path.basename(s)
    print(f"■ {base}\n   원본 속성 {inspector(s)[0]} | 아톰 {atoms(s)}")
    try:
        out = ct.convert_file(s, (1, 2, 1))
    except Exception as e:
        print("   ❌ 변환 실패:", e)
        bad += 1
        continue
    got, extra = inspector(out)
    good = got == WANT
    bad += not good
    print(f"   {'✅' if good else '❌'} 저장본 속성 {got} {extra} | 아톰 {atoms(out)}")
print("결과:", "모두 (1-2-1) ✅" if not bad else f"{bad}개 실패 ❌")
sys.exit(1 if bad else 0)
