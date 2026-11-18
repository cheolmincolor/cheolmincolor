//go:build darwin

package engine

// Tests on real Mac volumes (disk images): a case-sensitive source, FAT32
// and exFAT destinations. They run on the CI Mac.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// disk makes and mounts a small disk image with the given file system.
func macDisk(t *testing.T, fs, name string) string {
	t.Helper()
	dir := t.TempDir()
	img := filepath.Join(dir, name+".dmg")
	mnt := filepath.Join(dir, "mnt")
	os.MkdirAll(mnt, 0o755)
	if out, err := exec.Command("hdiutil", "create", "-size", "300m", "-fs", fs, "-volname", name, "-type", "UDIF", img).CombinedOutput(); err != nil {
		t.Skipf("%s: cannot create a %s disk: %v %s", name, fs, err, out)
	}
	if out, err := exec.Command("hdiutil", "attach", "-nobrowse", "-mountpoint", mnt, img).CombinedOutput(); err != nil {
		t.Skipf("%s: cannot mount: %v %s", name, err, out)
	}
	t.Cleanup(func() { exec.Command("hdiutil", "detach", "-force", mnt).Run() })
	return mnt
}

func listTree(root string) []string {
	var out []string
	filepath.Walk(root, func(p string, fi os.FileInfo, err error) error {
		if err == nil && fi.Mode().IsRegular() {
			rel, _ := filepath.Rel(root, p)
			out = append(out, rel)
		}
		return nil
	})
	sort.Strings(out)
	return out
}

// Two files whose names differ only in case, from a case-sensitive source
// (a Linux NAS share, a case-sensitive volume) to a normal Mac disk: both
// are reported, neither replaces the other.
func TestCaseCollisionOnAMacDisk(t *testing.T) {
	src := filepath.Join(macDisk(t, "Case-sensitive APFS", "CS"), "A001")
	writeFile(t, filepath.Join(src, "Clip.mov"), []byte(strings.Repeat("A", 1000)), day)
	writeFile(t, filepath.Join(src, "clip.mov"), []byte(strings.Repeat("b", 2000)), day)
	writeFile(t, filepath.Join(src, "other.mov"), []byte("fine"), day)
	dst := t.TempDir() // the runner's normal, case-insensitive APFS
	if f := probeFolding(dst); !f.caseless || !f.formless {
		t.Errorf("APFS should ignore case and Unicode form, probe says %+v", f)
	}
	if f := probeFolding(src); f.caseless {
		t.Errorf("case-sensitive APFS probed as caseless: %+v", f)
	}
	st := runJob(t, Options{Sources: []string{src}, Destinations: []string{dst}, Subfolder: true}, nil)
	if st.Status != StatusFailed || st.FilesFailed != 2 || st.FilesCopied != 1 {
		t.Fatalf("status %s failed %d copied %d errors %+v", st.Status, st.FilesFailed, st.FilesCopied, st.Errors)
	}
	for _, e := range st.Errors {
		if !strings.Contains(e.Message, "differs only in upper/lower case") {
			t.Errorf("message: %+v", e)
		}
	}
	if got := listTree(dst); fmt.Sprint(got) != "[A001/"+filepath.Base(findOne(t, filepath.Join(dst, "A001", "*.mhl")))+" A001/other.mov]" {
		t.Errorf("destination has %v", got)
	}
}

// FAT32 and exFAT destinations keep dates only to 2 s (FAT) and lose
// sub-second parts: a second run must still skip everything.
func TestFATDestinations(t *testing.T) {
	for _, fs := range []string{"MS-DOS FAT32", "ExFAT"} {
		dst := macDisk(t, fs, strings.ReplaceAll(fs, " ", ""))
		src := filepath.Join(t.TempDir(), "A001")
		for i := 0; i < 10; i++ {
			// odd seconds and sub-second times, which FAT cannot store exactly
			m := day.Add(time.Duration(i)*time.Second + 337*time.Millisecond)
			writeFile(t, filepath.Join(src, fmt.Sprintf("c%02d.mov", i)), randBytes(int64(i), 50000), m)
		}
		o := Options{Sources: []string{src}, Destinations: []string{dst}, Subfolder: true}
		first := runJob(t, o, nil)
		if first.Status != StatusDone || first.FilesCopied != 10 {
			t.Errorf("%s first run: %s copied %d errors %+v", fs, first.Status, first.FilesCopied, first.Errors)
		}
		time.Sleep(1100 * time.Millisecond)
		second := runJob(t, o, nil)
		if second.Status != StatusDone || second.FilesCopied != 0 || second.FilesSkipped != 10 || second.DatesFixed != 0 {
			t.Errorf("%s second run: %s copied %d skipped %d dates fixed %d", fs, second.Status, second.FilesCopied, second.FilesSkipped, second.DatesFixed)
		}
		sameTree(t, fs, treeDigest(t, src, nil), treeDigest(t, filepath.Join(dst, "A001"), isReportOrKept))
	}
}

// Two disk images are two disks; two folders of the startup disk are one.
func TestDiskKeysOnAMac(t *testing.T) {
	a, b := macDisk(t, "APFS", "DA"), macDisk(t, "APFS", "DB")
	ka, kb := diskKey(a), diskKey(b)
	k1, k2 := diskKey(t.TempDir()), diskKey(os.Getenv("HOME"))
	t.Logf("disk image A %q, B %q, temp %q, home %q", ka, kb, k1, k2)
	if ka == "" || ka == kb {
		t.Errorf("two disk images should be two disks: %q %q", ka, kb)
	}
	if k1 == "" || k1 != k2 {
		t.Errorf("temp folder and home folder are on the startup disk: %q %q", k1, k2)
	}
}
