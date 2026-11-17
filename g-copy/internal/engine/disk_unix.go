//go:build darwin || linux

package engine

import "golang.org/x/sys/unix"

// DiskUsage returns the free (available to the user) and total bytes of the
// filesystem that holds path.
func DiskUsage(path string) (free, total int64, err error) {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	bs := uint64(st.Bsize)
	return int64(uint64(st.Bavail) * bs), int64(uint64(st.Blocks) * bs), nil
}
