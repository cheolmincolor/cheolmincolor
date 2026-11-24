package engine

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/cespare/xxhash/v2"
)

// Same size, but the date differs (the volume did not keep it, or another
// tool copied the files): the content is compared, the date fixed, and
// nothing is copied again or set aside.
func TestOnlyTheDateDiffers(t *testing.T) {
	tmp := t.TempDir()
	src, dst := filepath.Join(tmp, "A001"), filepath.Join(tmp, "NAS")
	makeSource(t, src)
	os.MkdirAll(dst, 0o755)
	o := Options{Sources: []string{src}, Destinations: []string{dst}, Subfolder: true}
	if st := runJob(t, o, nil); st.Status != StatusDone {
		t.Fatalf("first run: %s", st.Status)
	}
	// every copy an hour off, as after a time-zone or DST mix-up
	filepath.WalkDir(filepath.Join(dst, "A001"), func(p string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() && !strings.HasSuffix(p, ".mhl") {
			os.Chtimes(p, day.Add(time.Hour), day.Add(time.Hour))
		}
		return nil
	})
	// and one file really edited, keeping its size
	edited := filepath.Join(src, "SEQ", "shot010", "shot010.0003.exr")
	data, _ := os.ReadFile(edited)
	data[0] ^= 0xff
	writeFile(t, edited, data, day.Add(2*time.Hour))

	time.Sleep(1100 * time.Millisecond)
	st := runJob(t, o, nil)
	if st.Status != StatusDone || st.DatesFixed != 44 || st.FilesCopied != 1 || st.FilesSkipped != 44 || st.Dests[0].Replaced != 1 {
		t.Fatalf("status %s dates fixed %d copied %d skipped %d replaced %d errors %+v",
			st.Status, st.DatesFixed, st.FilesCopied, st.FilesSkipped, st.Dests[0].Replaced, st.Errors)
	}
	if st.Dests[0].Bytes != int64(len(data)) {
		t.Errorf("wrote %d bytes, want only the edited file (%d)", st.Dests[0].Bytes, len(data))
	}
	sameTree(t, "destination", treeDigest(t, src, isSrcJunk), treeDigest(t, filepath.Join(dst, "A001"), isReportOrKept))
	// only the edited file's old version is kept aside
	kept, _ := filepath.Glob(filepath.Join(dst, ReplacedDirName, "*", "A001", "*", "*", "*"))
	if len(kept) != 1 || !strings.HasSuffix(kept[0], "shot010.0003.exr") {
		t.Errorf("set aside: %v", kept)
	}
	// dates are right again, so the next run has nothing to do
	time.Sleep(1100 * time.Millisecond)
	st = runJob(t, o, nil)
	if st.WorkTotal != 0 || st.FilesSkipped != 45 || st.DatesFixed != 0 {
		t.Errorf("third run: work %d skipped %d dates fixed %d", st.WorkTotal, st.FilesSkipped, st.DatesFixed)
	}
	// the second run's report lists what it checked and what it copied
	reports, _ := filepath.Glob(filepath.Join(dst, "A001", "*.mhl"))
	if len(reports) != 2 {
		t.Fatalf("reports: %v", reports)
	}
	if n := len(readMHL(t, reports[1]).Hashes); n != 45 {
		t.Errorf("second report lists %d files, want 45", n)
	}
}

