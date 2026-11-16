package engine

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io/fs"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/cespare/xxhash/v2"
)

// ── helpers ────────────────────────────────────────────────────────────

func writeFile(t *testing.T, path string, data []byte, mod time.Time) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, mod, mod); err != nil {
		t.Fatal(err)
	}
}

func randBytes(seed int64, n int) []byte {
	b := make([]byte, n)
	rand.New(rand.NewSource(seed)).Read(b)
	return b
}

var day = time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)

// makeSource builds a card-like tree: clips of several sizes, an image
// sequence, an empty file, an empty folder, Korean names, and OS junk.
func makeSource(t *testing.T, root string) {
	t.Helper()
	writeFile(t, filepath.Join(root, "CLIPS", "A001C001.mov"), randBytes(1, 21<<20+12345), day) // big, not chunk aligned
	writeFile(t, filepath.Join(root, "CLIPS", "A001C002.mov"), randBytes(2, 4<<20), day)        // exactly one chunk
	writeFile(t, filepath.Join(root, "CLIPS", "A001C003.mov"), randBytes(3, 4<<20+1), day)
	for i := 0; i < 40; i++ {
		writeFile(t, filepath.Join(root, "SEQ", "shot010", fmt.Sprintf("shot010.%04d.exr", i)), randBytes(int64(100+i), 30000+i), day)
	}
	writeFile(t, filepath.Join(root, "문서", "촬영 노트.txt"), []byte("1롤 OK\n"), day)
	writeFile(t, filepath.Join(root, "empty.bin"), nil, day)
	if err := os.MkdirAll(filepath.Join(root, "EMPTY_DIR", "deep"), 0o755); err != nil {
		t.Fatal(err)
	}
	// junk that must not be copied
	writeFile(t, filepath.Join(root, ".DS_Store"), []byte("x"), day)
	writeFile(t, filepath.Join(root, "CLIPS", "._A001C001.mov"), []byte("x"), day)
	writeFile(t, filepath.Join(root, ".Spotlight-V100", "store.db"), []byte("x"), day)
}

// treeDigest maps relative path -> sha256, computed independently of the
// engine's own hashing.
func treeDigest(t *testing.T, root string, skip func(rel string) bool) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		if d.IsDir() || (skip != nil && skip(rel)) {
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		out[filepath.ToSlash(rel)] = hex.EncodeToString(sum[:])
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func isSrcJunk(rel string) bool {
	for _, part := range strings.Split(filepath.ToSlash(rel), "/") {
		if IsJunk(part) {
			return true
		}
	}
	return false
}

func isReportOrKept(rel string) bool {
	return strings.HasSuffix(rel, ".mhl") || strings.HasPrefix(filepath.ToSlash(rel), ReplacedDirName+"/")
}

func sameTree(t *testing.T, what string, want, got map[string]string) {
	t.Helper()
	if len(want) != len(got) {
		t.Errorf("%s: %d files, want %d", what, len(got), len(want))
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s: %s differs or is missing", what, k)
		}
	}
	for k := range got {
		if _, ok := want[k]; !ok {
			t.Errorf("%s: unexpected file %s", what, k)
		}
	}
}

func runJob(t *testing.T, o Options, hook func(string)) State {
	t.Helper()
	j, err := start(o, nil, hook)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	j.Wait()
	return j.Snapshot()
}

func noPartials(t *testing.T, roots ...string) {
	t.Helper()
	for _, root := range roots {
		filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err == nil && strings.HasSuffix(p, partialSuffix) {
				t.Errorf("temporary file left behind: %s", p)
			}
			return nil
		})
	}
}

func findOne(t *testing.T, pattern string) string {
	t.Helper()
	m, _ := filepath.Glob(pattern)
	if len(m) != 1 {
		t.Fatalf("glob %s: got %d matches, want 1", pattern, len(m))
	}
	return m[0]
}

// ── tests ──────────────────────────────────────────────────────────────

