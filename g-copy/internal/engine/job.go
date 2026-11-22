package engine

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
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
	datesFixed                                           atomic.Int64
	consecFails                                          atomic.Int32
	dead                                                 atomic.Bool

	unverified []*unvList   // per source: copies made without verification (see unverified.go)
	pending    atomic.Int64 // how many such copies are on this destination, still unchecked
	healed     atomic.Int64 // of those, how many differed and were copied again
	recopied   atomic.Int64 // verified copies that no longer matched when re-checked, and were copied again

	dirs         sync.Map    // folders known to exist on this destination
	noExclRename atomic.Bool // the volume cannot rename-unless-exists
	network      bool        // a network share (SMB, NFS, AFP, WebDAV)
	folds        nameFolding // how the volume compares names

	// sync mode, filled in before copying
	extras      []extraFile
	pruneDirs   []dirRef
	removeBytes int64
	destFiles   int64 // files seen on this destination while looking for extras

	// this destination's own progress (bytes written + bytes read back)
	workTotal, workDone atomic.Int64
	removed             atomic.Int64

	mu       sync.Mutex
	entries  [][]mhlEntry // per source
	journals []*journal   // per source, opened with the first entry
	reports  []string
}

// testIOHook, when set by a test, is called after every chunk of real I/O
// with the device it touched ("src" or a destination's path) and the byte
// count. The speed benchmarks use it to model card readers and NAS units.
var testIOHook func(dev string, n int)

// testNoReports, when set by a test, ends runs the way a crash would:
// without writing their reports.
var testNoReports bool

