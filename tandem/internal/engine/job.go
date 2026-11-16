package engine

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

type dirRef struct {
	src int
	rel string
}

// destRun is the working state of one destination.
type destRun struct {
	path  string   // resolved folder
	shown string   // as the user selected it
	bases []string // per source: folder that receives that source's files
	free  int64
	need  int64

	copied, skipped, reverified, replaced, failed, bytes atomic.Int64
	consecFails                                          atomic.Int32
	dead                                                 atomic.Bool

	mu      sync.Mutex
	entries [][]mhlEntry // per source
	reports []string
}

// Job is one backup run.
type Job struct {
	id      string
	opts    Options
	started time.Time
	stamp   string
	ctx     context.Context
	cancel  context.CancelFunc
	done    chan struct{}

	srcRoots  []string
	srcNames  []string
	dests     []*destRun
	files     []srcFile
	acts      []action // len(files) * len(dests)
	emptyDirs []dirRef

	mu      sync.Mutex
	status  Status
	message string
	ended   time.Time
	errs    []FileError
	warns   []string
	warned  map[string]bool
	current map[int]string

	errCount, scanFiles, scanBytes, excluded, special                  atomic.Int64
	workTotal, workDone                                                atomic.Int64
	ioDone                                                             atomic.Int64 // bytes really read: the basis for speed
	srcErrs                                                            atomic.Int64 // problems reading the source itself
	filesCopied, filesSkipped, filesVerified, filesFailed, bytesCopied atomic.Int64
	speedBits                                                          atomic.Uint64

	// afterWrite is a test hook: called with each temporary file after it
	// has been written and before it is read back.
	afterWrite func(path string)
}

// Start validates opts and launches the backup in the background.
// onFinish, if set, is called once with the final state.
func Start(opts Options, onFinish func(State)) (*Job, error) {
	return start(opts, onFinish, nil)
}

func start(opts Options, onFinish func(State), afterWrite func(string)) (*Job, error) {
	now := time.Now()
	rnd := make([]byte, 3)
	_, _ = rand.Read(rnd)
	j := &Job{
		id:         now.Format("20060102-150405-") + hex.EncodeToString(rnd),
		opts:       opts,
		started:    now,
		stamp:      now.Format("2006-01-02_150405"),
		done:       make(chan struct{}),
		status:     StatusScanning,
		current:    map[int]string{},
		warned:     map[string]bool{},
		afterWrite: afterWrite,
	}
	j.opts.Sources = append([]string(nil), opts.Sources...)
	j.opts.Destinations = append([]string(nil), opts.Destinations...)
	if err := j.prepare(); err != nil {
		return nil, err
	}
	j.ctx, j.cancel = context.WithCancel(context.Background())
	go func() {
		j.run()
		if onFinish != nil {
			onFinish(j.Snapshot())
		}
		close(j.done)
	}()
	return j, nil
}

// Cancel stops the job. Files that were already verified stay in place;
// files in flight are discarded.
func (j *Job) Cancel() { j.cancel() }

// Wait blocks until the job has finished.
func (j *Job) Wait() { <-j.done }

// ID returns the job's identifier.
func (j *Job) ID() string { return j.id }

func (j *Job) setStatus(s Status) {
	j.mu.Lock()
	j.status = s
	j.mu.Unlock()
}

func (j *Job) finish(s Status, msg string) {
	j.mu.Lock()
	j.status, j.message, j.ended = s, msg, time.Now()
	j.current = map[int]string{}
	j.mu.Unlock()
}

func (j *Job) addError(path, dest, msg string) {
	j.errCount.Add(1)
	if dest == "" {
		j.srcErrs.Add(1)
	}
	j.mu.Lock()
	if len(j.errs) < maxErrors {
		j.errs = append(j.errs, FileError{Path: path, Dest: dest, Message: msg})
	}
	j.mu.Unlock()
}

// warnOnce records a note that does not make the run fail.
func (j *Job) warnOnce(key, msg string) {
	j.mu.Lock()
	if !j.warned[key] {
		j.warned[key] = true
		j.warns = append(j.warns, msg)
	}
	j.mu.Unlock()
}

