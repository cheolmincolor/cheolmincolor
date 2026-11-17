package engine

import (
	"os"

	"golang.org/x/sys/unix"
)

func noCache(*os.File) {}

func syncLight(f *os.File) error { return f.Sync() }

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
