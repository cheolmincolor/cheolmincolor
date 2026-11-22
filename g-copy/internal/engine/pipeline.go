package engine

// The copy pipeline.
//
// Every file goes through three steps: (1) the source is read once, hashed,
// and written to every destination that needs it; (2) each copy is read
// back from its own disk and its checksum compared; (3) verified copies get
// their real name.
//
// Two kinds of slots keep the devices busy without swamping them. Copy
// slots are held during step 1, verify slots during steps 2 and 3. A large
// file takes all copy slots, so big clips are still read from the card
// strictly one after another, but the next clip is already being copied
// while the previous ones are read back. Small files run several at a time.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// retryDelay is how long a file waits before its second try.
var retryDelay = 2 * time.Second

// errSourceChanged: the source file was modified while it was being
// copied. Trying again at once would most likely hit the same thing.
var errSourceChanged = errors.New("The source file changed while it was being copied — run again")

// mismatchError is a checksum that did not match.
type mismatchError struct{ msg string }

func (e *mismatchError) Error() string { return e.msg }

func isMismatch(err error) bool {
	var m *mismatchError
	return errors.As(err, &m)
}

// retryable reports whether a failed file is worth one more try: read
// errors, dropped connections, a checksum that did not match. Not: a full
// disk, missing permissions, a read-only volume, a name the volume cannot
// store, or a source that is being changed.
func retryable(err error) bool {
	switch {
	case err == nil,
		errors.Is(err, errSourceChanged),
		errors.Is(err, context.Canceled),
		isNoSpace(err),
		errors.Is(err, fs.ErrPermission),
		errors.Is(err, syscall.EROFS),
		errors.Is(err, syscall.ENAMETOOLONG):
		return false
	}
	return true
}

// ── slots ──────────────────────────────────────────────────────────────

// slots is a counting semaphore whose waiters are served in order, so a
// large file waiting for every slot is not overtaken by small ones forever.
type slots struct {
	mu   sync.Mutex
	cap  int
	used int
	wait []*slotWaiter
}

type slotWaiter struct {
	n     int
	ready chan struct{}
}

func newSlots(n int) *slots { return &slots{cap: n} }

// take waits for n slots (n <= cap). It returns false if ctx ended first.
func (s *slots) take(ctx context.Context, n int) bool {
	s.mu.Lock()
	if len(s.wait) == 0 && s.used+n <= s.cap {
		s.used += n
		s.mu.Unlock()
		return true
	}
	w := &slotWaiter{n: n, ready: make(chan struct{})}
	s.wait = append(s.wait, w)
	s.mu.Unlock()
	select {
	case <-w.ready:
		return true
	case <-ctx.Done():
	}
	s.mu.Lock()
	select {
	case <-w.ready: // granted meanwhile
		s.used -= n
	default:
		for k, o := range s.wait {
			if o == w {
				s.wait = append(s.wait[:k], s.wait[k+1:]...)
				break
			}
		}
	}
	s.grant()
	s.mu.Unlock()
	return false
}

func (s *slots) give(n int) {
	s.mu.Lock()
	s.used -= n
	s.grant()
	s.mu.Unlock()
}

func (s *slots) grant() {
	for len(s.wait) > 0 && s.used+s.wait[0].n <= s.cap {
		w := s.wait[0]
		s.wait = s.wait[1:]
		s.used += w.n
		close(w.ready)
	}
}

// ── reading ────────────────────────────────────────────────────────────

// readChunks reads r to the end in chunks and hands each to consume, which
// returns false to stop early. The next chunk is already being read while
// consume works on the current one, so the reading disk never waits for
// the writing ones. dev names the device for the test I/O hook.
func readChunks(ctx context.Context, r io.Reader, dev string, consume func([]byte) bool) error {
	type chunk struct {
		b   []byte
		n   int
		err error
	}
	const nbuf = 2
	free := make(chan []byte, nbuf)
	for k := 0; k < nbuf; k++ {
		free <- getBuf()
	}
	full := make(chan chunk, nbuf+1)
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			var b []byte
			select {
			case <-stop:
				return
			case b = <-free:
			}
			select {
			case <-stop:
				free <- b
				return
			default:
			}
			n, err := io.ReadFull(r, b)
			if n > 0 {
				ioDone(dev, n)
			}
			if err == io.ErrUnexpectedEOF {
				err = io.EOF
			}
			full <- chunk{b, n, err}
			if err != nil {
				return
			}
		}
	}()

	var rerr error
	for {
		c := <-full
		if err := ctx.Err(); err != nil {
			rerr = err
			free <- c.b
			break
		}
		if c.n > 0 && !consume(c.b[:c.n]) {
			free <- c.b
			break
		}
		free <- c.b
		if c.err != nil {
			if c.err != io.EOF {
				rerr = c.err
			}
			break
		}
	}
	close(stop)
	<-done
	for k := 0; k < nbuf; k++ {
		select {
		case b := <-free:
			putBuf(b)
		case c := <-full:
			putBuf(c.b)
		}
	}
	return rerr
}

