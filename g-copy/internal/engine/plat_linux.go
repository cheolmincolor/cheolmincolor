package engine

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

func noCache(*os.File) {}

func flushFile(f *os.File, _ bool) error { return f.Sync() }

// renameNoReplace renames, failing with EEXIST if to already exists.
func renameNoReplace(from, to string) error {
	return unix.Renameat2(unix.AT_FDCWD, from, unix.AT_FDCWD, to, unix.RENAME_NOREPLACE)
}

func isNetworkFS(path string) bool {
	var st unix.Statfs_t
	if unix.Statfs(path, &st) != nil {
		return false
	}
	switch uint32(st.Type) {
	case 0x6969, // NFS
		0xfe534d42, // SMB2/3
		0xff534d42, // CIFS
		0x517b:     // SMB1
		return true
	}
	return false
}

// dropCache asks the kernel to forget cached pages of f (they must already
// be synced), so the verification pass reads the data back from the device.
func dropCache(f *os.File) {
	_ = unix.Fadvise(int(f.Fd()), 0, 0, unix.FADV_DONTNEED)
}

func allocAligned(n int) []byte {
	b, err := unix.Mmap(-1, 0, n, unix.PROT_READ|unix.PROT_WRITE, unix.MAP_ANON|unix.MAP_PRIVATE)
	if err != nil {
		panic("g-copy: cannot allocate I/O buffer: " + err.Error())
	}
	return b
}

func freeAligned(b []byte) { _ = unix.Munmap(b) }

// diskKey names the device that holds path ("" if unknown).
func diskKey(path string) string {
	var st unix.Stat_t
	if unix.Stat(path, &st) != nil {
		return ""
	}
	return fmt.Sprintf("dev:%d:%d", unix.Major(st.Dev), unix.Minor(st.Dev))
}