func ioDone(dev string, n int) {
	if testIOHook != nil {
		testIOHook(dev, n)
	}
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

	srcKeys       []map[string]bool // per source: pathKey of every name in it
	srcUnreadable []bool            // per source: part of it could not be read
	confirmCh     chan bool
	mirror        string // guarded by mu

	mu      sync.Mutex
	status  Status
	message string
	ended   time.Time
	errs    []FileError
	warns   []string
	warned  map[string]bool
	current map[int]string

	errCount, scanFiles, scanBytes, excluded, special                  atomic.Int64
	retried, datesFixed                                                atomic.Int64
	workTotal, workDone                                                atomic.Int64
	ioDone                                                             atomic.Int64 // bytes really read: the basis for speed
	srcErrs                                                            atomic.Int64 // problems reading the source itself
	filesCopied, filesSkipped, filesVerified, filesFailed, bytesCopied atomic.Int64
	speedBits                                                          atomic.Uint64

	lanes       []*slots // copy slots, one set per source disk (see pipeline.go)
	srcLane     []int    // per source: its lane
	verifySlots *slots

	est        estimator    // used by speedLoop only
	finishNano atomic.Int64 // estimated finish (unix nanoseconds), 0 = not yet known
	copyStart  atomic.Int64 // when copying began (unix nanoseconds)
	copyEnd    atomic.Int64

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
	j.srcUnreadable = make([]bool, len(j.srcRoots))
	j.confirmCh = make(chan bool, 1)
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
	removeAfter := false
	if j.opts.Mirror {
		var err error
		if removeAfter, err = j.askMirror(); err != nil {
			fatal(err)
			return
		}
	}
	j.recoverJournals()
	j.copyStart.Store(time.Now().UnixNano())
	j.setStatus(StatusCopying)
	stopJournals := make(chan struct{})
	go j.journalLoop(stopJournals)
	j.makeEmptyDirs()
	j.copyAll()
	if removeAfter && j.ctx.Err() == nil {
		j.removeExtras() // after copying, so a cancelled run leaves the destination as it was
	}
	j.copyEnd.Store(time.Now().UnixNano())
	close(stopJournals)
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

// askMirror lists what sync mode would move aside and, if there is
// anything, waits for the user to approve it.
func (j *Job) askMirror() (bool, error) {
	setMirror := func(m string) { j.mu.Lock(); j.mirror = m; j.mu.Unlock() }
	for s, bad := range j.srcUnreadable {
		if bad {
			// A folder we could not read looks empty, and its backup would
			// be moved aside. Never sync against an incomplete listing.
			setMirror(MirrorSkipped)
			j.warnOnce("mirror-unreadable", j.srcNames[s]+": part of the source could not be read, so sync clean-up was skipped. Files on the destination were left as they are.")
			return false, nil
		}
	}
	if err := j.findExtras(); err != nil {
		return false, err
	}
	if !j.hasExtras() {
		setMirror(MirrorNothing)
		return false, nil
	}
	if j.opts.Unattended {
		if ok, why := j.unattendedVerdict(); !ok {
			setMirror(MirrorSkipped)
			j.warnOnce("mirror-unattended", "Scheduled run: sync clean-up was skipped because "+why+". Run it yourself to review the list and decide.")
			return false, nil
		}
		setMirror(MirrorApproved) // moved aside, never deleted: reversible
		return true, nil
	}
	j.mu.Lock()
	j.mirror = MirrorPending
	j.status = StatusConfirming
	j.mu.Unlock()
	select {
	case remove := <-j.confirmCh:
		return remove, nil
	case <-j.ctx.Done():
		return false, j.ctx.Err()
	}
}

func (j *Job) makeEmptyDirs() {
	for _, e := range j.emptyDirs {
		for _, dr := range j.dests {
			if j.ctx.Err() != nil {
				return
			}
			if err := os.MkdirAll(filepath.Join(dr.bases[e.src], e.rel), 0o755); err != nil {
				j.addError(j.showSrc(e.src, e.rel), dr.shown, "Cannot create folder: "+osMsg(err))
			}
		}
	}
}

func (j *Job) destFailed(dr *destRun, shown string, err error) {
	dr.failed.Add(1)
	j.addError(shown, dr.shown, cleanMsg(err))
	reason := ""
	if isNoSpace(err) {
		reason = "the disk is full"
	} else if dr.consecFails.Add(1) >= deadAfterFails {
		reason = "too many errors in a row"
	}
	if reason != "" && dr.dead.CompareAndSwap(false, true) {
		j.addError("", dr.shown, "Stopped using this destination: "+reason+". The remaining files were not copied here.")
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
	for _, dr := range j.dests {
		seen := map[*unvList]bool{}
		for _, l := range dr.unverified {
			if l != nil && !seen[l] {
				seen[l] = true
				l.save()
			}
		}
		if n := dr.healed.Load(); n > 0 {
			j.warnOnce("healed:"+dr.path, fmt.Sprintf("%s: %s copied earlier without verification differed from the source and %s copied again. The differing %s kept in %s.", dr.shown, countFiles(n), wasWere(n), map[bool]string{true: "file was", false: "files were"}[n == 1], ReplacedDirName))
		}
	}
	for _, dr := range j.dests {
		if n := dr.recopied.Load(); n > 0 {
			j.warnOnce("recopied:"+dr.path, fmt.Sprintf("%s: %s on this destination no longer matched the source (same size and date, different content) and %s copied again from the source. The differing %s kept in %s — if the source could be the damaged one, compare them before deleting anything.", dr.shown, countFiles(n), wasWere(n), map[bool]string{true: "file was", false: "files were"}[n == 1], ReplacedDirName))
		}
	}
	if testNoReports {
		// a test simulating a crash: the run ends without its reports
		for _, dr := range j.dests {
			for _, jr := range dr.journals {
				jr.close()
			}
		}
		return
	}
	finished := time.Now()
	for _, dr := range j.dests {
		for s, entries := range dr.entries {
			if len(entries) == 0 {
				continue
			}
			path := mhlName(dr.bases[s], j.srcNames[s], j.started)
			jr := dr.journals[s]
			if err := writeMHL(path, j.opts.Algo, j.started, finished, entries); err != nil {
				// the journal stays: the next run turns it into the report
				jr.close()
				j.addError(filepath.Base(path), dr.shown, "Cannot write the report (MHL): "+osMsg(err))
				continue
			}
			jr.discard()
			dr.reports = append(dr.reports, path)
		}
	}
}

func (j *Job) speedLoop(stop <-chan struct{}) {
	t := time.NewTicker(500 * time.Millisecond)
	defer t.Stop()
	last, lastT := j.ioDone.Load(), time.Now()
	var ema float64
	j.est.hint = j.opts.HintSpeed
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

			// Remaining time: only once copying has started, when the
			// total is final (every file has been listed and compared).
			if cs := j.copyStart.Load(); cs != 0 {
				if j.est.start.IsZero() {
					j.est.begin(time.Unix(0, cs), 0)
				}
				_, fin := j.est.update(now, j.workDone.Load(), j.workTotal.Load())
				if fin.IsZero() {
					j.finishNano.Store(0)
				} else {
					j.finishNano.Store(fin.UnixNano())
				}
			}
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
		Mirror:    j.mirror,
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
	planned := j.status == StatusConfirming || j.status == StatusCopying || finished
	j.mu.Unlock()

	sort.Strings(st.Current)
	st.Seconds = end.Sub(j.started).Seconds()
	st.ScanFiles, st.ScanBytes = j.scanFiles.Load(), j.scanBytes.Load()
	st.Excluded, st.Special = j.excluded.Load(), j.special.Load()
	st.WorkTotal, st.WorkDone = j.workTotal.Load(), j.workDone.Load()
	st.FilesCopied, st.FilesSkipped = j.filesCopied.Load(), j.filesSkipped.Load()
	st.FilesVerified, st.FilesFailed = j.filesVerified.Load(), j.filesFailed.Load()
	st.BytesCopied, st.ErrorCount = j.bytesCopied.Load(), j.errCount.Load()
	st.Retried, st.DatesFixed = j.retried.Load(), j.datesFixed.Load()
	if !finished {
		st.Speed = math.Float64frombits(j.speedBits.Load())
		fn := j.finishNano.Load()
		if fn == 0 && j.opts.HintSpeed > 0 && j.copyStart.Load() != 0 && st.WorkTotal > st.WorkDone {
			// Copying just began: until the estimator's first update, go by
			// the speed of the last run to the same destinations.
			fn = time.Now().Add(time.Duration(float64(st.WorkTotal-st.WorkDone) / j.opts.HintSpeed * float64(time.Second))).UnixNano()
		}
		if fn != 0 && st.WorkTotal > st.WorkDone {
			fin := time.Unix(0, fn)
			st.FinishAt = &fin
			st.ETA = math.Max(1, time.Until(fin).Seconds())
		}
	} else if st.Seconds > 0 {
		st.Speed = float64(j.ioDone.Load()) / st.Seconds
		if cs, ce := j.copyStart.Load(), j.copyEnd.Load(); cs != 0 && ce > cs && st.WorkDone > 0 {
			st.CopyRate = float64(st.WorkDone) / time.Duration(ce-cs).Seconds()
		}
	}
	clean := st.Status == StatusDone || (st.Status == StatusFailed && st.Message == "" && j.srcErrs.Load() == 0)

	for _, dr := range j.dests {
		ds := DestState{
			Path: dr.shown, Copied: dr.copied.Load(), Reverified: dr.reverified.Load(),
			Replaced: dr.replaced.Load(), Failed: dr.failed.Load(), Bytes: dr.bytes.Load(),
			DatesFixed: dr.datesFixed.Load(), Network: dr.network, Unverified: dr.pending.Load(),
			Stopped: dr.dead.Load(), Reports: []string{}, Folders: append([]string{}, dr.bases...),
		}
		ds.RemoveList = []string{}
		if planned { // these are written before copying and stable afterwards
			ds.Free, ds.Need, ds.Skipped = dr.free, dr.need, dr.skipped.Load()
			ds.ToRemove, ds.ToRemoveBytes = int64(len(dr.extras)), dr.removeBytes
			for _, e := range dr.extras {
				if len(ds.RemoveList) == maxRemoveList {
					break
				}
				ds.RemoveList = append(ds.RemoveList, j.showSrc(e.src, e.rel))
			}
		}
		ds.Removed = dr.removed.Load()
		ds.WorkTotal, ds.WorkDone = dr.workTotal.Load(), dr.workDone.Load()
		if finished {
			ds.Reports = append(ds.Reports, dr.reports...)
			ds.Complete = clean && ds.Failed == 0 && !ds.Stopped
		}
		st.Dests = append(st.Dests, ds)
	}
	return st
}

func countFiles(n int64) string {
	if n == 1 {
		return "1 file"
	}
	return fmt.Sprintf("%d files", n)
}

func wasWere(n int64) string {
	if n == 1 {
		return "was"
	}
	return "were"
}
