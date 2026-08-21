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
	topoRaw, err := h.store.ReadTopology()
	if err != nil {
		h.renderCompileResults(w, compileView{Error: "Ошибка чтения топологии: " + err.Error()})
		return
	}
	subnetsRaw, err := h.readStoredSubnets()
	if err != nil {
		h.renderCompileResults(w, compileView{Error: "Ошибка чтения подсетей: " + err.Error()})
		return
	}
	rulesRaw, err := h.store.ReadRules()
	if err != nil {
		h.renderCompileResults(w, compileView{Error: "Ошибка чтения правил: " + err.Error()})
		return
	}
	devices, err := app.Compile(r.Context(), h.log, app.CompileOptions{
		TopologyYAML: topoRaw,
		SubnetsYAML:  subnetsRaw,
		RulesYAML:    rulesRaw,
	})
	if err != nil {
		h.renderCompileResults(w, compileView{Error: "Ошибка компиляции: " + err.Error()})
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