func TestXXH64KnownVectors(t *testing.T) {
	for in, want := range map[string]string{
		"":    "ef46db3751d8e999",
		"a":   "d24ec4f1a98c6e5b",
		"abc": "44bc2cf5ad770999",
	} {
		h := newHasher("xxh64")
		h.Write([]byte(in))
		if got := hex.EncodeToString(h.Sum(nil)); got != want {
			t.Errorf("xxh64(%q) = %s, want %s", in, got, want)
		}
	}
	h := newHasher("md5")
	h.Write([]byte("abc"))
	if got := hex.EncodeToString(h.Sum(nil)); got != "900150983cd24fb0d6963f7d28e17f72" {
		t.Errorf("md5(abc) = %s", got)
	}
}

type mhlDoc struct {
	Version string `xml:"version,attr"`
	Hashes  []struct {
		File string `xml:"file"`
		Size int64  `xml:"size"`
		XXH  string `xml:"xxhash64be"`
		MD5  string `xml:"md5"`
	} `xml:"hash"`
}

func readMHL(t *testing.T, path string) mhlDoc {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var doc mhlDoc
	if err := xml.Unmarshal(data, &doc); err != nil {
		t.Fatalf("MHL is not valid XML: %v", err)
	}
	return doc
}

func TestCopyVerifyTwoDestinations(t *testing.T) {
	tmp := t.TempDir()
	src := filepath.Join(tmp, "A001")
	d1, d2 := filepath.Join(tmp, "NAS"), filepath.Join(tmp, "DAS")
	makeSource(t, src)
	os.MkdirAll(d1, 0o755)
	os.MkdirAll(d2, 0o755)

	st := runJob(t, Options{Sources: []string{src}, Destinations: []string{d1, d2}, Subfolder: true}, nil)
	if st.Status != StatusDone {
		t.Fatalf("status %s, errors %+v, message %q", st.Status, st.Errors, st.Message)
	}
	want := treeDigest(t, src, isSrcJunk)
	if len(want) != 45 {
		t.Fatalf("test setup: %d source files, want 45", len(want))
	}
	if st.FilesCopied != 45 || st.FilesSkipped != 0 || st.FilesFailed != 0 || st.Excluded != 3 {
		t.Errorf("counts: copied %d skipped %d failed %d excluded %d", st.FilesCopied, st.FilesSkipped, st.FilesFailed, st.Excluded)
	}
	if !st.Dests[0].Complete || !st.Dests[1].Complete {
		t.Errorf("destinations not marked complete: %+v", st.Dests)
	}
	if st.WorkDone != st.WorkTotal || st.WorkTotal != 3*st.ScanBytes {
		t.Errorf("progress: done %d total %d, scan bytes %d (want total = 3x: 1 read + 2 read-backs)", st.WorkDone, st.WorkTotal, st.ScanBytes)
	}

	for _, d := range []string{d1, d2} {
		base := filepath.Join(d, "A001")
		sameTree(t, d, want, treeDigest(t, base, isReportOrKept))
		if fi, err := os.Stat(filepath.Join(base, "EMPTY_DIR", "deep")); err != nil || !fi.IsDir() {
			t.Errorf("%s: empty folder not recreated", d)
		}
		fi, err := os.Stat(filepath.Join(base, "CLIPS", "A001C001.mov"))
		if err != nil || !fi.ModTime().Equal(day) {
			t.Errorf("%s: modification time not preserved", d)
		}
		// The report must list every file with the correct xxHash64.
		doc := readMHL(t, findOne(t, filepath.Join(base, "A001_*.mhl")))
		if doc.Version != "1.1" || len(doc.Hashes) != 45 {
			t.Fatalf("%s: MHL version %q with %d entries", d, doc.Version, len(doc.Hashes))
		}
		for _, h := range doc.Hashes {
			data, err := os.ReadFile(filepath.Join(base, filepath.FromSlash(h.File)))
			if err != nil {
				t.Fatalf("MHL lists %s: %v", h.File, err)
			}
			if got := fmt.Sprintf("%016x", xxhash.Sum64(data)); got != h.XXH || h.Size != int64(len(data)) {
				t.Errorf("MHL %s: hash %s size %d, file has %s size %d", h.File, h.XXH, h.Size, got, len(data))
			}
		}
	}
	noPartials(t, d1, d2)
}