// A crash before the end: the next run writes the missing report.
func TestReportIsRecoveredAfterACrash(t *testing.T) {
	tmp := t.TempDir()
	src, dst := filepath.Join(tmp, "A001"), filepath.Join(tmp, "NAS")
	makeSource(t, src)
	os.MkdirAll(dst, 0o755)
	o := Options{Sources: []string{src}, Destinations: []string{dst}, Subfolder: true}

	testNoReports = true
	st := runJob(t, o, nil)
	testNoReports = false
	if st.FilesCopied != 45 {
		t.Fatalf("first run copied %d", st.FilesCopied)
	}
	if m, _ := filepath.Glob(filepath.Join(dst, "A001", "*.mhl")); len(m) != 0 {
		t.Fatalf("test setup: reports were written: %v", m)
	}
	journals, _ := filepath.Glob(filepath.Join(dst, "A001", ".*"+journalSuffix))
	if len(journals) != 1 {
		t.Fatalf("journals after the crash: %v", journals)
	}

	time.Sleep(1100 * time.Millisecond)
	st = runJob(t, o, nil)
	if st.Status != StatusDone || st.FilesSkipped != 45 {
		t.Fatalf("second run: %s skipped %d", st.Status, st.FilesSkipped)
	}
	if len(st.Warnings) != 1 || !strings.Contains(st.Warnings[0], "45 files") {
		t.Errorf("warnings: %v", st.Warnings)
	}
	r := readMHL(t, findOne(t, filepath.Join(dst, "A001", "*.mhl")))
	if len(r.Hashes) != 45 {
		t.Errorf("recovered report lists %d files", len(r.Hashes))
	}
	for _, h := range r.Hashes {
		data, _ := os.ReadFile(filepath.Join(dst, "A001", filepath.FromSlash(h.File)))
		if want := fmt.Sprintf("%016x", xxhash.Sum64(data)); h.XXH != want {
			t.Errorf("%s: report says %s, file is %s", h.File, h.XXH, want)
		}
	}
	if m, _ := filepath.Glob(filepath.Join(dst, "A001", ".*"+journalSuffix)); len(m) != 0 {
		t.Errorf("journal left: %v", m)
	}
	// a normal run leaves no journal either
	if m, _ := filepath.Glob(filepath.Join(dst, "*", ".*"+journalSuffix)); len(m) != 0 {
		t.Errorf("journal left: %v", m)
	}
}

// Two names that only differ in case, onto a volume that ignores case.
func TestNamesThatCollideOnTheDestination(t *testing.T) {
	tmp := t.TempDir()
	if probeFolding(tmp).caseless {
		// a Mac disk cannot hold both names; volumes_darwin_test.go covers
		// this with a case-sensitive disk image
		t.Skip("the temporary folder ignores case")
	}
	src, dst := filepath.Join(tmp, "A001"), filepath.Join(tmp, "NAS")
	writeFile(t, filepath.Join(src, "Clip.mov"), []byte("one"), day)
	writeFile(t, filepath.Join(src, "clip.mov"), []byte("two!"), day)
	writeFile(t, filepath.Join(src, "other.mov"), []byte("fine"), day)
	os.MkdirAll(dst, 0o755)
	testFolding = func(string) nameFolding { return nameFolding{caseless: true} }
	defer func() { testFolding = nil }()
	st := runJob(t, Options{Sources: []string{src}, Destinations: []string{dst}, Subfolder: true}, nil)
	if st.Status != StatusFailed || st.FilesFailed != 2 || st.FilesCopied != 1 || st.ErrorCount != 2 {
		t.Fatalf("status %s failed %d copied %d errors %+v", st.Status, st.FilesFailed, st.FilesCopied, st.Errors)
	}
	for _, e := range st.Errors {
		if !strings.Contains(e.Message, "differs only in upper/lower case") {
			t.Errorf("message: %+v", e)
		}
	}
	if _, err := os.Stat(filepath.Join(dst, "A001", "other.mov")); err != nil {
		t.Error("the other file was not copied")
	}
	for _, n := range []string{"Clip.mov", "clip.mov"} {
		if _, err := os.Stat(filepath.Join(dst, "A001", n)); err == nil {
			t.Errorf("%s was copied", n)
		}
	}
}

func TestProbeFoldingOnThisVolume(t *testing.T) {
	f := probeFolding(t.TempDir())
	t.Logf("this volume: caseless %v, formless %v", f.caseless, f.formless)
	if m, _ := filepath.Glob(filepath.Join(t.TempDir(), "*")); len(m) != 0 {
		t.Errorf("probe left files: %v", m)
	}
}

