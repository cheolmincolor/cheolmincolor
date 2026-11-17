package engine

import "golang.org/x/sys/windows"

// DiskUsage returns the free (available to the user) and total bytes of the
// volume that holds path.
func DiskUsage(path string) (free, total int64, err error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, 0, err
	}
	var avail, tot, totFree uint64
	if err := windows.GetDiskFreeSpaceEx(p, &avail, &tot, &totFree); err != nil {
		return 0, 0, err
	}
	return int64(avail), int64(tot), nil
}
