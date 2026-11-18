//go:build !darwin && !linux

package engine

import "os"

func noCache(*os.File) {}

func flushFile(f *os.File, _ bool) error { return f.Sync() }

func renameNoReplace(from, to string) error { return errNoExclRename }

func isNetworkFS(string) bool { return false }

var procUmask os.FileMode = 0o022

func dropCache(*os.File) {}

func allocAligned(n int) []byte { return make([]byte, n) }

func freeAligned([]byte) {}
