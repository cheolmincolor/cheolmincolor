# Copyright (c) 2026 GRAYZONE. All rights reserved.
"""실험: 애플 AVFoundation 으로 태그를 바꿔 써서 퀵타임 속성 창에 '지정 안 됨 (1-2-1)'이 나오는 방식을 찾는다.

원본(애플 ProRes 422, 1-1-1)의 포맷 설명에서 전송 기능 값만 바꾼 뒤
(1) AVMutableMovie + 내보내기(패스스루), (2) AVAssetWriter 패스스루 로 새 파일을 쓴다.
결과 파일은 <출력 폴더>/X_*.mov — 다음 단계(probe_inspector.py)가 퀵타임 속성 창으로 읽는다.
사용: python3 probe_avf.py <출력 폴더>
"""
import os
import subprocess
import sys
import time

OUT = os.path.abspath(sys.argv[1])
os.makedirs(OUT, exist_ok=True)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import AVFoundation as AV  # noqa: E402
import CoreMedia as CM  # noqa: E402
from Foundation import NSURL  # noqa: E402

import colortag as ct  # noqa: E402

j = lambda n: os.path.join(OUT, n)  # noqa: E731
SRC = "nullsrc=s=1280x720:d=2:r=24,geq=lum='16+55*floor(X/256)':cb=128:cr=128,format=yuv422p10le"
subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", SRC, "-c:v", "prores_ks", "-profile:v", "1",
                "-color_primaries", "1", "-color_trc", "1", "-colorspace", "1", j("avf_src_tmp.mov")], check=True)
subprocess.run(["avconvert", "-s", j("avf_src_tmp.mov"), "-o", j("avf_src.mov"), "-p", "PresetAppleProRes422LPCM",
                "--replace"], check=True, capture_output=True)
os.remove(j("avf_src_tmp.mov"))
src_url = NSURL.fileURLWithPath_(j("avf_src.mov"))


def new_fd(fd, transfer, keep_verbatim):
    ext = dict(CM.CMFormatDescriptionGetExtensions(fd) or {})
    if not keep_verbatim:
        ext.pop("VerbatimSampleDescription", None)
        ext.pop("VerbatimISOSampleEntry", None)
    if transfer is None:
        ext.pop("CVImageBufferTransferFunction", None)
    else:
        ext["CVImageBufferTransferFunction"] = transfer
    dim = CM.CMVideoFormatDescriptionGetDimensions(fd)
    err, out = CM.CMVideoFormatDescriptionCreate(None, CM.CMFormatDescriptionGetMediaSubType(fd), dim.width, dim.height,
                                                 ext, None)
    if err:
        raise RuntimeError(f"포맷 설명 만들기 실패 {err}")
    return out


def wait(cond, sec=60):
    t0 = time.time()
    while not cond() and time.time() - t0 < sec:
        time.sleep(0.1)


def via_movie(name, transfer, keep_verbatim):
    """AVMutableMovie 에서 포맷 설명을 바꾸고 패스스루로 내보냄."""
    movie = AV.AVMutableMovie.movieWithURL_options_(src_url, None)
    tr = movie.tracksWithMediaType_(AV.AVMediaTypeVideo)[0]
    fd = tr.formatDescriptions()[0]
    tr.replaceFormatDescription_withFormatDescription_(fd, new_fd(fd, transfer, keep_verbatim))
    dst = j(name)
    if os.path.exists(dst):
        os.remove(dst)
    ex = AV.AVAssetExportSession.alloc().initWithAsset_presetName_(movie, AV.AVAssetExportPresetPassthrough)
    ex.setOutputURL_(NSURL.fileURLWithPath_(dst))
    ex.setOutputFileType_(AV.AVFileTypeQuickTimeMovie)
    ex.exportAsynchronouslyWithCompletionHandler_(lambda: None)
    wait(lambda: ex.status() in (3, 4, 5))
    return f"내보내기 상태 {ex.status()} {ex.error() or ''}"


def via_writer(name, transfer, keep_verbatim):
    """AVAssetWriter 패스스루 (원본 압축 데이터 그대로, 포맷 설명만 새 것)."""
    asset = AV.AVURLAsset.URLAssetWithURL_options_(src_url, None)
    tr = asset.tracksWithMediaType_(AV.AVMediaTypeVideo)[0]
    hint = new_fd(tr.formatDescriptions()[0], transfer, keep_verbatim)
    reader, err = AV.AVAssetReader.alloc().initWithAsset_error_(asset, None)
    rout = AV.AVAssetReaderTrackOutput.alloc().initWithTrack_outputSettings_(tr, None)
    reader.addOutput_(rout)
    dst = j(name)
    if os.path.exists(dst):
        os.remove(dst)
    writer, err = AV.AVAssetWriter.alloc().initWithURL_fileType_error_(NSURL.fileURLWithPath_(dst),
                                                                         AV.AVFileTypeQuickTimeMovie, None)
    win = AV.AVAssetWriterInput.alloc().initWithMediaType_outputSettings_sourceFormatHint_(AV.AVMediaTypeVideo, None, hint)
    writer.addInput_(win)
    reader.startReading()
    writer.startWriting()
    writer.startSessionAtSourceTime_(CM.kCMTimeZero)
    while True:
        if not win.isReadyForMoreMediaData():
            time.sleep(0.01)
            continue
        sb = rout.copyNextSampleBuffer()
        if sb is None:
            break
        win.appendSampleBuffer_(sb)
    win.markAsFinished()
    done = []
    writer.finishWritingWithCompletionHandler_(lambda: done.append(1))
    wait(lambda: done)
    return f"쓰기 상태 {writer.status()} {writer.error() or ''}"


CASES = [
    ("TransferFunction#2", True), ("TransferFunction#2", False),
    ("Unspecified", False), ("Unknown", False),
    (None, False),  # 전송 기능 키 없음 (대조군)
]
for i, (tf, keep) in enumerate(CASES):
    tag = (tf or "none").replace("TransferFunction#", "tf").lower()
    for how, fn in (("movie", via_movie), ("writer", via_writer)):
        name = f"X{i}_{how}_{tag}_{'verb' if keep else 'clean'}.mov"
        try:
            msg = fn(name, tf, keep)
        except Exception as e:
            msg = f"실패 {e}"
        if os.path.exists(j(name)):
            a = AV.AVURLAsset.URLAssetWithURL_options_(NSURL.fileURLWithPath_(j(name)), None)
            e = CM.CMFormatDescriptionGetExtensions(a.tracksWithMediaType_(AV.AVMediaTypeVideo)[0].formatDescriptions()[0]) or {}
            msg += f" | 다시 읽은 전송 기능 = {e.get('CVImageBufferTransferFunction')} | 아톰 {ct.describe(j(name))}"
        print(f"■ {name}: {msg}", flush=True)
os.remove(j("avf_src.mov"))
