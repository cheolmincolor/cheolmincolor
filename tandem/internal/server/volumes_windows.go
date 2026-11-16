package server

import (
	"os"

	"golang.org/x/sys/windows"
)

// listVolumes returns the drive letters that are currently present.
func listVolumes() []Volume {
	var out []Volume
	mask, err := windows.GetLogicalDrives()
	if err != nil {
		return out
	}
	sys := os.Getenv("SystemDrive") // e.g. "C:"
	for i := 0; i < 26; i++ {
		if mask&(1<<uint(i)) == 0 {
			continue
		}
		letter := string(rune('A' + i))
		root := letter + `:\`
		p, _ := windows.UTF16PtrFromString(root)
		switch windows.GetDriveType(p) {
		case windows.DRIVE_REMOVABLE, windows.DRIVE_FIXED, windows.DRIVE_REMOTE:
		default:
			continue // optical drives, RAM disks, unknown
		}
		kind := "external"
		if letter+":" == sys {
			kind = "system"
		}
		out = append(out, Volume{Name: letter + ":", Path: root, Kind: kind})
	}
	return out
}