func (j *Job) run() {
	stopSpeed := make(chan struct{})
	go j.speedLoop(stopSpeed)
	defer close(stopSpeed)

	fatal := func(err error) {
		if j.ctx.Err() != nil {
			j.finish(StatusCancelled, "")
			return
		}
		j.finish(StatusFailed, err.Error())
	}

	if err := j.scan(); err != nil {
		fatal(err)
		return
	}
	j.setStatus(StatusComparing)
	if err := j.compare(); err != nil {
		fatal(err)
		return
	}
	j.setStatus(StatusCopying)
	j.makeEmptyDirs()
	j.copyAll()
	j.writeReports()

	switch {
	case j.ctx.Err() != nil:
		j.finish(StatusCancelled, "")
	case j.errCount.Load() > 0:
		j.finish(StatusFailed, "")
	default:
		j.finish(StatusDone, "")
	}
}

func (j *Job) makeEmptyDirs() {
	for _, e := range j.emptyDirs {
		for _, dr := range j.dests {
			if j.ctx.Err() != nil {
				return
			}
			if err := os.MkdirAll(filepath.Join(dr.bases[e.src], e.rel), 0o755); err != nil {
				j.addError(j.showSrc(e.src, e.rel), dr.shown, "폴더를 만들 수 없습니다: "+osMsg(err))
			}
		}
	}
}

// copyAll hands files to workers. Small files (image sequences) run several
// at a time; a large file takes every slot, so big clips are read strictly
// one after another, which is what spinning disks and single network
// streams handle best.
func (j *Job) copyAll() {
	nd := len(j.dests)
	slots := make(chan struct{}, fileWorkers)
	var wg sync.WaitGroup

dispatch:
	for i := range j.files {
		if j.ctx.Err() != nil {
			break
		}
		acts := j.acts[i*nd : (i+1)*nd]
		active, blocked := false, false
		for _, a := range acts {
			active = active || a.active()
			blocked = blocked || a == actBlocked
		}
		if !active {
			if blocked {
				j.filesFailed.Add(1)
			} else {
				j.filesSkipped.Add(1)
			}
			continue
		}
		weight := 1
		if j.files[i].size >= bigFileSize {
			weight = fileWorkers
		}
		for got := 0; got < weight; got++ {
			select {
			case slots <- struct{}{}:
			case <-j.ctx.Done():
				for ; got > 0; got-- {
					<-slots
				}
				break dispatch
			}
		}
		wg.Add(1)
		go func(i, weight int) {
			defer wg.Done()
			defer func() {
				for k := 0; k < weight; k++ {
					<-slots
				}
			}()
			j.processFile(i)
		}(i, weight)
	}
	wg.Wait()
}

// destWork is one file on its way to one destination.
type destWork struct {
	d     int
	act   action
	final string
	tmp   string
	f     *os.File
	err   error
}

func (w *destWork) alive() bool { return w.err == nil }

