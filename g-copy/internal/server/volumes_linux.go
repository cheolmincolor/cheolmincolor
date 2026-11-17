package server

import (
	"os"
	"path/filepath"
	"strings"
)

// listVolumes returns mounts in the places removable disks and shares
// normally appear, plus the root filesystem.
func listVolumes() []Volume {
	out := []Volume{{Name: "System (/)", Path: "/", Kind: "system"}}
	data, err := os.ReadFile("/proc/self/mounts")
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		mp := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\134`, `\`).Replace(f[1])
		for _, prefix := range []string{"/media/", "/mnt/", "/run/media/", "/Volumes/"} {
			if strings.HasPrefix(mp, prefix) {
				out = append(out, Volume{Name: filepath.Base(mp), Path: mp, Kind: "external"})
				break
			}
		}
	}
	return out
}
