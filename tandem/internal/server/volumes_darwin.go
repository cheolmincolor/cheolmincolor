package server

import (
	"os"
	"path/filepath"
	"strings"
)

// listVolumes returns everything mounted under /Volumes: external disks,
// DAS units and connected network shares, plus the startup disk.
func listVolumes() []Volume {
	var out []Volume
	entries, _ := os.ReadDir("/Volumes")
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		p := filepath.Join("/Volumes", name)
		fi, err := os.Stat(p)
		if err != nil || !fi.IsDir() {
			continue
		}
		kind := "external"
		if real, err := filepath.EvalSymlinks(p); err == nil && real == "/" {
			kind = "system"
		}
		out = append(out, Volume{Name: name, Path: p, Kind: kind})
	}
	return out
}
