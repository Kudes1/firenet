package httpapi

import (
	"net/http"

	"github.com/kudes1/firenet/internal/app"
)

type compileView struct {
	Devices []app.CompiledDevice
	Error   string
}

func (h *handlers) uiCompile(w http.ResponseWriter, r *http.Request) {
	doc, err := h.currentDoc(r)
	if err != nil {
		h.renderCompileResults(w, compileView{Error: "Ошибка чтения проекта: " + err.Error()})
		return
	}
	devicesAny, err := h.compileDoc(r.Context(), doc)
	if err != nil {
		h.renderCompileResults(w, compileView{Error: "Ошибка компиляции: " + err.Error()})
		return
	}
	devices, ok := devicesAny.([]app.CompiledDevice)
	if !ok {
		h.renderCompileResults(w, compileView{Error: "Ошибка компиляции: unexpected result type"})
		return
	}
	h.renderCompileResults(w, compileView{Devices: devices})
}

func (h *handlers) renderCompileResults(w http.ResponseWriter, view compileView) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := rulesTmpl.ExecuteTemplate(w, "compile-results", view); err != nil {
		h.log.Error("render compile results", "err", err)
	}
}
