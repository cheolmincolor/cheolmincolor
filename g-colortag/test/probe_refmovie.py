# Copyright (c) 2026 GRAYZONE. All rights reserved.
"""실험: 참조 파일(refmovie.py)이 실제 맥의 퀵타임 엔진(AVFoundation)에서 실제 저장본과 똑같이 재생되는지.

원본마다 1-2-1, 1-1-1 두 가지에 대해
  실제 저장본(colortag.convert_file)  ↔  참조 파일 A(우리가 쓴 'url ' 데이터 참조)  ↔  참조 파일 B(애플이 쓴 머리 + 태그만 고침)
을 만들고, 각각
  - 열리는지 / 재생 가능한지 / 영상·소리 트랙 수 / 길이 / 크기
  - 퀵타임 속성 창에 쓰이는 색 정보 (프라이머리·전송 기능·매트릭스·감마)
  - 1초 지점 프레임의 회색 막대 밝기 (색 관리를 거친 sRGB 값) — 실제 저장본과의 차이
를 적는다.
사용: python3 probe_refmovie.py <출력 폴더>   (ffmpeg, avconvert, pyobjc AVFoundation/Quartz 필요)
"""
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import colortag as ct  # noqa: E402
import refmovie  # noqa: E402

import AVFoundation as AV  # noqa: E402
import CoreMedia as CM  # noqa: E402
import Quartz  # noqa: E402
from Foundation import NSURL, NSDate, NSRunLoop  # noqa: E402

OUT = os.path.abspath(sys.argv[1])
os.makedirs(OUT, exist_ok=True)
j = lambda n: os.path.join(OUT, n)  # noqa: E731
BARS = "nullsrc=s=1280x720:d=3:r=24,geq=lum='16+55*floor(X/256)':cb=128:cr=128"


def ff(*a):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *a], check=True)


def spin(sec):
    NSRunLoop.currentRunLoop().runUntilDate_(NSDate.dateWithTimeIntervalSinceNow_(sec))


def info(path):
    """(요약 글자, 막대 밝기 5개 또는 None)"""
    url = NSURL.fileURLWithPath_(path)
    asset = AV.AVURLAsset.URLAssetWithURL_options_(url, None)
    vt = asset.tracksWithMediaType_(AV.AVMediaTypeVideo)
    at = asset.tracksWithMediaType_(AV.AVMediaTypeAudio)
    if not vt:
        return f"영상 트랙 없음 (재생 가능 {bool(asset.isPlayable())})", None
    tr = vt[0]
    fds = tr.formatDescriptions()
    e = (CM.CMFormatDescriptionGetExtensions(fds[0]) or {}) if fds else {}
    g = lambda k: (str(e[k]).replace("ITU_R_", "") if k in e and e[k] is not None else "-")  # noqa: E731
    size = tr.naturalSize()
    dur = CM.CMTimeGetSeconds(asset.duration())
    gamma = g("CVImageBufferGammaLevel")
    txt = (f"재생가능 {bool(asset.isPlayable())} · 영상 {len(vt)} 소리 {len(at)} · {size.width:.0f}×{size.height:.0f} · {dur:.2f}초 · "
           f"색 {g('CVImageBufferColorPrimaries')}/{g('CVImageBufferTransferFunction')}/{g('CVImageBufferYCbCrMatrix')}"
           f"{' 감마 ' + gamma[:4] if gamma != '-' else ''}")
    # 플레이어에 올려 재생 준비가 되는지 (데이터 위치를 실제로 따라가는지)
    item = AV.AVPlayerItem.playerItemWithAsset_(asset)
    player = AV.AVPlayer.playerWithPlayerItem_(item)
    t0 = time.time()
    while item.status() == 0 and time.time() - t0 < 8:
        spin(0.1)
    st = {0: "모름", 1: "준비됨", 2: "실패"}[item.status()]
    txt += f" · 플레이어 {st}"
    if item.status() == 2 and item.error() is not None:
        txt += f" ({str(item.error().localizedDescription())[:60]})"
    del player
    # 1초 지점 프레임 → sRGB 로 그려 막대 밝기
    gen = AV.AVAssetImageGenerator.assetImageGeneratorWithAsset_(asset)
    gen.setRequestedTimeToleranceBefore_(CM.kCMTimeZero)
    gen.setRequestedTimeToleranceAfter_(CM.kCMTimeZero)
    res = gen.copyCGImageAtTime_actualTime_error_(CM.CMTimeMakeWithSeconds(1.0, 600), None, None)
    img = res[0] if isinstance(res, tuple) else res
    if img is None:
        return txt + " · 프레임 읽기 실패", None
    w, h = 640, 360
    ctx = Quartz.CGBitmapContextCreate(None, w, h, 8, w * 4, Quartz.CGColorSpaceCreateWithName(Quartz.kCGColorSpaceSRGB),
                                       Quartz.kCGImageAlphaPremultipliedLast)
    Quartz.CGContextDrawImage(ctx, Quartz.CGRectMake(0, 0, w, h), img)
    data = bytes(Quartz.CGDataProviderCopyData(Quartz.CGImageGetDataProvider(Quartz.CGBitmapContextCreateImage(ctx))))
    bars = []
    for i in range(5):
        x, y = int(w * (i + 0.5) / 5), h // 2
        o = (y * w + x) * 4
        bars.append(round(sum(data[o:o + 3]) / 3, 1))
    return txt, bars