// A file that appears under the final name while its copy is verified
// (another app, another G-Copy) is set aside, not overwritten.
func TestFileThatAppearsMeanwhileIsKept(t *testing.T) {
	tmp := t.TempDir()
	src, dst := filepath.Join(tmp, "A001"), filepath.Join(tmp, "NAS")
	writeFile(t, filepath.Join(src, "a.mov"), []byte("ours"), day)
	os.MkdirAll(dst, 0o755)
	st := runJob(t, Options{Sources: []string{src}, Destinations: []string{dst}, Subfolder: true}, func(tmpPath string) {
		os.WriteFile(filepath.Join(filepath.Dir(tmpPath), "a.mov"), []byte("theirs"), 0o644)
	})
	if st.Status != StatusDone {
		t.Fatalf("%s %+v", st.Status, st.Errors)
	}
	if got, _ := os.ReadFile(filepath.Join(dst, "A001", "a.mov")); string(got) != "ours" {
		t.Errorf("final file: %q", got)
	}
	kept := findOne(t, filepath.Join(dst, ReplacedDirName, "*", "A001", "a.mov"))
	if got, _ := os.ReadFile(kept); string(got) != "theirs" {
		t.Errorf("kept: %q", got)
	}
}

func TestPermissionsAndReadOnlyLeftovers(t *testing.T) {
	tmp := t.TempDir()
	src, dst := filepath.Join(tmp, "A001"), filepath.Join(tmp, "NAS")
	writeFile(t, filepath.Join(src, "ro.mov"), []byte("read only"), day)
	writeFile(t, filepath.Join(src, "rw.mov"), []byte("normal"), day)
	os.Chmod(filepath.Join(src, "ro.mov"), 0o444)
	os.Chmod(filepath.Join(src, "rw.mov"), 0o640)
	// a read-only temporary file left by an interrupted run
	left := filepath.Join(dst, "A001", tempName("ro.mov"))
	writeFile(t, left, []byte("junk"), day)
	os.Chmod(left, 0o444)
	st := runJob(t, Options{Sources: []string{src}, Destinations: []string{dst}, Subfolder: true}, nil)
	if st.Status != StatusDone {
		t.Fatalf("%s %+v", st.Status, st.Errors)
	}
	for n, want := range map[string]os.FileMode{"ro.mov": 0o444, "rw.mov": 0o640} {
		fi, err := os.Stat(filepath.Join(dst, "A001", n))
		if err != nil || fi.Mode().Perm() != want&^procUmask {
			t.Errorf("%s: %v %v, want %v", n, fi.Mode(), err, want&^procUmask)
		}
	}
	noPartials(t, dst)
}

func TestRetryableErrors(t *testing.T) {
	pe := func(e error) error {
		return fmt.Errorf("Write error: %w", &fs.PathError{Op: "write", Path: "x", Err: e})
	}
	for err, want := range map[error]bool{
		pe(syscall.EIO):                       true,
		pe(syscall.ETIMEDOUT):                 true,
		pe(syscall.ENOENT):                    true,
		&mismatchError{"Checksum mismatch"}:   true,
		pe(syscall.ENOSPC):                    false,
		pe(syscall.EACCES):                    false,
		pe(syscall.EPERM):                     false,
		pe(syscall.EROFS):                     false,
		pe(syscall.ENAMETOOLONG):              false,
		errSourceChanged:                      false,
		fmt.Errorf("x: %w", context.Canceled): false,
	} {
		if got := retryable(err); got != want {
			t.Errorf("retryable(%v) = %v, want %v", err, got, want)
		}
	}
}

func TestSlotsServeInOrder(t *testing.T) {
	s := newSlots(4)
	ctx := context.Background()
	s.take(ctx, 1)
	var order []string
	var mu sync.Mutex
	var wg sync.WaitGroup
	got := func(name string) { mu.Lock(); order = append(order, name); mu.Unlock() }
	wg.Add(2)
	go func() { defer wg.Done(); s.take(ctx, 4); got("big"); s.give(4) }()
	time.Sleep(20 * time.Millisecond)
	go func() { defer wg.Done(); s.take(ctx, 1); got("small"); s.give(1) }()
	time.Sleep(20 * time.Millisecond)
	if len(order) != 0 {
		t.Fatalf("small one overtook the big one: %v", order)
	}
	s.give(1)
	wg.Wait()
	if strings.Join(order, ",") != "big,small" {
		t.Errorf("order %v", order)
	}

	// a waiter that gives up does not block the others
	s.take(ctx, 4)
	cctx, cancel := context.WithCancel(ctx)
	res := make(chan bool)
	go func() { res <- s.take(cctx, 2) }()
	time.Sleep(10 * time.Millisecond)
	cancel()
	if <-res {
		t.Error("cancelled take succeeded")
	}
	s.give(4)
	if !s.take(ctx, 4) {
		t.Error("slots were lost")
	}
}