func TestIncrementalAndReplacedFilesAreKept(t *testing.T) {
	tmp := t.TempDir()
	src, dst := filepath.Join(tmp, "A001"), filepath.Join(tmp, "NAS")
	makeSource(t, src)
	os.MkdirAll(dst, 0o755)
	o := Options{Sources: []string{src}, Destinations: []string{dst}, Subfolder: true}

	if st := runJob(t, o, nil); st.Status != StatusDone {
		t.Fatalf("first run: %s %+v", st.Status, st.Errors)
	}

	// Second run: nothing changed, so nothing may be copied or reported.
	time.Sleep(1100 * time.Millisecond) // a new report would get a new name
	st := runJob(t, o, nil)
	if st.Status != StatusDone || st.FilesCopied != 0 || st.FilesSkipped != 45 || st.WorkTotal != 0 || st.Dests[0].Bytes != 0 {
		t.Fatalf("second run: status %s copied %d skipped %d work %d bytes %d", st.Status, st.FilesCopied, st.FilesSkipped, st.WorkTotal, st.Dests[0].Bytes)
	}
	if m, _ := filepath.Glob(filepath.Join(dst, "A001", "*.mhl")); len(m) != 1 {
		t.Errorf("a run that copied nothing wrote a report: %v", m)
	}

	// Third run: one file changed, one added.
	changed := filepath.Join(src, "문서", "촬영 노트.txt")
	old, _ := os.ReadFile(changed)
	writeFile(t, changed, []byte("1롤 OK\n2롤 NG\n"), day.Add(time.Hour))
	writeFile(t, filepath.Join(src, "CLIPS", "A001C004.mov"), randBytes(9, 100000), day)
	time.Sleep(1100 * time.Millisecond)
	st = runJob(t, o, nil)
	if st.Status != StatusDone || st.FilesCopied != 2 || st.FilesSkipped != 44 || st.Dests[0].Replaced != 1 {
		t.Fatalf("third run: status %s copied %d skipped %d replaced %d errors %+v", st.Status, st.FilesCopied, st.FilesSkipped, st.Dests[0].Replaced, st.Errors)
	}
	sameTree(t, "after third run", treeDigest(t, src, isSrcJunk), treeDigest(t, filepath.Join(dst, "A001"), isReportOrKept))

	// The previous version must have been moved aside, not destroyed.
	kept := findOne(t, filepath.Join(dst, ReplacedDirName, "*", "A001", "문서", "촬영 노트.txt"))
	if got, _ := os.ReadFile(kept); string(got) != string(old) {
		t.Errorf("kept version has content %q, want %q", got, old)
	}
	noPartials(t, dst)
}

func TestCorruptedCopyIsDetectedAndDiscarded(t *testing.T) {
	tmp := t.TempDir()
	src := filepath.Join(tmp, "A001")
	good, bad := filepath.Join(tmp, "GOOD"), filepath.Join(tmp, "BAD")
	makeSource(t, src)
	os.MkdirAll(good, 0o755)
	os.MkdirAll(bad, 0o755)
	o := Options{Sources: []string{src}, Destinations: []string{good, bad}, Subfolder: true}

	// Flip one bit in the middle of one clip on one destination, after it
	// was written and before it is read back: what a bad cable would do.
	flip := func(path string) {
		if !strings.HasPrefix(path, bad) || !strings.Contains(path, "A001C001.mov") {
			return
		}
		f, err := os.OpenFile(path, os.O_RDWR, 0)
		if err != nil {
			t.Errorf("hook: %v", err)
			return
		}
		defer f.Close()
		one := make([]byte, 1)
		f.ReadAt(one, 10<<20)
		one[0] ^= 0x01
		f.WriteAt(one, 10<<20)
	}
	st := runJob(t, o, flip)
	if st.Status != StatusFailed || st.FilesFailed != 1 || st.ErrorCount != 1 {
		t.Fatalf("status %s failed %d errors %+v", st.Status, st.FilesFailed, st.Errors)
	}
	e := st.Errors[0]
	if !strings.Contains(e.Message, "체크섬 불일치") || e.Dest != bad || e.Path != "A001/CLIPS/A001C001.mov" {
		t.Errorf("unexpected error record: %+v", e)
	}
	// The damaged copy must not exist under its real name, nor as a leftover.
	if _, err := os.Stat(filepath.Join(bad, "A001", "CLIPS", "A001C001.mov")); !os.IsNotExist(err) {
		t.Errorf("damaged copy was kept: %v", err)
	}
	noPartials(t, good, bad)
	want := treeDigest(t, src, isSrcJunk)
	sameTree(t, "good destination", want, treeDigest(t, filepath.Join(good, "A001"), isReportOrKept))
	if st.Dests[0].Failed != 0 || st.Dests[1].Failed != 1 || st.Dests[1].Copied != 44 {
		t.Errorf("per-destination counts: %+v", st.Dests)
	}
	// The healthy destination is whole even though the run as a whole failed.
	if !st.Dests[0].Complete || st.Dests[1].Complete {
		t.Errorf("complete flags: good %v, bad %v", st.Dests[0].Complete, st.Dests[1].Complete)
	}

	// Running again repairs exactly the one missing file.
	time.Sleep(1100 * time.Millisecond)
	st = runJob(t, o, nil)
	if st.Status != StatusDone || st.FilesCopied != 1 || st.Dests[0].Copied != 0 || st.Dests[1].Copied != 1 {
		t.Fatalf("repair run: status %s copied %d dests %+v", st.Status, st.FilesCopied, st.Dests)
	}
	sameTree(t, "repaired destination", want, treeDigest(t, filepath.Join(bad, "A001"), isReportOrKept))
}

