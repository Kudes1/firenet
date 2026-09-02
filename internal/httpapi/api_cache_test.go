package httpapi

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// withAPICache adds gzip encoding, a content-hash ETag and 304
// revalidation on top of any handler; these tests pin the wire behavior.

func echoHandler(body string, status int) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	})
}

func TestAPICacheGzipsWhenAccepted(t *testing.T) {
	body := strings.Repeat(`{"name":"subnet-0"}`, 100)
	h := withAPICache(echoHandler(body, http.StatusOK))

	req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if enc := rec.Header().Get("Content-Encoding"); enc != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", enc)
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("gzip reader: %v", err)
	}
	got, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("gzip read: %v", err)
	}
	if string(got) != body {
		t.Error("decompressed body differs from original")
	}
}

func TestAPICachePassesThroughWithoutGzip(t *testing.T) {
	body := `{"ok":true}`
	h := withAPICache(echoHandler(body, http.StatusOK))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/x", nil))

	if enc := rec.Header().Get("Content-Encoding"); enc != "" {
		t.Fatalf("Content-Encoding = %q, want none", enc)
	}
	if rec.Body.String() != body {
		t.Errorf("body = %q, want %q", rec.Body.String(), body)
	}
}

func TestAPICacheETagAndRevalidation(t *testing.T) {
	body := `{"ok":true}`
	h := withAPICache(echoHandler(body, http.StatusOK))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/x", nil))
	etag := rec.Header().Get("ETag")
	if etag == "" {
		t.Fatal("no ETag on GET response")
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("Cache-Control = %q, want no-cache", cc)
	}

	// Revalidation with a matching ETag gets a body-less 304.
	req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
	req.Header.Set("If-None-Match", etag)
	rec304 := httptest.NewRecorder()
	h.ServeHTTP(rec304, req)
	if rec304.Code != http.StatusNotModified {
		t.Fatalf("status = %d, want 304", rec304.Code)
	}
	if rec304.Body.Len() != 0 {
		t.Errorf("304 carried a body of %d bytes", rec304.Body.Len())
	}

	// A changed body must produce a different ETag (fresh data => fresh tag).
	h2 := withAPICache(echoHandler(`{"ok":false}`, http.StatusOK))
	rec2 := httptest.NewRecorder()
	h2.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/api/x", nil))
	if rec2.Header().Get("ETag") == etag {
		t.Error("different bodies share an ETag")
	}
}

func TestAPICacheKeepsHandlerStatus(t *testing.T) {
	h := withAPICache(echoHandler(`{"error":"boom"}`, http.StatusInternalServerError))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/x", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
}

func TestAPICacheNoETagOnMutations(t *testing.T) {
	h := withAPICache(echoHandler(`{}`, http.StatusOK))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/x", nil))
	if rec.Header().Get("ETag") != "" {
		t.Error("PUT response carries an ETag")
	}
}