type failingReader struct {
	data  []byte
	after int
	pos   int
}

func (r *failingReader) Read(p []byte) (int, error) {
	if r.pos >= r.after {
		return 0, syscall.EIO
	}
	n := copy(p, r.data[r.pos:r.after])
	r.pos += n
	return n, nil
}

func TestReadChunks(t *testing.T) {
	data := randBytes(5, 3*chunkSize+777)
	var got bytes.Buffer
	if err := readChunks(context.Background(), bytes.NewReader(data), "x", func(b []byte) bool { got.Write(b); return true }); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got.Bytes(), data) {
		t.Error("data differs")
	}
	// a read error in the middle
	got.Reset()
	err := readChunks(context.Background(), &failingReader{data: data, after: chunkSize + 5}, "x", func(b []byte) bool { got.Write(b); return true })
	if !errors.Is(err, syscall.EIO) || got.Len() > chunkSize+5 {
		t.Errorf("err %v, got %d bytes", err, got.Len())
	}
	// stopping early, many times: no buffer may be lost or leak
	for k := 0; k < 50; k++ {
		n := 0
		readChunks(context.Background(), bytes.NewReader(data), "x", func(b []byte) bool { n++; return n < 2 })
	}
	if len(bufFree) > cap(bufFree) {
		t.Error("free list overflow")
	}
	// empty input
	if err := readChunks(context.Background(), bytes.NewReader(nil), "x", func([]byte) bool { t.Error("called"); return true }); err != nil {
		t.Error(err)
	}
}

func TestDiskOf(t *testing.T) {
	for from, want := range map[string]string{
		"/dev/disk4s2":            "/dev/disk4",
		"/dev/disk4s3":            "/dev/disk4",
		"/dev/disk3s1s1":          "/dev/disk3",
		"/dev/disk12s1":           "/dev/disk12",
		"/dev/rdisk5":             "/dev/disk5",
		"//me@NAS.local/Projects": "net:nas.local",
		"//nas.local/Archive":     "net:nas.local",
		"nas:/export/media":       "net:nas",
		"map auto_home":           "map auto_home",
		"/dev/sda1":               "/dev/sda1",
	} {
		if got := diskOf(from); got != want {
			t.Errorf("diskOf(%q) = %q, want %q", from, got, want)
		}
	}
}