// processFile copies one file to every destination that needs it, reads
// each copy back, and only then gives the copy its real name.
//
// The source is read once. Each chunk is hashed and written to all
// destinations at the same time.
func (j *Job) processFile(i int) {
	f := &j.files[i]
	nd := len(j.dests)
	acts := j.acts[i*nd : (i+1)*nd]
	shown := j.showSrc(f.src, f.rel)
	srcPath := filepath.Join(j.srcRoots[f.src], f.rel)

	// Progress bookkeeping: whatever happens, this file accounts for exactly
	// the amount of work that was planned for it.
	planned := f.size
	var added atomic.Int64
	add := func(n int64) {
		added.Add(n)
		j.workDone.Add(n)
		j.ioDone.Add(n)
	}
	defer func() { j.workDone.Add(planned - added.Load()) }()

	failed := false
	var works []*destWork
	for d, a := range acts {
		if a == actBlocked {
			failed = true
		}
		if !a.active() {
			continue
		}
		planned += f.size
		dr := j.dests[d]
		if dr.dead.Load() {
			dr.failed.Add(1)
			failed = true
			continue
		}
		works = append(works, &destWork{d: d, act: a, final: filepath.Join(dr.bases[f.src], f.rel)})
	}
	if len(works) == 0 {
		j.filesFailed.Add(1)
		return
	}

	j.mu.Lock()
	j.current[i] = shown
	j.mu.Unlock()
	defer func() {
		j.mu.Lock()
		delete(j.current, i)
		j.mu.Unlock()
	}()

	discard := func() {
		for _, w := range works {
			if w.f != nil {
				w.f.Close()
				w.f = nil
			}
			if w.tmp != "" {
				os.Remove(w.tmp)
				w.tmp = ""
			}
		}
	}
	failAll := func(msg string) {
		for _, w := range works {
			if w.alive() {
				w.err = errors.New(msg)
			}
		}
	}

	// ── 1. read the source once; hash it and write every copy ──────────
	var srcSum []byte
	src, err := os.Open(srcPath)
	if err != nil {
		failAll("원본을 열 수 없습니다: " + osMsg(err))
	} else {
		noCache(src)
		for _, w := range works {
			if w.act == actReverify {
				continue
			}
			dir := filepath.Dir(w.final)
			if err := os.MkdirAll(dir, 0o755); err != nil {
				w.err = fmt.Errorf("폴더를 만들 수 없습니다: %w", err)
				continue
			}
			tmp := filepath.Join(dir, tempName(filepath.Base(w.final)))
			tf, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
			if err != nil {
				w.err = fmt.Errorf("대상에 파일을 만들 수 없습니다: %w", err)
				continue
			}
			noCache(tf)
			w.tmp, w.f = tmp, tf
		}

		h := newHasher(j.opts.Algo)
		buf := getBuf()
		var total int64
		var srcErr error
		for {
			if j.ctx.Err() != nil {
				break
			}
			anyAlive := false
			for _, w := range works {
				anyAlive = anyAlive || w.alive()
			}
			if !anyAlive {
				break
			}
			n, rerr := io.ReadFull(src, buf)
			if n > 0 {
				chunk := buf[:n]
				var wg sync.WaitGroup
				for _, w := range works {
					if w.f == nil || !w.alive() {
						continue
					}
					wg.Add(1)
					go func(w *destWork) {
						defer wg.Done()
						if _, err := w.f.Write(chunk); err != nil {
							w.err = fmt.Errorf("쓰기 오류: %w", err)
						}
					}(w)
				}
				h.Write(chunk) // hashing overlaps the writes
				wg.Wait()
				total += int64(n)
				add(int64(n))
				for _, w := range works {
					if w.f != nil && w.alive() {
						j.dests[w.d].bytes.Add(int64(n))
					}
				}
			}
			if rerr == io.EOF || rerr == io.ErrUnexpectedEOF {
				break
			}
			if rerr != nil {
				srcErr = rerr
				break
			}
		}
		putBuf(buf)
		src.Close()

		if j.ctx.Err() != nil {
			discard()
			return
		}
		for _, w := range works {
			if w.f == nil {
				continue
			}
			if w.alive() {
				if err := syncLight(w.f); err != nil && !syncUnsupported(err) {
					w.err = fmt.Errorf("디스크에 기록할 수 없습니다: %w", err)
				}
				dropCache(w.f)
			}
			if err := w.f.Close(); err != nil && w.alive() {
				w.err = fmt.Errorf("디스크에 기록할 수 없습니다: %w", err)
			}
			w.f = nil
		}

		if srcErr != nil {
			failAll("원본 읽기 오류: " + osMsg(srcErr))
		} else if st, err := os.Stat(srcPath); err != nil || total != f.size || st.Size() != f.size || !st.ModTime().Equal(f.modTime) {
			failAll("복사하는 동안 원본 파일이 바뀌었습니다 — 다시 실행하세요")
		} else {
			srcSum = h.Sum(nil)
		}
	}

	if j.afterWrite != nil {
		for _, w := range works {
			if w.tmp != "" && w.alive() {
				j.afterWrite(w.tmp)
			}
		}
	}

	// ── 2. read every copy back from its disk and compare ──────────────
	var vg sync.WaitGroup
	for _, w := range works {
		if !w.alive() {
			continue
		}
		vg.Add(1)
		go func(w *destWork) {
			defer vg.Done()
			path := w.tmp
			if w.act == actReverify {
				path = w.final
			}
			sum, n, err := hashFile(j.ctx, path, j.opts.Algo, add)
			switch {
			case err != nil:
				w.err = fmt.Errorf("검증 읽기 오류: %w", err)
			case n != f.size || !bytes.Equal(sum, srcSum):
				if w.act == actReverify {
					w.err = fmt.Errorf("기존 파일의 내용이 원본과 다릅니다 (크기와 날짜는 같음) — 원본 %x, 대상 %x", srcSum, sum)
				} else {
					w.err = fmt.Errorf("체크섬 불일치 — 복사본을 폐기했습니다 (원본 %x, 대상 %x)", srcSum, sum)
				}
			}
		}(w)
	}
	vg.Wait()
	if j.ctx.Err() != nil {
		discard()
		return
	}

	// ── 3. commit verified copies; report the rest ─────────────────────
	now := time.Now()
	copied, verified := false, false
	for _, w := range works {
		dr := j.dests[w.d]
		if w.alive() && w.act != actReverify {
			w.err = j.commit(dr, w, f)
		}
		if w.err != nil {
			if w.tmp != "" {
				os.Remove(w.tmp)
				w.tmp = ""
			}
			failed = true
			j.destFailed(dr, shown, w.err)
			continue
		}
		dr.consecFails.Store(0)
		switch w.act {
		case actCopy:
			dr.copied.Add(1)
			copied = true
		case actReplace:
			dr.copied.Add(1)
			dr.replaced.Add(1)
			copied = true
		case actReverify:
			dr.reverified.Add(1)
			verified = true
		}
		rel, _ := filepath.Rel(dr.bases[f.src], w.final)
		dr.mu.Lock()
		dr.entries[f.src] = append(dr.entries[f.src], mhlEntry{
			rel: filepath.ToSlash(rel), size: f.size, modTime: f.modTime, sum: srcSum, hashedAt: now,
		})
		dr.mu.Unlock()
	}
	switch {
	case failed:
		j.filesFailed.Add(1)
	case copied:
		j.filesCopied.Add(1)
		j.bytesCopied.Add(f.size)
	case verified:
		j.filesVerified.Add(1)
	}
}

