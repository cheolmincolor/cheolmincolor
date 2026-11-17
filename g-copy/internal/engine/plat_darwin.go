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

// syncLight flushes f to the device. The full drive-cache flush
// (F_FULLFSYNC, which os.File.Sync uses on macOS) is done once per
// destination at the end of a run, when the report is written.
func syncLight(f *os.File) error { return unix.Fsync(int(f.Fd())) }

func dropCache(*os.File) {}

func allocAligned(n int) []byte {
	b, err := unix.Mmap(-1, 0, n, unix.PROT_READ|unix.PROT_WRITE, unix.MAP_ANON|unix.MAP_PRIVATE)
	if err != nil {
		panic("g-copy: cannot allocate I/O buffer: " + err.Error())
	}
	return b
}

func freeAligned(b []byte) { _ = unix.Munmap(b) }