// Two sources on two disks are read at the same time; on one disk they
// take turns. The result is the same either way.
func TestTwoSourceDisks(t *testing.T) {
	tmp := t.TempDir()
	var srcs []string
	for _, n := range []string{"CARD_A", "CARD_B"} {
		s := filepath.Join(tmp, n)
		writeFile(t, filepath.Join(s, "clip.mov"), randBytes(int64(len(n)), 20<<20), day)
		for i := 0; i < 20; i++ {
			writeFile(t, filepath.Join(s, "seq", fmt.Sprintf("f%02d.exr", i)), randBytes(int64(i), 30000), day)
		}
		srcs = append(srcs, s)
	}
	for _, separate := range []bool{false, true} {
		dst := filepath.Join(tmp, fmt.Sprintf("NAS_%v", separate))
		os.MkdirAll(dst, 0o755)
		if separate {
			testDiskKey = filepath.Base
		}
		j, err := start(Options{Sources: srcs, Destinations: []string{dst}}, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		j.Wait()
		testDiskKey = nil
		st := j.Snapshot()
		want := 1
		if separate {
			want = 2
		}
		if len(j.lanes) != want || st.Status != StatusDone || st.FilesCopied != 42 {
			t.Fatalf("separate %v: lanes %d status %s copied %d %+v", separate, len(j.lanes), st.Status, st.FilesCopied, st.Errors)
		}
		for _, s := range srcs {
			sameTree(t, s, treeDigest(t, s, nil), treeDigest(t, filepath.Join(dst, filepath.Base(s)), isReportOrKept))
		}
		if st.Dests[0].WorkDone != st.Dests[0].WorkTotal || st.WorkDone != st.WorkTotal {
			t.Errorf("progress %d/%d", st.WorkDone, st.WorkTotal)
		}
	}
}

// Verification turned off: files are copied but not read back, and nothing
// claims they were verified (no checksum report, no journal).
func TestCopyWithoutVerification(t *testing.T) {
	tmp := t.TempDir()
	src, dst := filepath.Join(tmp, "A001"), filepath.Join(tmp, "NAS")
	makeSource(t, src)
	os.MkdirAll(dst, 0o755)
	o := Options{Sources: []string{src}, Destinations: []string{dst}, Subfolder: true, NoVerify: true, Reverify: true}

	var bytes int64
	filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			if rel, _ := filepath.Rel(src, p); !isSrcJunk(rel) {
				fi, _ := d.Info()
				bytes += fi.Size()
			}
		}
		return nil
	})
	st := runJob(t, o, nil)
	if st.Status != StatusDone || st.FilesCopied != 45 || st.FilesVerified != 0 {
		t.Fatalf("status %s copied %d verified %d errors %+v", st.Status, st.FilesCopied, st.FilesVerified, st.Errors)
	}
	if st.Options.Reverify {
		t.Error("re-verify stayed on although verification is off")
	}
	// the work is one read of the source and one write per destination: no read-back
	if st.WorkTotal != bytes || st.Dests[0].WorkTotal != bytes || st.WorkDone != st.WorkTotal {
		t.Errorf("work %d/%d, destination %d, source bytes %d", st.WorkDone, st.WorkTotal, st.Dests[0].WorkTotal, bytes)
	}
	sameTree(t, "destination", treeDigest(t, src, isSrcJunk), treeDigest(t, filepath.Join(dst, "A001"), isReportOrKept))
	if m, _ := filepath.Glob(filepath.Join(dst, "A001", "*.mhl")); len(m) != 0 || len(st.Dests[0].Reports) != 0 {
		t.Errorf("an unverified run wrote a checksum report: %v %v", m, st.Dests[0].Reports)
	}
	if m, _ := filepath.Glob(filepath.Join(dst, "A001", ".*"+journalSuffix)); len(m) != 0 {
		t.Errorf("journal left: %v", m)
	}
	noPartials(t, dst)

	// The destination remembers that these copies were never verified.
	if st.Dests[0].Unverified != 45 {
		t.Errorf("unverified count %d, want 45", st.Dests[0].Unverified)
	}
	if _, err := os.Stat(filepath.Join(dst, "A001", unverifiedName)); err != nil {
		t.Errorf("no list of unverified copies: %v", err)
	}
	// Another unverified run: nothing to copy, and still not "verified".
	st = runJob(t, o, nil)
	if st.Status != StatusDone || st.FilesSkipped != 45 || st.Dests[0].Unverified != 45 {
		t.Fatalf("second unverified run: %s skipped %d unverified %d", st.Status, st.FilesSkipped, st.Dests[0].Unverified)
	}

	// Same size, other date: the content is still compared before deciding,
	// and only that comparison goes into a report. That file is verified now.
	victim := filepath.Join(dst, "A001", "CLIPS", "A001C002.mov")
	os.Chtimes(victim, day.Add(time.Hour), day.Add(time.Hour))
	time.Sleep(1100 * time.Millisecond)
	st = runJob(t, o, nil)
	if st.Status != StatusDone || st.DatesFixed != 1 || st.FilesCopied != 0 || st.Dests[0].Unverified != 44 {
		t.Fatalf("date check: status %s dates fixed %d copied %d unverified %d", st.Status, st.DatesFixed, st.FilesCopied, st.Dests[0].Unverified)
	}
	r := readMHL(t, findOne(t, filepath.Join(dst, "A001", "*.mhl")))
	if len(r.Hashes) != 1 || r.Hashes[0].File != "CLIPS/A001C002.mov" {
		t.Errorf("report lists %+v, want only the compared file", r.Hashes)
	}
}