func TestReverifyFindsSilentDamage(t *testing.T) {
	tmp := t.TempDir()
	src, dst := filepath.Join(tmp, "A001"), filepath.Join(tmp, "NAS")
	makeSource(t, src)
	os.MkdirAll(dst, 0o755)
	o := Options{Sources: []string{src}, Destinations: []string{dst}, Subfolder: true}
	if st := runJob(t, o, nil); st.Status != StatusDone {
		t.Fatalf("first run: %s", st.Status)
	}

	// Damage a stored file without changing its size or date.
	victim := filepath.Join(dst, "A001", "SEQ", "shot010", "shot010.0007.exr")
	data, _ := os.ReadFile(victim)
	data[100] ^= 0xff
	writeFile(t, victim, data, day)

	// A normal run compares size and date only, so it does not notice.
	if st := runJob(t, o, nil); st.Status != StatusDone || st.FilesSkipped != 45 {
		t.Fatalf("normal run: %s skipped %d", st.Status, st.FilesSkipped)
	}
	// A re-verifying run hashes both sides and must notice.
	o.Reverify = true
	st := runJob(t, o, nil)
	if st.Status != StatusFailed || st.FilesFailed != 1 || st.FilesVerified != 44 {
		t.Fatalf("reverify run: status %s failed %d verified %d", st.Status, st.FilesFailed, st.FilesVerified)
	}
	if !strings.Contains(st.Errors[0].Message, "기존 파일의 내용이 원본과 다릅니다") {
		t.Errorf("message: %s", st.Errors[0].Message)
	}
	// It reports; it must not silently overwrite either side.
	if got, _ := os.ReadFile(victim); string(got) != string(data) {
		t.Error("reverify modified the destination file")
	}
}