// hashFile reads path from its disk (bypassing the OS cache where the
// platform allows it) and returns its digest. progress gets bytes read.
func hashFile(ctx context.Context, path, algo, dev string, progress func(int64)) ([]byte, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	noCache(f)
	h := newHasher(algo)
	var total int64
	err = readChunks(ctx, f, dev, func(b []byte) bool {
		h.Write(b)
		total += int64(len(b))
		if progress != nil {
			progress(int64(len(b)))
		}
		return true
	})
	if err != nil {
		return nil, total, err
	}
	return h.Sum(nil), total, nil
}

// srcDev names source s for the test I/O hook.
func srcDev(s int) string { return fmt.Sprintf("src%d", s) }

// ── dispatch ───────────────────────────────────────────────────────────

// copyAll hands the files to the pipeline. Each source disk has its own
// lane of copy slots, so two cards or drives are read at the same time;
// within one disk, files go in order and big clips one after another.
func (j *Job) copyAll() {
	var wg sync.WaitGroup
	for l := range j.lanes {
		wg.Add(1)
		go func(l int) {
			defer wg.Done()
			j.dispatch(l, &wg)
		}(l)
	}
	wg.Wait()
}

// dispatch starts the files of every source that reads from lane l.
func (j *Job) dispatch(l int, wg *sync.WaitGroup) {
	nd := len(j.dests)
	lane := j.lanes[l]
	for i := range j.files {
		if j.ctx.Err() != nil {
			return
		}
		if j.srcLane[j.files[i].src] != l {
			continue
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
			weight = lane.cap
		}
		if !lane.take(j.ctx, weight) {
			return
		}
		wg.Add(1)
		go func(i, weight int) {
			defer wg.Done()
			j.processFile(i, weight)
		}(i, weight)
	}
}

// destWork is one file on its way to one destination.
type destWork struct {
	d     int
	act   action
	final string
	tmp   string
	f     *os.File
	err   error
	tries int          // second tries used
	plan  int64        // progress this destination expects from this file
	done  atomic.Int64 // progress counted for this destination
}

// progress counts n bytes of work for this destination.
func (w *destWork) progress(dr *destRun, n int64) {
	w.done.Add(n)
	dr.workDone.Add(n)
}

func (w *destWork) alive() bool { return w.err == nil }

// reset clears a failed attempt so the destination can be tried again.
func (w *destWork) reset() {
	if w.f != nil {
		w.f.Close()
		w.f = nil
	}
	if w.tmp != "" {
		os.Remove(w.tmp)
		w.tmp = ""
	}
	w.err = nil
}

// writes reports whether this destination receives a new copy.
func (w *destWork) writes() bool { return w.act == actCopy || w.act == actReplace }

// readsBack reports whether act ends with reading the destination: always,
// except for new copies when verification is turned off.
func (j *Job) readsBack(a action) bool {
	return !(j.opts.NoVerify && (a == actCopy || a == actReplace))
}

// destWorkFor is the progress one try at act costs a destination.
func (j *Job) destWorkFor(a action, size int64) int64 {
	if a == actCopy || a == actReplace {
		if !j.readsBack(a) {
			return size // written only
		}
		return 2 * size // written, then read back
	}
	return size // read back only
}

// ── one file ───────────────────────────────────────────────────────────