// commit gives a verified temporary file its real name. A file that is
// already there is never overwritten: it is moved aside first.
func (j *Job) commit(dr *destRun, w *destWork, f *srcFile) error {
	if _, err := os.Lstat(w.final); err == nil {
		rel, rerr := filepath.Rel(dr.path, w.final)
		if rerr != nil {
			return fmt.Errorf("이전 파일을 보관할 수 없습니다: %w", rerr)
		}
		keep := filepath.Join(dr.path, ReplacedDirName, j.stamp, rel)
		if err := os.MkdirAll(filepath.Dir(keep), 0o755); err != nil {
			return fmt.Errorf("이전 파일을 보관할 수 없습니다: %w", err)
		}
		if err := os.Rename(w.final, keep); err != nil {
			return fmt.Errorf("이전 파일을 보관할 수 없습니다: %w", err)
		}
	}
	if err := os.Rename(w.tmp, w.final); err != nil {
		return fmt.Errorf("파일 이름을 확정할 수 없습니다: %w", err)
	}
	w.tmp = ""
	// The date is what the next run compares. The copy itself is verified
	// either way, so a volume that refuses dates is a warning, not a failure.
	if err := os.Chtimes(w.final, f.modTime, f.modTime); err != nil {
		j.warnOnce("chtimes:"+dr.path, dr.shown+": 이 볼륨은 수정 날짜를 기록할 수 없습니다. 복사와 검증은 정상이지만, 다음 실행 때 같은 파일을 다시 복사합니다.")
	}
	_ = os.Chmod(w.final, f.mode.Perm()) // best effort; many NAS/exFAT volumes ignore it
	return nil
}

func (j *Job) destFailed(dr *destRun, shown string, err error) {
	dr.failed.Add(1)
	j.addError(shown, dr.shown, cleanMsg(err))
	reason := ""
	if isNoSpace(err) {
		reason = "디스크가 가득 찼습니다"
	} else if dr.consecFails.Add(1) >= deadAfterFails {
		reason = "오류가 연속으로 발생했습니다"
	}
	if reason != "" && dr.dead.CompareAndSwap(false, true) {
		j.addError("", dr.shown, "이 대상은 중단했습니다: "+reason+". 남은 파일은 이 대상에 복사하지 않았습니다.")
	}
}