func TestCancelLeavesNoPartialFiles(t *testing.T) {
	tmp := t.TempDir()
	src, dst := filepath.Join(tmp, "A001"), filepath.Join(tmp, "NAS")
	for i := 0; i < 12; i++ {
		writeFile(t, filepath.Join(src, fmt.Sprintf("clip%02d.mov", i)), randBytes(int64(i), 24<<20), day)
	}
	os.MkdirAll(dst, 0o755)

	j, err := start(Options{Sources: []string{src}, Destinations: []string{dst}, Subfolder: true}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	for j.Snapshot().WorkDone < 30<<20 { // wait until it is really copying
		time.Sleep(2 * time.Millisecond)
	}
	j.Cancel()
	j.Wait()
	st := j.Snapshot()
	if st.Status != StatusCancelled {
		t.Fatalf("status %s", st.Status)
	}
	if st.FilesCopied >= 12 {
		t.Fatalf("cancel came too late to test anything (copied %d)", st.FilesCopied)
	}
	noPartials(t, dst)
	// Whatever did get a real name must be complete and correct.
	want := treeDigest(t, src, nil)
	got := treeDigest(t, filepath.Join(dst, "A001"), isReportOrKept)
	if int64(len(got)) != st.FilesCopied {
		t.Errorf("%d files on disk, job says %d copied", len(got), st.FilesCopied)
	}
	for k, v := range got {
		if want[k] != v {
			t.Errorf("file %s kept after cancel is not identical to the source", k)
		}
	}
}

func TestMultipleSourcesAndMD5(t *testing.T) {
	tmp := t.TempDir()
	a, b, dst := filepath.Join(tmp, "A001"), filepath.Join(tmp, "B001"), filepath.Join(tmp, "NAS")
	writeFile(t, filepath.Join(a, "a.mov"), randBytes(1, 70000), day)
	writeFile(t, filepath.Join(b, "sub", "b.mov"), randBytes(2, 80000), day)
	os.MkdirAll(dst, 0o755)

	st := runJob(t, Options{Sources: []string{a, b}, Destinations: []string{dst}, Algo: "md5"}, nil)
	if st.Status != StatusDone || st.FilesCopied != 2 {
		t.Fatalf("status %s copied %d errors %+v", st.Status, st.FilesCopied, st.Errors)
	}
	sameTree(t, "A001", treeDigest(t, a, nil), treeDigest(t, filepath.Join(dst, "A001"), isReportOrKept))
	sameTree(t, "B001", treeDigest(t, b, nil), treeDigest(t, filepath.Join(dst, "B001"), isReportOrKept))
	doc := readMHL(t, findOne(t, filepath.Join(dst, "B001", "B001_*.mhl")))
	if len(doc.Hashes) != 1 || doc.Hashes[0].File != "sub/b.mov" || len(doc.Hashes[0].MD5) != 32 || doc.Hashes[0].XXH != "" {
		t.Errorf("md5 report: %+v", doc.Hashes)
	}
	sort.Strings(st.Dests[0].Reports)
	if len(st.Dests[0].Reports) != 2 {
		t.Errorf("reports: %v", st.Dests[0].Reports)
	}
}

func TestWithoutSubfolder(t *testing.T) {
	tmp := t.TempDir()
	src, dst := filepath.Join(tmp, "A001"), filepath.Join(tmp, "NAS")
	writeFile(t, filepath.Join(src, "x", "a.mov"), randBytes(1, 5000), day)
	os.MkdirAll(dst, 0o755)
	st := runJob(t, Options{Sources: []string{src}, Destinations: []string{dst}, Subfolder: false}, nil)
	if st.Status != StatusDone {
		t.Fatalf("status %s %+v", st.Status, st.Errors)
	}
	if _, err := os.Stat(filepath.Join(dst, "x", "a.mov")); err != nil {
		t.Errorf("file not placed directly in the destination: %v", err)
	}
}

func TestUnsafeSelectionsAreRefused(t *testing.T) {
	tmp := t.TempDir()
	src := filepath.Join(tmp, "A001")
	inside := filepath.Join(src, "backup")
	other := filepath.Join(tmp, "x", "A001")
	dst := filepath.Join(tmp, "NAS")
	for _, d := range []string{inside, other, dst} {
		os.MkdirAll(d, 0o755)
	}
	link := filepath.Join(tmp, "link-to-nas")
	if err := os.Symlink(dst, link); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(tmp, "file.txt")
	os.WriteFile(file, []byte("x"), 0o644)

	cases := []struct {
		name string
		o    Options
		want string
	}{
		{"no source", Options{Destinations: []string{dst}}, "원본을 하나 이상"},
		{"no destination", Options{Sources: []string{src}}, "대상을 하나 이상"},
		{"destination inside source", Options{Sources: []string{src}, Destinations: []string{inside}}, "원본 안에"},
		{"destination is the source", Options{Sources: []string{src}, Destinations: []string{src}}, "원본과 같거나"},
		{"subfolder lands on the source", Options{Sources: []string{src}, Destinations: []string{tmp}, Subfolder: true}, "원본과 같거나"},
		{"same destination twice via symlink", Options{Sources: []string{src}, Destinations: []string{dst, link}}, "두 번 선택"},
		{"two sources with one name", Options{Sources: []string{src, other}, Destinations: []string{dst}}, "이름이 같은 원본"},
		{"missing source", Options{Sources: []string{filepath.Join(tmp, "nope")}, Destinations: []string{dst}}, "찾을 수 없습니다"},
		{"source is a file", Options{Sources: []string{file}, Destinations: []string{dst}}, "폴더가 아닙니다"},
		{"unknown algorithm", Options{Sources: []string{src}, Destinations: []string{dst}, Algo: "crc"}, "알고리즘"},
	}
	for _, c := range cases {
		j, err := start(c.o, nil, nil)
		if err == nil {
			j.Wait()
			t.Errorf("%s: accepted, want refusal", c.name)
			continue
		}
		if !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: error %q does not mention %q", c.name, err, c.want)
		}
	}
	// A refused request must not have written anything.
	if entries, _ := os.ReadDir(dst); len(entries) != 0 {
		t.Errorf("refused requests left files in the destination: %v", entries)
	}
}

