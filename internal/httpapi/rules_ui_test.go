package httpapi

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func doForm(t *testing.T, h http.Handler, method, path string, form url.Values) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func fixtureRuleForm() url.Values {
	return url.Values{
		"defaultAction":      {"deny"},
		"rules[0][name]":     {"office-to-dmz"},
		"rules[0][src]":      {"office"},
		"rules[0][dst]":      {"dmz"},
		"rules[0][proto]":    {"tcp"},
		"rules[0][dstPorts]": {"443"},
		"rules[0][action]":   {"allow"},
	}
}

func TestUIRules_InitialRender(t *testing.T) {
	h, _ := newTestServer(t)
	rec := doForm(t, h, http.MethodGet, "/ui/rules", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	body := rec.Body.String()
	for _, want := range []string{
		`rules[0][name]" value="office-to-dmz"`,
		`value="office" checked`,
		`value="443"`,
		`id="rules-default-action" name="defaultAction"`,
		`id="rules-chain-name" name="chainName"`,
		`id="rules-chain-position" name="chainPosition"`,
		`id="btn-unlock-settings"`,
		`id="rules-settings-display"`,
		`id="rules-settings-edit"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("expected body to contain %q, got:\n%s", want, body)
		}
	}
}

func TestUIRulesAdd_AppendsRow(t *testing.T) {
	h, _ := newTestServer(t)
	rec := doForm(t, h, http.MethodPost, "/ui/rules/add", fixtureRuleForm())
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `rules[1][name]`) {
		t.Fatalf("expected new row at index 1, got:\n%s", body)
	}
	if strings.Contains(body, `rules[0]`) {
		t.Fatalf("add response should only contain the new row, got:\n%s", body)
	}
}

func TestUIRulesDelete_RemovesAndReindexes(t *testing.T) {
	h, _ := newTestServer(t)
	form := fixtureRuleForm()
	form["rules[1][name]"] = []string{"second"}
	form["rules[1][src]"] = []string{"dmz"}
	form["rules[1][dst]"] = []string{"office"}
	form["rules[1][proto]"] = []string{"any"}
	form["rules[1][action]"] = []string{"deny"}

	rec := doForm(t, h, http.MethodPost, "/ui/rules/0/delete", form)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	body := rec.Body.String()
	if strings.Count(body, "<tr>") != 1 {
		t.Fatalf("expected exactly one remaining row, got:\n%s", body)
	}
	if !strings.Contains(body, `rules[0][name]" value="second"`) {
		t.Fatalf("expected remaining row reindexed to 0, got:\n%s", body)
	}
}

func TestUIRulesMove_SwapsAdjacentAndBoundaryNoop(t *testing.T) {
	h, _ := newTestServer(t)
	form := fixtureRuleForm()
	form["rules[1][name]"] = []string{"second"}
	form["rules[1][src]"] = []string{"dmz"}
	form["rules[1][dst]"] = []string{"office"}
	form["rules[1][proto]"] = []string{"any"}
	form["rules[1][action]"] = []string{"deny"}

	rec := doForm(t, h, http.MethodPost, "/ui/rules/0/move-up", form)
	if !strings.Contains(rec.Body.String(), `rules[0][name]" value="office-to-dmz"`) {
		t.Fatalf("move-up at index 0 should be a no-op, got:\n%s", rec.Body)
	}

	rec = doForm(t, h, http.MethodPost, "/ui/rules/0/move-down", form)
	body := rec.Body.String()
	if !strings.Contains(body, `rules[0][name]" value="second"`) || !strings.Contains(body, `rules[1][name]" value="office-to-dmz"`) {
		t.Fatalf("move-down at index 0 should swap rows, got:\n%s", body)
	}
}

func TestUIRulesSave_PersistsValid(t *testing.T) {
	h, store := newTestServer(t)
	rec := doForm(t, h, http.MethodPost, "/ui/rules/save", fixtureRuleForm())
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "banner ok") {
		t.Fatalf("expected ok banner, got:\n%s", rec.Body)
	}
	raw, err := store.ReadRules()
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !bytes.Contains(raw, []byte("office-to-dmz")) {
		t.Fatalf("stored rules missing new rule: %s", raw)
	}
}

func TestUIRulesSave_RejectsInvalid_NoCorruption(t *testing.T) {
	h, store := newTestServer(t)
	before, _ := store.ReadRules()

	form := url.Values{
		"defaultAction":    {"deny"},
		"rules[0][name]":   {"bad"},
		"rules[0][src]":    {"office"},
		"rules[0][dst]":    {"does-not-exist"},
		"rules[0][proto]":  {"any"},
		"rules[0][action]": {"allow"},
	}
	rec := doForm(t, h, http.MethodPost, "/ui/rules/save", form)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "banner error") {
		t.Fatalf("expected error banner, got:\n%s", rec.Body)
	}
	after, _ := store.ReadRules()
	if !bytes.Equal(before, after) {
		t.Fatalf("invalid rules must not be persisted")
	}
}