// cleanMsg renders a wrapped OS error without repeating the file path.
func cleanMsg(err error) string {
	inner := errors.Unwrap(err)
	if inner == nil {
		return err.Error()
	}
	full := err.Error()
	return full[:len(full)-len(inner.Error())] + osMsg(inner)
}

// writeReports stores one hash list per destination and source, covering
// the files this run copied or re-verified.
func (j *Job) writeReports() {
	finished := time.Now()
	for _, dr := range j.dests {
		for s, entries := range dr.entries {
			if len(entries) == 0 {
				continue
			}
			path := mhlName(dr.bases[s], j.srcNames[s], j.started)
			if err := writeMHL(path, j.opts.Algo, j.started, finished, entries); err != nil {
				j.addError(filepath.Base(path), dr.shown, "리포트(MHL)를 쓸 수 없습니다: "+osMsg(err))
				continue
			}
			dr.reports = append(dr.reports, path)
		}
	}
}

func (j *Job) speedLoop(stop <-chan struct{}) {
	t := time.NewTicker(500 * time.Millisecond)
	defer t.Stop()
	last, lastT := j.ioDone.Load(), time.Now()
	var ema float64
	for {
		select {
		case <-stop:
			return
		case now := <-t.C:
			cur := j.ioDone.Load()
			inst := float64(cur-last) / now.Sub(lastT).Seconds()
			if ema == 0 {
				ema = inst
			} else {
				ema = 0.75*ema + 0.25*inst
			}
			last, lastT = cur, now
			j.speedBits.Store(math.Float64bits(ema))
		}
	}
}

// Snapshot returns the job's current state.
func (j *Job) Snapshot() State {
	j.mu.Lock()
	st := State{
		ID:        j.id,
		Status:    j.status,
		Message:   j.message,
		Options:   j.opts,
		StartedAt: j.started,
		Errors:    append([]FileError{}, j.errs...),
		Warnings:  append([]string{}, j.warns...),
		Current:   []string{},
	}
	for _, c := range j.current {
		st.Current = append(st.Current, c)
	}
	end := time.Now()
	if !j.ended.IsZero() {
		e := j.ended
		st.EndedAt, end = &e, e
	}
	finished := j.status.Finished()
	planned := j.status == StatusCopying || finished
	j.mu.Unlock()

	sort.Strings(st.Current)
	st.Seconds = end.Sub(j.started).Seconds()
	st.ScanFiles, st.ScanBytes = j.scanFiles.Load(), j.scanBytes.Load()
	st.Excluded, st.Special = j.excluded.Load(), j.special.Load()
	st.WorkTotal, st.WorkDone = j.workTotal.Load(), j.workDone.Load()
	st.FilesCopied, st.FilesSkipped = j.filesCopied.Load(), j.filesSkipped.Load()
	st.FilesVerified, st.FilesFailed = j.filesVerified.Load(), j.filesFailed.Load()
	st.BytesCopied, st.ErrorCount = j.bytesCopied.Load(), j.errCount.Load()
	if !finished {
		st.Speed = math.Float64frombits(j.speedBits.Load())
		if st.Speed > 0 && st.WorkTotal > st.WorkDone {
			st.ETA = float64(st.WorkTotal-st.WorkDone) / st.Speed
		}
	} else if st.Seconds > 0 {
		st.Speed = float64(j.ioDone.Load()) / st.Seconds
	}
	clean := st.Status == StatusDone || (st.Status == StatusFailed && st.Message == "" && j.srcErrs.Load() == 0)

	for _, dr := range j.dests {
		ds := DestState{
			Path: dr.shown, Copied: dr.copied.Load(), Reverified: dr.reverified.Load(),
			Replaced: dr.replaced.Load(), Failed: dr.failed.Load(), Bytes: dr.bytes.Load(),
			Stopped: dr.dead.Load(), Reports: []string{}, Folders: append([]string{}, dr.bases...),
		}
		if planned { // these are written by the compare step and stable afterwards
			ds.Free, ds.Need, ds.Skipped = dr.free, dr.need, dr.skipped.Load()
		}
		if finished {
			ds.Reports = append(ds.Reports, dr.reports...)
			ds.Complete = clean && ds.Failed == 0 && !ds.Stopped
		}
		st.Dests = append(st.Dests, ds)
	}
	return st
}
