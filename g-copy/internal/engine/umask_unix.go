//go:build darwin || linux

package engine

import (
	"os"

	"golang.org/x/sys/unix"
)

// procUmask is this process's umask, read once at start.
var procUmask = func() os.FileMode {
	m := unix.Umask(0)
	unix.Umask(m)
	return os.FileMode(m)
}()
