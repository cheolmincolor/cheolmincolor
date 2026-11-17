//go:build !darwin && !linux

package engine

import "os"

func noCache(*os.File) {}

func syncLight(f *os.File) error { return f.Sync() }

func dropCache(*os.File) {}

func allocAligned(n int) []byte { return make([]byte, n) }

func freeAligned([]byte) {}