def apple_header(src, dst):
    """애플 AVFoundation 으로 '참조 머리 파일' 쓰기 (영상 데이터는 원본을 가리킴)."""
    try:
        mm, err = AV.AVMutableMovie.movieWithURL_options_error_(NSURL.fileURLWithPath_(src), None, None)
        if mm is None:
            return f"AVMutableMovie 열기 실패 {err}"
        ok, err = mm.writeMovieHeaderToURL_fileType_options_error_(NSURL.fileURLWithPath_(dst), AV.AVFileTypeQuickTimeMovie, 0, None)
        return None if ok else f"머리 쓰기 실패 {err}"
    except Exception as ex:
        return f"예외 {ex}"


# ---- 원본 만들기 (모두 1-1-1, 소리 포함)
h264 = j("h264_mp4.mp4")
ff("-f", "lavfi", "-i", BARS, "-f", "lavfi", "-i", "sine=d=3", "-c:v", "libx264", "-crf", "1", "-pix_fmt", "yuv420p",
   "-color_primaries", "1", "-color_trc", "1", "-colorspace", "1", "-c:a", "aac", "-shortest", h264)
srcs = [h264]
p422 = j("apple_prores422.mov")
r = subprocess.run(["avconvert", "-s", h264, "-o", p422, "-p", "PresetAppleProRes422LPCM", "--replace"], capture_output=True, text=True)
if r.returncode == 0 and os.path.exists(p422):
    srcs.append(p422)
else:
    print("avconvert 실패:", r.stderr.strip()[:200])
p4444 = j("prores4444_12bit.mov")
ff("-f", "lavfi", "-i", BARS, "-f", "lavfi", "-i", "sine=d=3", "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuv444p12le",
   "-color_primaries", "1", "-color_trc", "1", "-colorspace", "1", "-c:a", "pcm_s24le", "-shortest", p4444)
srcs.append(p4444)
hevc = j("hevc.mov")
try:
    ff("-f", "lavfi", "-i", BARS, "-f", "lavfi", "-i", "sine=d=3", "-c:v", "libx265", "-crf", "8", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1",
       "-color_primaries", "1", "-color_trc", "1", "-colorspace", "1", "-c:a", "aac", "-shortest", hevc)
    srcs.append(hevc)
except Exception as ex:
    print("HEVC 원본 만들기 실패:", ex)
spaced = j("한글 이름 과 공백.mov")  # 경로에 한글·공백
ff("-i", p4444, "-c", "copy", spaced)
srcs.append(spaced)

print(subprocess.run(["sw_vers"], capture_output=True, text=True).stdout.replace("\n", " "))
score = {"A": [0, 0], "B": [0, 0]}
for s in srcs:
    base = os.path.splitext(os.path.basename(s))[0]
    print(f"\n■ 원본 {os.path.basename(s)} ({os.path.getsize(s) // 1024}KB)\n   원본: {info(s)[0]}")
    for tag in ((1, 2, 1), (1, 1, 1)):
        name = "-".join(map(str, tag))
        try:
            real = ct.convert_file(s, tag) if ct.read_tracks(s)[0]["tag"] != tag else s
        except Exception as ex:
            print(f"   [{name}] 실제 저장 실패: {ex}")
            continue
        rt, rb = info(real)
        print(f"   [{name}] 실제 저장본: {rt}\n            막대 {rb}")
        variants = []
        a = j(f"refA_{base}_{name}.mov")
        t0 = time.time()
        refmovie.make_reference(s, a, tag)
        variants.append(("A", a, time.time() - t0))
        hdr = j(f"hdr_{base}.mov")
        err = apple_header(s, hdr)
        if err:
            print(f"   [{name}] 참조 B: {err}")
        else:
            b = j(f"refB_{base}_{name}.mov")
            t0 = time.time()
            refmovie.make_reference(s, b, tag, moov_from=hdr, keep_dref=True)
            variants.append(("B", b, time.time() - t0))
        for kind, path, sec in variants:
            t, bars = info(path)
            same_meta = t.split(" · 플레이어")[0] == rt.split(" · 플레이어")[0]
            diff = max(abs(x - y) for x, y in zip(bars, rb)) if bars and rb else None
            good = same_meta and diff is not None and diff <= 1 and "준비됨" in t
            score[kind][0] += good
            score[kind][1] += 1
            print(f"   [{name}] 참조 {kind} ({os.path.getsize(path)}B, {sec * 1000:.0f}ms): {'✅' if good else '❌'} {t}\n"
                  f"            막대 {bars}  실제 저장본과 차이 {diff}  정보 일치 {same_meta}")
print(f"\n결과: 참조 A {score['A'][0]}/{score['A'][1]} 일치 · 참조 B {score['B'][0]}/{score['B'][1]} 일치")
