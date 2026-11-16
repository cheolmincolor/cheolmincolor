package engine

// Buffers are page-aligned where the platform supports it, so that
// unbuffered (direct) I/O can be used for large sequential transfers.
// They are kept on a fixed free list rather than a sync.Pool because
// aligned buffers are not garbage collected.
var bufFree = make(chan []byte, 64)

func getBuf() []byte {
	select {
	case b := <-bufFree:
		return b
	default:
		return allocAligned(chunkSize)
	}
}

func putBuf(b []byte) {
	select {
	case bufFree <- b:
	default:
		freeAligned(b)
	}
}
