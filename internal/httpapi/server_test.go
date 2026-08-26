package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// Static assets are embedded without modification times, so the file
// server sends neither Last-Modified nor ETag. Responses must therefore
// carry a content-hash ETag with Cache-Control forbidding reuse without
// revalidation: the browser keeps its cached copy, a matching
// If-None-Match gets a cheap 304, and a rebuild changes the hash.
func TestStaticAssetsNoCache(t *testing.T) {
	srv, _, _ := newTestServer(t)
	for _, path := range []string{"/common.js", "/rules.js", "/style.css", "/favicon.svg"} {
		rec := doJSON(t, srv, http.MethodGet, path, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: status %d", path, rec.Code)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
			t.Errorf("GET %s: Cache-Control = %q, want \"no-cache\"", path, cc)
		}
		etag := rec.Header().Get("ETag")
		if etag == "" {
			t.Fatalf("GET %s: no ETag", path)
		}
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("If-None-Match", etag)
		rec = httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotModified {
			t.Errorf("GET %s with If-None-Match: status %d, want 304", path, rec.Code)
		}
	}
}
