package httpapi

import (
	"net/http"
	"testing"
)

// Static assets are embedded without modification times, so the file
// server sends neither Last-Modified nor ETag. Without an explicit
// Cache-Control the browser heuristically caches stale JS after a
// rebuild — every response must therefore forbid reuse without
// revalidation.
func TestStaticAssetsNoCache(t *testing.T) {
	srv, _ := newTestServer(t)
	for _, path := range []string{"/common.js", "/rules.js", "/style.css"} {
		rec := doJSON(t, srv, http.MethodGet, path, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: status %d", path, rec.Code)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
			t.Errorf("GET %s: Cache-Control = %q, want \"no-cache\"", path, cc)
		}
	}
}
