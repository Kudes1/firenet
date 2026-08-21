package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// doForm sends a request with an empty form body, like the old HTMX UI did.
func doForm(t *testing.T, h http.Handler, method, path string, form map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(encodeForm(form)))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func encodeForm(form map[string]string) string {
	if len(form) == 0 {
		return ""
	}
	vals := make([]string, 0, len(form))
	for k, v := range form {
		vals = append(vals, k+"="+strings.ReplaceAll(v, "&", "%26"))
	}
	return strings.Join(vals, "&")
}

func TestUICompile_Success(t *testing.T) {
	h, _ := newTestServer(t)
	rec := doForm(t, h, http.MethodPost, "/ui/compile", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "compile-device") {
		t.Fatalf("expected compile-device in body, got:\n%s", body)
	}
	if !strings.Contains(body, "r1.rules.sh") && !strings.Contains(body, "r2.rules.sh") {
		t.Fatalf("expected router script in body, got:\n%s", body)
	}
}
