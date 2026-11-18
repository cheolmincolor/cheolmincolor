package engine

import (
	"os"

	"golang.org/x/sys/unix"
)

// noCache turns off the unified buffer cache for f, so writes go to the
// device and read-back verification is not answered from memory.
func noCache(f *os.File) {
	_, _ = unix.FcntlInt(f.Fd(), unix.F_NOCACHE, 1)
}

func dropCache(*os.File) {}

func allocAligned(n int) []byte {
	b, err := unix.Mmap(-1, 0, n, unix.PROT_READ|unix.PROT_WRITE, unix.MAP_ANON|unix.MAP_PRIVATE)
	if err != nil {
		panic("g-copy: cannot allocate I/O buffer: " + err.Error())
	}
	return b
}

func freeAligned(b []byte) { _ = unix.Munmap(b) }

// flushFile pushes f to the device before it is read back. For large
// files it also asks the drive to empty its own write cache onto the
// media (F_FULLFSYNC), so the verification reads what is really stored.
// Volumes that cannot do that (most network shares) get a normal flush.
func flushFile(f *os.File, full bool) error {
	if full {
		if _, err := unix.FcntlInt(f.Fd(), unix.F_FULLFSYNC, 0); err == nil {
			return nil
		}
	}
	return unix.Fsync(int(f.Fd()))
}

// renameNoReplace renames, failing with EEXIST if to already exists.
func renameNoReplace(from, to string) error {
	return unix.RenamexNp(from, to, unix.RENAME_EXCL)
}

func isNetworkFS(path string) bool {
	var st unix.Statfs_t
	if unix.Statfs(path, &st) != nil {
		return false
	}
	switch unix.ByteSliceToString(st.Fstypename[:]) {
	case "smbfs", "nfs", "afpfs", "webdav", "cifs":
		return true
	}
	return false
}

// diskKey names the physical disk or server that holds path ("" if unknown).
func diskKey(path string) string {
	var st unix.Statfs_t
	if unix.Statfs(path, &st) != nil {
		return ""
	}
	return diskOf(unix.ByteSliceToString(st.Mntfromname[:]))
}