// A copy made without verification that is not what the source holds is
// found by the next run with verification on (no extra option needed),
// replaced by a good copy, and the bad file is kept, not destroyed.
func TestUnverifiedCopiesAreCheckedByTheNextVerifiedRun(t *testing.T) {
	tmp := t.TempDir()
	src, dst := filepath.Join(tmp, "A001"), filepath.Join(tmp, "NAS")
	makeSource(t, src)
	os.MkdirAll(dst, 0o755)
	o := Options{Sources: []string{src}, Destinations: []string{dst}, Subfolder: true, NoVerify: true}
	// one copy is damaged on the way, unnoticed
	hook, flipped := damageHook(t, dst, 1)
	st := runJob(t, o, hook)
	if *flipped != 1 || st.Status != StatusDone || st.Retried != 0 || st.Dests[0].Unverified != 45 {
		t.Fatalf("unverified run: flipped %d status %s retried %d unverified %d", *flipped, st.Status, st.Retried, st.Dests[0].Unverified)
	}
	bad := filepath.Join(dst, "A001", "CLIPS", "A001C001.mov")
	damaged, _ := os.ReadFile(bad)
	good, _ := os.ReadFile(filepath.Join(src, "CLIPS", "A001C001.mov"))
	if bytes.Equal(damaged, good) {
		t.Fatal("test setup: the copy is not damaged")
	}

	// verification on, nothing else ticked
	o.NoVerify = false
	time.Sleep(1100 * time.Millisecond)
	st = runJob(t, o, nil)
	if st.Status != StatusDone || st.FilesCopied != 1 || st.FilesVerified != 44 || st.FilesSkipped != 0 || st.Dests[0].Unverified != 0 || st.Dests[0].Replaced != 1 {
		t.Fatalf("verified run: status %s copied %d re-checked %d skipped %d unverified %d replaced %d errors %+v",
			st.Status, st.FilesCopied, st.FilesVerified, st.FilesSkipped, st.Dests[0].Unverified, st.Dests[0].Replaced, st.Errors)
	}
	if len(st.Warnings) != 1 || !strings.Contains(st.Warnings[0], "1 file copied earlier without verification differed from the source and was copied again. The differing file was kept") {
		t.Errorf("warnings: %v", st.Warnings)
	}
	// the destination is now identical to the source…
	sameTree(t, "destination", treeDigest(t, src, isSrcJunk), treeDigest(t, filepath.Join(dst, "A001"), isReportOrKept))
	// …the differing file was kept aside…
	kept := findOne(t, filepath.Join(dst, ReplacedDirName, "*", "A001", "CLIPS", "A001C001.mov"))
	if got, _ := os.ReadFile(kept); !bytes.Equal(got, damaged) {
		t.Error("the kept file is not the one that was there")
	}
	// …every file is in the report, and the list of unverified copies is gone.
	if n := len(readMHL(t, findOne(t, filepath.Join(dst, "A001", "*.mhl"))).Hashes); n != 45 {
		t.Errorf("report lists %d files, want 45", n)
	}
	if _, err := os.Stat(filepath.Join(dst, "A001", unverifiedName)); !os.IsNotExist(err) {
		t.Errorf("the list of unverified copies is still there: %v", err)
	}
	// From here on it is an ordinary, verified backup.
	time.Sleep(1100 * time.Millisecond)
	st = runJob(t, o, nil)
	if st.WorkTotal != 0 || st.FilesSkipped != 45 || st.Dests[0].Unverified != 0 {
		t.Errorf("third run: work %d skipped %d unverified %d", st.WorkTotal, st.FilesSkipped, st.Dests[0].Unverified)
	}
}

