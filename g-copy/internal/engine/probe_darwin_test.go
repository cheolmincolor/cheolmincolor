//go:build darwin

package engine

// Probes for the copy review, run on the CI Mac. They only log what
// happens (lines starting with "PROBE"); they never fail the build.

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
func probeDisk(t *testing.T, fs, name string) string {
	t.Helper()
	dir := t.TempDir()
	img := filepath.Join(dir, name+".dmg")
	mnt := filepath.Join(dir, "mnt")
	os.MkdirAll(mnt, 0o755)
	if out, err := exec.Command("hdiutil", "create", "-size", "300m", "-fs", fs, "-volname", name, "-type", "UDIF", img).CombinedOutput(); err != nil {
		t.Skipf("PROBE %s: cannot create a %s disk: %v %s", name, fs, err, out)
	}
	if out, err := exec.Command("hdiutil", "attach", "-nobrowse", "-mountpoint", mnt, img).CombinedOutput(); err != nil {
		t.Skipf("PROBE %s: cannot mount: %v %s", name, err, out)
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
// (a Linux NAS share, a case-sensitive volume) to a normal Mac disk.
func TestProbeCaseCollision(t *testing.T) {
	src := filepath.Join(probeDisk(t, "Case-sensitive APFS", "CS"), "A001")
	writeFile(t, filepath.Join(src, "Clip.mov"), []byte(strings.Repeat("A", 1000)), day)
	writeFile(t, filepath.Join(src, "clip.mov"), []byte(strings.Repeat("b", 2000)), day)
	dst := t.TempDir() // the runner's normal, case-insensitive APFS
	st := runJob(t, Options{Sources: []string{src}, Destinations: []string{dst}, Subfolder: true}, nil)
	var mhl []string
	reports, _ := filepath.Glob(filepath.Join(dst, "A001", "*.mhl"))
	for _, r := range reports {
		for _, h := range readMHL(t, r).Hashes {
			mhl = append(mhl, fmt.Sprintf("%s(%d bytes)", h.File, h.Size))
		}
	}
	t.Logf("PROBE case collision: status %s, copied %d, failed %d, errors %v; destination has %v; report lists %v",
		st.Status, st.FilesCopied, st.FilesFailed, st.Errors, listTree(dst), mhl)
}

// FAT32 and exFAT destinations: does a second run skip everything?
func TestProbeFATDestinations(t *testing.T) {
	for _, fs := range []string{"MS-DOS FAT32", "ExFAT"} {
		dst := probeDisk(t, fs, strings.ReplaceAll(fs, " ", ""))
		src := filepath.Join(t.TempDir(), "A001")
		for i := 0; i < 10; i++ {
			// odd seconds and sub-second times, which FAT cannot store exactly
			m := day.Add(time.Duration(i)*time.Second + 337*time.Millisecond)
			writeFile(t, filepath.Join(src, fmt.Sprintf("c%02d.mov", i)), randBytes(int64(i), 50000), m)
		}
		o := Options{Sources: []string{src}, Destinations: []string{dst}, Subfolder: true}
		first := runJob(t, o, nil)
		time.Sleep(1100 * time.Millisecond)
		second := runJob(t, o, nil)
		t.Logf("PROBE %s: first run %s copied %d warnings %v; second run copied %d skipped %d",
			fs, first.Status, first.FilesCopied, first.Warnings, second.FilesCopied, second.FilesSkipped)
	}
}