// processFile takes one file through the pipeline. It is called holding
// weight copy slots of its source's lane.
func (j *Job) processFile(i, weight int) {
	f := &j.files[i]
	lane := j.lanes[j.srcLane[f.src]]
	holding := true // copy slots
	defer func() {
		if holding {
			lane.give(weight)
		}
	}()

	nd := len(j.dests)
	acts := j.acts[i*nd : (i+1)*nd]
	shown := j.showSrc(f.src, f.rel)

	// Progress bookkeeping: whatever happens, this file accounts for exactly
	// the amount of work that was planned for it (plus any second tries).
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
		if j.readsBack(a) {
			planned += f.size
		}
		dr := j.dests[d]
		w := &destWork{d: d, act: a, final: filepath.Join(dr.bases[f.src], f.rel), plan: j.destWorkFor(a, f.size)}
		works = append(works, w)
	}
	defer func() {
		for _, w := range works {
			j.dests[w.d].workDone.Add(w.plan - w.done.Load())
		}
	}()

	j.mu.Lock()
	j.current[i] = shown
	j.mu.Unlock()
	defer func() {
		j.mu.Lock()
		delete(j.current, i)
		j.mu.Unlock()
	}()

	copied, verified := false, false
	pending := works
	for pass := 0; ; pass++ {
		// destinations given up on in the meantime
		var live []*destWork
		for _, w := range pending {
			if j.dests[w.d].dead.Load() {
				j.dests[w.d].failed.Add(1)
				failed = true
				continue
			}
			live = append(live, w)
		}
		pending = live
		if len(pending) == 0 {
			break
		}

		if pass > 0 {
			if !holding {
				if !lane.take(j.ctx, weight) {
					return
				}
				holding = true
			}
			// a second try costs another read of the source, and the
			// destinations' work again
			extra := f.size
			for _, w := range pending {
				if j.readsBack(w.act) {
					extra += f.size
				}
				more := j.destWorkFor(w.act, f.size)
				w.plan += more
				j.dests[w.d].workTotal.Add(more)
			}
			planned += extra
			j.workTotal.Add(extra)
		}

		// 1. read the source once; hash it and write every copy
		srcSum := j.copyPass(f, pending, add)
		if j.ctx.Err() != nil {
			discard(pending)
			return
		}
		// from copying to verifying: the next file may start now
		if !j.verifySlots.take(j.ctx, weight) {
			discard(pending)
			return
		}
		lane.give(weight)
		holding = false

		// 2. read every copy back from its disk and compare
		j.verifyPass(f, pending, srcSum, add)
		if j.ctx.Err() != nil {
			j.verifySlots.give(weight)
			discard(pending)
			return
		}

		// 3. commit verified copies; try again, or report, the rest
		now := time.Now()
		var again []*destWork
		wait := false
		for _, w := range pending {
			dr := j.dests[w.d]
			if w.alive() {
				switch {
				case w.writes():
					w.err = j.commit(dr, w, f)
				case w.act == actCheck:
					// Same content, only the date differs: fix the date.
					if err := os.Chtimes(w.final, f.modTime, f.modTime); err != nil {
						j.noDates(dr)
					}
				}
			}
			if w.err != nil {
				if w.tmp != "" {
					os.Remove(w.tmp)
					w.tmp = ""
				}
				switch {
				case (w.act == actCheck || w.act == actPending || w.act == actReverify) && isMismatch(w.err):
					// actCheck: same size, different date and different content:
					// the file was edited. actPending: a copy that was never
					// verified is not what the source holds. actReverify: a
					// copy that was good once no longer matches. In each case
					// the source is what gets backed up: copy it, keeping the
					// file that is there (in _G-Copy_Replaced).
					if w.act == actPending {
						dr.healed.Add(1)
					}
					if w.act == actReverify {
						dr.recopied.Add(1)
					}
					w.act = actReplace
					w.reset()
					again = append(again, w)
				case w.tries == 0 && retryable(w.err):
					w.tries++
					w.reset()
					j.retried.Add(1)
					again = append(again, w)
					wait = true
				default:
					failed = true
					j.destFailed(dr, shown, w.err)
				}
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
			case actReverify, actPending:
				dr.reverified.Add(1)
				verified = true
			case actCheck:
				dr.skipped.Add(1)
				dr.datesFixed.Add(1)
				j.datesFixed.Add(1)
			}
			lrel := filepath.ToSlash(f.rel)
			if !j.readsBack(w.act) {
				// copied without verification: remembered, and not for the checksum report
				if dr.unverified[f.src].add(unvEntry{File: lrel, Size: f.size, Mod: f.modTime}) {
					dr.pending.Add(1)
				}
				continue
			}
			if dr.unverified[f.src].clear(lrel) {
				dr.pending.Add(-1) // read back and equal to the source: verified now
			}
			rel, _ := filepath.Rel(dr.bases[f.src], w.final)
			j.record(dr, f.src, mhlEntry{
				rel: filepath.ToSlash(rel), size: f.size, modTime: f.modTime, sum: srcSum, hashedAt: now,
			})
		}
		j.verifySlots.give(weight)
		pending = again
		if len(pending) == 0 {
			break
		}
		if wait {
			select {
			case <-time.After(retryDelay):
			case <-j.ctx.Done():
				return
			}
		}
	}
	switch {
	case failed:
		j.filesFailed.Add(1)
	case copied:
		j.filesCopied.Add(1)
		j.bytesCopied.Add(f.size)
	case verified:
		j.filesVerified.Add(1)
	default: // only dates fixed: the content was already there
		j.filesSkipped.Add(1)
	}
}