// The list survives the app being killed, and sync mode leaves it alone.
func TestUnverifiedListSurvivesAndIsNotBackedUp(t *testing.T) {
	tmp := t.TempDir()
	src, dst := filepath.Join(tmp, "A001"), filepath.Join(tmp, "NAS")
	writeFile(t, filepath.Join(src, "a.mov"), []byte("aaaa"), day)
	writeFile(t, filepath.Join(src, "b.mov"), []byte("bbbb"), day)
	os.MkdirAll(dst, 0o755)
	testNoReports = true // ends like a crash: nothing is tidied up at the end
	st := runJob(t, Options{Sources: []string{src}, Destinations: []string{dst}, Subfolder: true, NoVerify: true}, nil)
	testNoReports = false
	if st.FilesCopied != 2 {
		t.Fatalf("copied %d", st.FilesCopied)
	}
	l := loadUnverified(filepath.Join(dst, "A001"))
	if len(l.items) != 2 {
		t.Fatalf("list after a crash: %v", l.items)
	}
	// a file that was replaced by hand since is no longer listed
	os.WriteFile(filepath.Join(dst, "A001", "b.mov"), []byte("longer now"), 0o644)
	if l := loadUnverified(filepath.Join(dst, "A001")); len(l.items) != 1 {
		t.Errorf("list after the file changed: %v", l.items)
	}
	// backing the destination up elsewhere does not carry the list along
	other := filepath.Join(tmp, "OTHER")
	os.MkdirAll(other, 0o755)
	runJob(t, Options{Sources: []string{filepath.Join(dst, "A001")}, Destinations: []string{other}, Subfolder: true}, nil)
	if _, err := os.Stat(filepath.Join(other, "A001", unverifiedName)); !os.IsNotExist(err) {
		t.Error("the list was copied as if it were media")
	}
	if !IsJunk(unverifiedName) {
		t.Error("not treated as a housekeeping file")
	}
}