func TestDestinationFolderBlockingAFile(t *testing.T) {
	tmp := t.TempDir()
	src, dst := filepath.Join(tmp, "A001"), filepath.Join(tmp, "NAS")
	writeFile(t, filepath.Join(src, "a.mov"), randBytes(1, 5000), day)
	writeFile(t, filepath.Join(src, "b.mov"), randBytes(2, 5000), day)
	os.MkdirAll(filepath.Join(dst, "A001", "a.mov"), 0o755) // a folder where a file should go

	st := runJob(t, Options{Sources: []string{src}, Destinations: []string{dst}, Subfolder: true}, nil)
	if st.Status != StatusFailed || st.FilesFailed != 1 || st.FilesCopied != 1 || st.WorkDone != st.WorkTotal {
		t.Fatalf("status %s failed %d copied %d work %d/%d", st.Status, st.FilesFailed, st.FilesCopied, st.WorkDone, st.WorkTotal)
	}
	if fi, err := os.Stat(filepath.Join(dst, "A001", "a.mov")); err != nil || !fi.IsDir() {
		t.Error("the existing folder was touched")
	}
}

func TestUnreadableSourceFolderIsReported(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can read everything; permissions cannot be tested")
	}
	tmp := t.TempDir()
	src, dst := filepath.Join(tmp, "A001"), filepath.Join(tmp, "NAS")
	writeFile(t, filepath.Join(src, "ok.mov"), randBytes(1, 5000), day)
	writeFile(t, filepath.Join(src, "locked", "secret.mov"), randBytes(2, 5000), day)
	os.Chmod(filepath.Join(src, "locked"), 0)
	defer os.Chmod(filepath.Join(src, "locked"), 0o755)
	os.MkdirAll(dst, 0o755)

	st := runJob(t, Options{Sources: []string{src}, Destinations: []string{dst}, Subfolder: true}, nil)
	if st.Status != StatusFailed || st.FilesCopied != 1 || st.Dests[0].Complete {
		t.Fatalf("status %s copied %d complete %v errors %+v", st.Status, st.FilesCopied, st.Dests[0].Complete, st.Errors)
	}
	if !strings.Contains(st.Errors[0].Message, "권한이 없습니다") || st.Errors[0].Path != "A001/locked" {
		t.Errorf("error record: %+v", st.Errors[0])
	}
}

func TestOSErrorsAreExplainedInKorean(t *testing.T) {
	_, err := os.Open(filepath.Join(t.TempDir(), "missing"))
	if got := osMsg(err); !strings.Contains(got, "찾을 수 없습니다") || strings.Contains(got, t.TempDir()) {
		t.Errorf("osMsg = %q", got)
	}
	wrapped := fmt.Errorf("쓰기 오류: %w", &fs.PathError{Op: "write", Path: "/x/y", Err: syscall.ENOSPC})
	if got := cleanMsg(wrapped); !strings.HasPrefix(got, "쓰기 오류: 디스크 공간이 없습니다") || strings.Contains(got, "/x/y") {
		t.Errorf("cleanMsg = %q", got)
	}
	if !isNoSpace(wrapped) {
		t.Error("isNoSpace did not see through the wrapping")
	}
}