func discard(works []*destWork) {
	for _, w := range works {
		w.reset()
	}
}

func failAll(works []*destWork, err error) {
	for _, w := range works {
		if w.alive() {
			w.err = err
		}
	}
}

// copyPass reads the source once, writes it to every destination that
// needs a new copy, and returns the source's checksum (nil on failure;
// the reason is in each destWork).
func (j *Job) copyPass(f *srcFile, works []*destWork, add func(int64)) []byte {
	srcPath := filepath.Join(j.srcRoots[f.src], f.rel)
	src, err := os.Open(srcPath)
	if err != nil {
		failAll(works, fmt.Errorf("Cannot open the source file: %w", err))
		return nil
	}
	defer src.Close()
	noCache(src)

	var writers []*destWork
	for _, w := range works {
		if !w.writes() {
			continue
		}
		dr := j.dests[w.d]
		dir := filepath.Dir(w.final)
		if _, known := dr.dirs.Load(dir); !known {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				w.err = fmt.Errorf("Cannot create folder: %w", err)
				continue
			}
			dr.dirs.Store(dir, true)
		}
		tmp := filepath.Join(dir, tempName(filepath.Base(w.final)))
		tf, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, createMode(f.mode))
		if errors.Is(err, fs.ErrPermission) {
			// a read-only leftover from an interrupted run
			os.Remove(tmp)
			tf, err = os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, createMode(f.mode))
		}
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				dr.dirs.Delete(dir) // the folder went away: make it again next time
			}
			w.err = fmt.Errorf("Cannot create the file on the destination: %w", err)
			continue
		}
		noCache(tf)
		w.tmp, w.f = tmp, tf
		writers = append(writers, w)
	}

	h := newHasher(j.opts.Algo)
	var total int64
	srcErr := readChunks(j.ctx, src, srcDev(f.src), func(chunk []byte) bool {
		anyAlive := false
		for _, w := range works {
			anyAlive = anyAlive || w.alive()
		}
		if !anyAlive {
			return false
		}
		var wg sync.WaitGroup
		for _, w := range writers {
			if !w.alive() {
				continue
			}
			wg.Add(1)
			go func(w *destWork) {
				defer wg.Done()
				if _, err := w.f.Write(chunk); err != nil {
					w.err = fmt.Errorf("Write error: %w", err)
				}
				ioDone(j.dests[w.d].path, len(chunk))
			}(w)
		}
		h.Write(chunk) // hashing overlaps the writes
		wg.Wait()
		n := int64(len(chunk))
		total += n
		add(n)
		for _, w := range writers {
			if w.alive() {
				j.dests[w.d].bytes.Add(n)
				w.progress(j.dests[w.d], n)
			}
		}
		return true
	})
	if j.ctx.Err() != nil {
		return nil
	}

	big := f.size >= bigFileSize
	for _, w := range writers {
		if w.alive() {
			if err := flushFile(w.f, big); err != nil && !syncUnsupported(err) {
				w.err = fmt.Errorf("Cannot flush to disk: %w", err)
			}
			dropCache(w.f)
		}
		if err := w.f.Close(); err != nil && w.alive() {
			w.err = fmt.Errorf("Cannot flush to disk: %w", err)
		}
		w.f = nil
	}

	if srcErr != nil {
		failAll(works, fmt.Errorf("Source read error: %w", srcErr))
		return nil
	}
	if st, err := os.Stat(srcPath); err != nil || total != f.size || st.Size() != f.size || !st.ModTime().Equal(f.modTime) {
		failAll(works, errSourceChanged)
		return nil
	}
	if j.afterWrite != nil {
		for _, w := range writers {
			if w.alive() {
				j.afterWrite(w.tmp)
			}
		}
	}
	return h.Sum(nil)
}