// Pause holds the copy between chunks; resume continues it to the same
// verified result; a paused job can still be cancelled.
func TestPauseAndResume(t *testing.T) {
	tmp := t.TempDir()
	src, dst := filepath.Join(tmp, "A001"), filepath.Join(tmp, "NAS")
	for i := 0; i < 10; i++ {
		writeFile(t, filepath.Join(src, fmt.Sprintf("clip%02d.mov", i)), randBytes(int64(i), 24<<20), day)
	}
	os.MkdirAll(dst, 0o755)
	o := Options{Sources: []string{src}, Destinations: []string{dst}, Subfolder: true}
	j, err := start(o, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if j.Pause() {
		// scanning is over in an instant; if it was caught, it must refuse
		if s := j.Snapshot().Status; s != StatusCopying {
			t.Errorf("paused while %s", s)
		}
		j.Resume()
	}
	for j.Snapshot().WorkDone < 40<<20 {
		time.Sleep(2 * time.Millisecond)
	}
	if !j.Pause() {
		t.Fatal("could not pause while copying")
	}
	time.Sleep(300 * time.Millisecond) // chunks in flight finish
	a := j.Snapshot()
	time.Sleep(500 * time.Millisecond)
	b := j.Snapshot()
	if !a.Paused || !b.Paused || a.Status != StatusCopying || a.WorkDone != b.WorkDone || a.WorkDone >= a.WorkTotal {
		t.Fatalf("while paused: paused %v/%v status %s work %d → %d of %d", a.Paused, b.Paused, a.Status, a.WorkDone, b.WorkDone, a.WorkTotal)
	}
	if b.FinishAt != nil || b.ETA != 0 {
		t.Errorf("a finish time is shown while paused: %v %v", b.FinishAt, b.ETA)
	}
	j.Resume()
	j.Wait()
	st := j.Snapshot()
	if st.Status != StatusDone || st.Paused || st.FilesCopied != 10 || st.WorkDone != st.WorkTotal {
		t.Fatalf("after resume: %s paused %v copied %d work %d/%d errors %+v", st.Status, st.Paused, st.FilesCopied, st.WorkDone, st.WorkTotal, st.Errors)
	}
	sameTree(t, "destination", treeDigest(t, src, nil), treeDigest(t, filepath.Join(dst, "A001"), isReportOrKept))
	// the average speed does not count the time on hold
	if st.CopyRate <= 0 || st.CopyRate < float64(st.WorkDone)/st.Seconds {
		t.Errorf("copy rate %.0f, over the whole run %.0f", st.CopyRate, float64(st.WorkDone)/st.Seconds)
	}
	noPartials(t, dst)

	// cancel while paused
	dst2 := filepath.Join(tmp, "DAS")
	os.MkdirAll(dst2, 0o755)
	o.Destinations = []string{dst2}
	j, _ = start(o, nil, nil)
	for j.Snapshot().WorkDone < 30<<20 {
		time.Sleep(2 * time.Millisecond)
	}
	j.Pause()
	time.Sleep(200 * time.Millisecond)
	j.Cancel()
	done := make(chan struct{})
	go func() { j.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("a paused job did not end when cancelled")
	}
	if st := j.Snapshot(); st.Status != StatusCancelled || st.Paused {
		t.Errorf("after cancel: %s paused %v", st.Status, st.Paused)
	}
	noPartials(t, dst2)
}

// Once the source is read and compared, the snapshot says how big each
// source is and how much of it this run copies, and how big each disk is.
func TestSizesAfterScanning(t *testing.T) {
	tmp := t.TempDir()
	a, b, dst := filepath.Join(tmp, "A001"), filepath.Join(tmp, "B001"), filepath.Join(tmp, "NAS")
	writeFile(t, filepath.Join(a, "one.mov"), make([]byte, 1000), day)
	writeFile(t, filepath.Join(a, "two.mov"), make([]byte, 2000), day)
	writeFile(t, filepath.Join(a, ".DS_Store"), make([]byte, 50), day)
	writeFile(t, filepath.Join(b, "three.mov"), make([]byte, 4000), day)
	writeFile(t, filepath.Join(dst, "A001", "one.mov"), make([]byte, 1000), day) // already there
	st := runJob(t, Options{Sources: []string{a, b}, Destinations: []string{dst}}, nil)
	if st.Status != StatusDone || len(st.Sources) != 2 {
		t.Fatalf("%s %+v", st.Status, st.Sources)
	}
	if s := st.Sources[0]; s.Path != a || s.Files != 2 || s.Bytes != 3000 || s.CopyFiles != 1 || s.CopyBytes != 2000 {
		t.Errorf("first source: %+v", s)
	}
	if s := st.Sources[1]; s.Files != 1 || s.Bytes != 4000 || s.CopyFiles != 1 || s.CopyBytes != 4000 {
		t.Errorf("second source: %+v", s)
	}
	if d := st.Dests[0]; d.Need != 6000 || d.Total <= 0 || d.Free <= 0 || d.Free > d.Total {
		t.Errorf("destination: need %d free %d total %d", d.Need, d.Free, d.Total)
	}
}

// A preview says what a run would copy, without copying anything.
func TestPreviewBackup(t *testing.T) {
	tmp := t.TempDir()
	src, dst := filepath.Join(tmp, "A001"), filepath.Join(tmp, "NAS")
	writeFile(t, filepath.Join(src, "one.mov"), make([]byte, 1000), day)
	writeFile(t, filepath.Join(src, "two.mov"), make([]byte, 2500), day)
	writeFile(t, filepath.Join(dst, "A001", "one.mov"), make([]byte, 1000), day) // already there
	before := treeDigest(t, dst, nil)
	p, err := PreviewBackup(context.Background(), Options{Sources: []string{src}, Destinations: []string{dst}, Subfolder: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Sources) != 1 || p.Sources[0].Files != 2 || p.Sources[0].Bytes != 3500 || p.Sources[0].CopyBytes != 2500 {
		t.Errorf("sources: %+v", p.Sources)
	}
	if len(p.Dests) != 1 || p.Dests[0].Need != 2500 || p.Dests[0].Path != dst || p.Dests[0].Volume == "" {
		t.Errorf("dests: %+v", p.Dests)
	}
	sameTree(t, "destination untouched", before, treeDigest(t, dst, nil))
	if m, _ := filepath.Glob(filepath.Join(dst, "*", ".*")); len(m) != 0 {
		t.Errorf("left files behind: %v", m)
	}
	// a destination too small is reported in the numbers, not as an error
	if VolumeKey(dst) != VolumeKey(tmp) {
		t.Errorf("one disk, two keys: %q %q", VolumeKey(dst), VolumeKey(tmp))
	}
	// a source that is gone is an error
	if _, err := PreviewBackup(context.Background(), Options{Sources: []string{filepath.Join(tmp, "gone")}, Destinations: []string{dst}}); err == nil || !IsMissing(err) {
		t.Errorf("missing source: %v", err)
	}
	// it stops when asked
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := PreviewBackup(ctx, Options{Sources: []string{src}, Destinations: []string{dst}}); err == nil {
		t.Error("a cancelled preview did not stop")
	}
}
