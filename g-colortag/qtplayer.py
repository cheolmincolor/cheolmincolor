# Copyright (c) 2026 GRAYZONE. All rights reserved.
"""퀵타임과 같은 엔진(AVFoundation)으로 미리보기를 그리는 네이티브 플레이어.

웹 화면(WKWebView) 아래에 AVPlayerLayer 를 깔고, 웹 화면의 영상 자리만 투명하게 비워 둔다.
버튼·타임라인은 웹 화면이 그대로 그리고, 영상은 퀵타임 플레이어와 같은 AVFoundation 이
파일의 색 태그(1-1-1 / 1-2-1)를 해석해 그린다.

화면(JS) ↔ 여기
  명령  POST /api/nv        [{"op": "create|src|play|pause|rate|seek|show|rect", "id": ..., "s": 순번, ...}]
  상태  GET  /api/nv_state  {"players": {id: {t, dur, paused, ended, ready, g, seq}}, "events": [...]}

SimBackend 는 맥이 아닌 곳에서 화면 로직을 시험하기 위한 가짜 플레이어 (시간만 흐름).
"""
import math
import threading
import time


CODE = {"ITU_R_709_2": 1, "SMPTE_C": 6, "EBU_3213": 5, "P22": 5, "ITU_R_2020": 9, "DCI_P3": 11, "P3_D65": 12,
        "SMPTE_240M_1995": 7, "ITU_R_601_4": 6, "IEC_sRGB": 13, "SMPTE_ST_2084_PQ": 16, "ITU_R_2100_HLG": 18,
        "Linear": 8, "UseGamma": 2}  # 감마 표시(gama)가 있으면 퀵타임은 전송 기능을 '지정 안 됨'(2)으로 표시


def quicktime_code(path):
    """퀵타임 '동영상 속성'의 코드 포인트를 같은 규칙으로 → '1-2-1' 같은 문자열. 맥 전용.

    실제 퀵타임 속성 창 확인 결과(macOS 26): 값이 없으면 '태그가 달리지 않음',
    감마 표시(UseGamma)면 '지정 안 됨'(2). 없는 값은 'untagged' 로 돌려줘 1-2-1 과 구분한다."""
    import AVFoundation as AV
    import CoreMedia as CM
    from Foundation import NSURL
    asset = AV.AVURLAsset.URLAssetWithURL_options_(NSURL.fileURLWithPath_(path), None)
    tracks = asset.tracksWithMediaType_(AV.AVMediaTypeVideo)
    if not tracks:
        return None
    e = CM.CMFormatDescriptionGetExtensions(tracks[0].formatDescriptions()[0]) or {}
    vals = []
    for k in ("CVImageBufferColorPrimaries", "CVImageBufferTransferFunction", "CVImageBufferYCbCrMatrix"):
        v = e.get(k)
        vals.append(str(CODE.get(str(v), v)) if v is not None else "untagged")
    return "-".join(vals)


class _Base:
    def __init__(self, resolve):
        self.resolve = resolve          # 미디어 주소 → 파일 경로
        self.lock = threading.Lock()
        self.events = []
        self.cache = {}

    def _event(self, pid, kind, **kw):
        with self.lock:
            self.events.append(dict(id=pid, type=kind, **kw))

    def snapshot(self):
        with self.lock:
            ev, self.events = self.events, []
            return {"players": dict(self.cache), "events": ev}


