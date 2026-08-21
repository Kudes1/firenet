package httpapi

import (
	"net/http"
	"strings"
	"testing"
)

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