// verifyPass reads each copy back from its own disk and compares.
func (j *Job) verifyPass(f *srcFile, works []*destWork, srcSum []byte, add func(int64)) {
	var vg sync.WaitGroup
	for _, w := range works {
		if !w.alive() || !j.readsBack(w.act) {
			continue
		}
		vg.Add(1)
		go func(w *destWork) {
			defer vg.Done()
			path := w.tmp
			if !w.writes() {
				path = w.final
			}
			dr := j.dests[w.d]
			sum, n, err := hashFile(j.ctx, path, j.opts.Algo, dr.path, func(n int64) {
				add(n)
				w.progress(dr, n)
			})
			switch {
			case err != nil:
				w.err = fmt.Errorf("Verification read error: %w", err)
			case n == f.size && bytes.Equal(sum, srcSum):
			case w.act == actCheck || w.act == actPending || w.act == actReverify:
				w.err = &mismatchError{"the content differs"} // replaced, not reported
			default:
				w.err = &mismatchError{fmt.Sprintf("Checksum mismatch — the copy was discarded (source %x, destination %x)", srcSum, sum)}
			}
		}(w)
	}
	vg.Wait()
}

// commit gives a verified temporary file its real name. A file that is
// already there is never overwritten: it is moved aside first.
func (j *Job) commit(dr *destRun, w *destWork, f *srcFile) error {
	placed := false
	if w.act == actCopy && !dr.noExclRename.Load() {
		// One request instead of "is something there?" plus a rename.
		switch err := renameNoReplace(w.tmp, w.final); {
		case err == nil:
			placed = true
		case errors.Is(err, fs.ErrExist):
			// appeared since the comparison: set it aside below
		case errors.Is(err, errNoExclRename) || errors.Is(err, syscall.ENOTSUP) ||
			errors.Is(err, syscall.EINVAL) || errors.Is(err, syscall.ENOSYS):
			dr.noExclRename.Store(true) // this volume cannot: do it the long way
		default:
			return fmt.Errorf("Cannot give the file its final name: %w", err)
		}
	}
	if !placed {
		if _, err := os.Lstat(w.final); err == nil {
			rel, rerr := filepath.Rel(dr.path, w.final)
			if rerr != nil {
				return fmt.Errorf("Cannot set the previous version aside: %w", rerr)
			}
			keep := filepath.Join(dr.path, ReplacedDirName, j.stamp, rel)
			if err := os.MkdirAll(filepath.Dir(keep), 0o755); err != nil {
				return fmt.Errorf("Cannot set the previous version aside: %w", err)
			}
			if err := os.Rename(w.final, keep); err != nil {
				return fmt.Errorf("Cannot set the previous version aside: %w", err)
			}
		}
		if err := os.Rename(w.tmp, w.final); err != nil {
			return fmt.Errorf("Cannot give the file its final name: %w", err)
		}
	}
	w.tmp = ""
	// The date is what the next run compares. The copy itself is verified
	// either way, so a volume that refuses dates is a warning, not a failure.
	if err := os.Chtimes(w.final, f.modTime, f.modTime); err != nil {
		j.noDates(dr)
	}
	if want := f.mode.Perm() &^ procUmask; want != createMode(f.mode) {
		_ = os.Chmod(w.final, want) // best effort; many NAS/exFAT volumes ignore it
	}
	return nil
}

// createMode is the permission a new copy is created with: the source's,
// as the umask allows, and always writable by us while it is written.
func createMode(m fs.FileMode) fs.FileMode {
	return (m.Perm() | 0o600) &^ procUmask
}

func (j *Job) noDates(dr *destRun) {
	msg := ": this volume does not keep modification dates. Copies are verified, but the next run has to read these files again to check them."
	if j.opts.NoVerify {
		msg = ": this volume does not keep modification dates, so the next run has to read these files again to compare them."
	}
	j.warnOnce("chtimes:"+dr.path, dr.shown+msg)
}
