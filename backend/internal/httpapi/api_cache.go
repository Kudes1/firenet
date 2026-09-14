package httpapi

import (
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
)

// withAPICache wraps the JSON API with two cheap wins for repeat reads:
//
//   - gzip: JSON project documents compress roughly 10x; responses are
//     encoded whenever the client sends Accept-Encoding: gzip.
//   - content-hash ETag + no-cache: every GET response carries an ETag
//     derived from its exact wire bytes, so a client revalidating after
//     an unrelated navigation (every page load re-fetches the same
//     documents) gets a body-less 304 when the data hasn't changed. The
//     /api routes carry no Cache-Control today, so without this every
//     navigation re-downloads everything.
//
// The response body is buffered to compute the ETag over the exact wire
// bytes and to emit a true 304 (no body) on a match. JSON API responses
// are bounded by project size, so buffering is safe here; it would not be
// for arbitrary downloads.
func withAPICache(next http.Handler) http.Handler {
	gzPool := &sync.Pool{
		New: func() any { return gzip.NewWriter(nil) },
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		accepts := acceptsGzip(r)

		var gw *gzip.Writer
		if accepts {
			w.Header().Set("Content-Encoding", "gzip")
			gw = gzPool.Get().(*gzip.Writer)
			gw.Reset(w)
		}

		rec := &bufferedResponse{ResponseWriter: w}
		next.ServeHTTP(rec, r)

		body := rec.buf
		// Only GETs get cache headers: mutating responses (PUT/POST) are
		// never re-served from cache, so their ETag would be dead weight.
		if r.Method == http.MethodGet {
			sum := sha256.Sum256(body)
			etag := `"` + hex.EncodeToString(sum[:8]) + `"`
			w.Header().Set("ETag", etag)
			w.Header().Set("Cache-Control", "no-cache")
			if r.Header.Get("If-None-Match") == etag {
				w.WriteHeader(http.StatusNotModified)
				return // body intentionally dropped
			}
		}

		w.WriteHeader(rec.statusOr(http.StatusOK))
		if gw != nil {
			_, _ = gw.Write(body)
			_ = gw.Close()
			gzPool.Put(gw)
		} else {
			_, _ = w.Write(body)
		}
	})
}

func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		if strings.TrimSpace(strings.SplitN(part, ";", 2)[0]) == "gzip" {
			return true
		}
	}
	return false
}

// bufferedResponse captures the handler's body and status so the wrapper
// can hash the exact wire bytes and drop the body on a 304. Headers and
// status pass through to the real writer at flush time.
type bufferedResponse struct {
	http.ResponseWriter
	buf      []byte
	status   int
	wroteHdr bool
}

func (b *bufferedResponse) statusOr(def int) int {
	if b.status == 0 {
		return def
	}
	return b.status
}

func (b *bufferedResponse) WriteHeader(code int) {
	if b.wroteHdr {
		return
	}
	b.status = code
	b.wroteHdr = true
	// Suppress the implicit "200 OK" write; the wrapper writes the real
	// header before copying the body.
}

func (b *bufferedResponse) Write(p []byte) (int, error) {
	b.buf = append(b.buf, p...)
	return len(p), nil
}
