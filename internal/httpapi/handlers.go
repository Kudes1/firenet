package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	"gopkg.in/yaml.v3"

	"github.com/kudes1/firenet/internal/app"
	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

type handlers struct {
	store ProjectStore
	log   *slog.Logger
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func (h *handlers) getTopology(w http.ResponseWriter, r *http.Request) {
	raw, err := h.store.ReadTopology()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	var doc TopologyDoc
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("parse stored topology: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func (h *handlers) putTopology(w http.ResponseWriter, r *http.Request) {
	var doc TopologyDoc
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}
	raw, err := yaml.Marshal(doc)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	topo, err := topology.Load(bytes.NewReader(raw))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := topo.Validate(); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	if err := h.store.WriteTopology(raw); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func (h *handlers) getRules(w http.ResponseWriter, r *http.Request) {
	raw, err := h.store.ReadRules()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	var doc PolicyDoc
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("parse stored rules: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func (h *handlers) putRules(w http.ResponseWriter, r *http.Request) {
	var doc PolicyDoc
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}

	topoRaw, err := h.store.ReadTopology()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	topo, err := topology.Load(bytes.NewReader(topoRaw))
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("load stored topology: %w", err))
		return
	}
	if err := topo.Validate(); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("stored topology is invalid: %w", err))
		return
	}

	raw, err := yaml.Marshal(doc)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	pol, err := rules.Load(bytes.NewReader(raw))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := pol.Validate(topo); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	if err := h.store.WriteRules(raw); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func (h *handlers) validate(w http.ResponseWriter, r *http.Request) {
	topoRaw, err := h.store.ReadTopology()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	rulesRaw, err := h.store.ReadRules()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	var errs []string
	topo, loadErr := topology.Load(bytes.NewReader(topoRaw))
	switch {
	case loadErr != nil:
		errs = append(errs, loadErr.Error())
	default:
		if valErr := topo.Validate(); valErr != nil {
			errs = append(errs, valErr.Error())
		} else if pol, err := rules.Load(bytes.NewReader(rulesRaw)); err != nil {
			errs = append(errs, err.Error())
		} else if err := pol.Validate(topo); err != nil {
			errs = append(errs, err.Error())
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"valid": len(errs) == 0, "errors": errs})
}

func (h *handlers) compile(w http.ResponseWriter, r *http.Request) {
	topoRaw, err := h.store.ReadTopology()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	rulesRaw, err := h.store.ReadRules()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	devices, err := app.Compile(r.Context(), h.log, app.CompileOptions{
		TopologyYAML: topoRaw,
		RulesYAML:    rulesRaw,
	})
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, devices)
}

func (h *handlers) getLayout(w http.ResponseWriter, r *http.Request) {
	raw, err := h.store.ReadLayout()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(raw)
}

func (h *handlers) putLayout(w http.ResponseWriter, r *http.Request) {
	var raw json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}
	if err := h.store.WriteLayout(raw); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