class AVBackend(_Base):
    """맥 전용. 모든 AppKit/AVFoundation 호출은 메인 스레드에서."""

    def __init__(self, webview, resolve):
        super().__init__(resolve)
        import AppKit  # noqa: F401
        import AVFoundation
        import CoreMedia
        import Quartz
        from PyObjCTools import AppHelper
        self.AV, self.CM, self.Q, self.AH, self.AK = AVFoundation, CoreMedia, Quartz, AppHelper, AppKit
        self.wv = webview
        self.players = {}
        for key, val in (("drawsBackground", False), ("drawsTransparentBackground", True)):
            try:  # 웹 화면 배경을 투명하게 → 아래의 영상이 보임
                webview.setValue_forKey_(val, key)
            except Exception:
                pass
        self._poll()

    # HTTP 스레드에서 호출 → 메인 스레드로 넘김
    def command(self, cmds):
        self.AH.callAfter(self._run, cmds)

    def _run(self, cmds):
        for c in cmds:
            try:
                self._one(c)
            except Exception as e:  # 명령 하나가 실패해도 나머지는 계속
                self._event(c.get("id"), "error", g=c.get("g"), msg=str(e)[:120])

    def _one(self, c):
        op, pid = c.get("op"), c.get("id")
        if op == "create":
            if pid not in self.players:
                self._create(pid)
            return
        p = self.players.get(pid)
        if not p:
            return
        p["seq"] = c.get("s", p["seq"])
        pl = p["player"]
        if op == "src":
            p.update(g=c.get("g"), loaded=False, failed=False, want=False)
            pl.pause()
            path = c.get("path")
            item = self.AV.AVPlayerItem.playerItemWithURL_(self.AK.NSURL.fileURLWithPath_(path)) if path else None
            pl.replaceCurrentItemWithPlayerItem_(item)
        elif op == "play":
            p["rate"] = float(c.get("rate") or 1)
            p["want"] = True
            pl.setRate_(p["rate"])
        elif op == "pause":
            p["want"] = False
            pl.pause()
        elif op == "rate":
            p["rate"] = float(c.get("rate") or 1)
            if p["want"]:
                pl.setRate_(p["rate"])
        elif op == "seek":
            n, g = c.get("n"), p["g"]
            when = self.CM.CMTimeMakeWithSeconds(float(c.get("t") or 0), 600)

            def done(finished, pid=pid, n=n, g=g, p=p):
                p["sn"] = n  # 이 이후 상태 보고는 찾아가기가 끝난 값
                self._event(pid, "seeked", n=n, g=g)
            pl.seekToTime_toleranceBefore_toleranceAfter_completionHandler_(
                when, self.CM.kCMTimeZero, self.CM.kCMTimeZero, done)
        elif op == "volume":
            v = float(c.get("v") or 0)
            pl.setMuted_(v <= 0)
            pl.setVolume_(max(0.0, min(1.0, v)))
        elif op == "show":
            p["view"].setHidden_(not c.get("on"))
        elif op == "rect":
            self._rect(p, c.get("r") or [0, 0, 0, 0], bool(c.get("round")))

    def _create(self, pid):
        AK, AV, Q = self.AK, self.AV, self.Q
        view = AK.NSView.alloc().initWithFrame_(AK.NSMakeRect(0, 0, 10, 10))
        view.setWantsLayer_(True)
        view.layer().setBackgroundColor_(Q.CGColorCreateGenericRGB(0, 0, 0, 1))
        player = AV.AVPlayer.alloc().init()
        player.setActionAtItemEnd_(1)  # AVPlayerActionAtItemEndPause
        player.setMuted_(True)         # 소리는 화면 쪽에서 켜라고 할 때만 (두 화면이 같이 재생되므로 한쪽만)
        try:
            player.setAutomaticallyWaitsToMinimizeStalling_(False)  # 로컬 파일: 바로 재생
        except Exception:
            pass
        layer = AV.AVPlayerLayer.playerLayerWithPlayer_(player)
        layer.setVideoGravity_(AV.AVLayerVideoGravityResizeAspect)
        layer.setFrame_(view.layer().bounds())
        layer.setAutoresizingMask_(Q.kCALayerWidthSizable | Q.kCALayerHeightSizable)
        view.layer().addSublayer_(layer)
        view.setHidden_(True)
        self.wv.addSubview_positioned_relativeTo_(view, AK.NSWindowBelow, None)  # 웹 화면 아래
        self.players[pid] = {"id": pid, "view": view, "player": player, "layer": layer, "g": None, "seq": 0,
                             "rate": 1.0, "want": False, "loaded": False, "failed": False}

    def _rect(self, p, r, rounded):
        x, y, w, h = (float(v) for v in r)
        if not self.wv.isFlipped():
            y = self.wv.bounds().size.height - y - h
        self.Q.CATransaction.begin()
        self.Q.CATransaction.setDisableActions_(True)
        p["view"].setFrame_(self.AK.NSMakeRect(x, y, w, h))
        lay = p["view"].layer()
        lay.setCornerRadius_(13.0 if rounded else 0.0)
        lay.setMasksToBounds_(rounded)
        try:  # 아래쪽 두 모서리만 둥글게 (패널 모양에 맞춤)
            lay.setMaskedCorners_(1 | 2)
        except Exception:
            pass
        self.Q.CATransaction.commit()

    def _poll(self):
        CM = self.CM
        new = {}
        for pid, p in self.players.items():
            st = {"g": p["g"], "seq": p["seq"], "sn": p.get("sn", 0), "ready": False, "t": 0.0, "dur": None, "paused": True, "ended": False}
            pl = p["player"]
            item = pl.currentItem()
            if item is not None:
                status = item.status()
                if status == 2 and not p["failed"]:  # AVPlayerItemStatusFailed
                    p["failed"] = True
                    self._event(pid, "error", g=p["g"])
                t = CM.CMTimeGetSeconds(pl.currentTime())
                dur = CM.CMTimeGetSeconds(item.duration())
                ready = status == 1 and bool(p["layer"].isReadyForDisplay())
                if ready and not p["loaded"]:
                    p["loaded"] = True
                    self._event(pid, "loadeddata", g=p["g"])
                ended = ready and not math.isnan(dur) and t >= dur - 0.001
                if ended:
                    p["want"] = False
                st.update(ready=ready, t=0.0 if math.isnan(t) else t,
                          dur=None if math.isnan(dur) or math.isinf(dur) else dur,
                          paused=pl.rate() == 0, ended=ended)
            new[pid] = st
        with self.lock:
            self.cache = new
        self.AH.callLater(1 / 30, self._poll)


