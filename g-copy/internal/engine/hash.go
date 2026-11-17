package engine

import (
	"context"
	"crypto/md5"
	"fmt"
	"hash"
	"io"
	"os"

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

// hashFile reads path from disk (bypassing the OS cache where the platform
// allows it) and returns its digest. progress is called with bytes read.
func hashFile(ctx context.Context, path, algo string, progress func(int64)) ([]byte, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	noCache(f)

	buf := getBuf()
	defer putBuf(buf)
	h := newHasher(algo)
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return nil, total, err
		}
		n, rerr := io.ReadFull(f, buf)
		if n > 0 {
			h.Write(buf[:n])
			total += int64(n)
			if progress != nil {
				progress(int64(n))
			}
		}
		if rerr == io.EOF || rerr == io.ErrUnexpectedEOF {
			break
		}
		if rerr != nil {
			return nil, total, rerr
		}
	}
	return h.Sum(nil), total, nil
}
