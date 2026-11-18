package engine

import (
	"crypto/md5"
	"fmt"
	"hash"

	"github.com/cespare/xxhash/v2"
)

// NormalizeAlgo returns the canonical algorithm name, or an error.
func NormalizeAlgo(algo string) (string, error) {
	switch algo {
	case "", "xxh64":
		return "xxh64", nil
	case "md5":
		return "md5", nil
	}
	return "", fmt.Errorf("Unsupported checksum algorithm: %q", algo)
}

func newHasher(algo string) hash.Hash {
	if algo == "md5" {
		return md5.New()
	}
	return xxhash.New()
}