class SimBackend(_Base):
    """테스트용 가짜 플레이어: 실제 영상 대신 시간만 흐른다."""

    def __init__(self, resolve, duration_of):
        super().__init__(resolve)
        self.duration_of = duration_of
        self.p = {}
        threading.Thread(target=self._loop, daemon=True).start()

    def command(self, cmds):
        now = time.monotonic()
        with self.lock:
            for c in cmds:
                op, pid = c.get("op"), c.get("id")
                if op == "create":
                    self.p.setdefault(pid, {"g": None, "seq": 0, "path": None, "base": 0.0, "t0": now, "rate": 1.0,
                                            "playing": False, "ready_at": None, "loaded": False, "dur": None,
                                            "seeks": [], "shown": False, "rect": None, "sn": 0})
                    continue
                s = self.p.get(pid)
                if not s:
                    continue
                s["seq"] = c.get("s", s["seq"])
                cur = self._t(s, now)
                if op == "src":
                    path = c.get("path")
                    s.update(g=c.get("g"), path=path, base=0.0, t0=now, playing=False, loaded=False, seeks=[],
                             ready_at=now + 0.15 if path else None, dur=self.duration_of(path) if path else None)
                elif op == "play":
                    s.update(base=cur, t0=now, playing=True, rate=float(c.get("rate") or 1))
                elif op == "pause":
                    s.update(base=cur, t0=now, playing=False)
                elif op == "rate":
                    s.update(base=cur, t0=now, rate=float(c.get("rate") or 1))
                elif op == "seek":
                    s["seeks"].append((now + 0.05, float(c.get("t") or 0), c.get("n")))
                elif op == "volume":
                    s["vol"] = float(c.get("v") or 0)
                elif op == "show":
                    s["shown"] = bool(c.get("on"))
                elif op == "rect":
                    s["rect"] = c.get("r")

    def _t(self, s, now):
        t = s["base"] + ((now - s["t0"]) * s["rate"] if s["playing"] else 0)
        return min(t, s["dur"]) if s["dur"] else t

    def _loop(self):
        while True:
            now = time.monotonic()
            with self.lock:
                new = {}
                for pid, s in self.p.items():
                    ready = s["ready_at"] is not None and now >= s["ready_at"]
                    if ready and not s["loaded"]:
                        s["loaded"] = True
                        self.events.append({"id": pid, "type": "loadeddata", "g": s["g"]})
                    for job in [j for j in s["seeks"] if now >= j[0]]:
                        s["seeks"].remove(job)
                        s.update(base=max(0.0, min(job[1], s["dur"] or job[1])), t0=now, sn=job[2] or 0)
                        self.events.append({"id": pid, "type": "seeked", "n": job[2], "g": s["g"]})
                    t = self._t(s, now)
                    ended = ready and bool(s["dur"]) and t >= s["dur"] - 0.001
                    if ended and s["playing"]:
                        s.update(base=s["dur"], t0=now, playing=False)
                    new[pid] = {"g": s["g"], "seq": s["seq"], "sn": s["sn"], "ready": ready, "t": t, "dur": s["dur"] if ready else None,
                                "paused": not s["playing"], "ended": ended, "shown": s["shown"], "rect": s["rect"]}
                self.cache = new
            time.sleep(1 / 60)
