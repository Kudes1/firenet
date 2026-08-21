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
	subnetsRaw, err := h.readStoredSubnets()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if _, err := app.LoadProject(raw, subnetsRaw); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	if err := h.store.WriteTopology(raw); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func (h *handlers) getSubnets(w http.ResponseWriter, r *http.Request) {
	raw, err := h.readStoredSubnets()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	var doc SubnetsDoc
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("parse stored subnets: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func (h *handlers) putSubnets(w http.ResponseWriter, r *http.Request) {
	var doc SubnetsDoc
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}
	raw, err := yaml.Marshal(doc)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	topoRaw, err := h.store.ReadTopology()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if _, err := app.LoadProject(topoRaw, raw); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	if err := h.store.WriteSubnets(raw); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func (h *handlers) readStoredSubnets() ([]byte, error) {
	raw, err := h.store.ReadSubnets()
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		raw = []byte("subnets: []\n")
	}
	return raw, nil
}

// loadTopology loads the stored topology.yaml + subnets.yaml as one merged,
// validated Topology (cross-file references included).
func (h *handlers) loadTopology() (*topology.Topology, error) {
	topoRaw, err := h.store.ReadTopology()
	if err != nil {
		return nil, err
	}
	subnetsRaw, err := h.readStoredSubnets()
	if err != nil {
		return nil, err
	}
	topo, err := app.LoadProject(topoRaw, subnetsRaw)
	if err != nil {
		return nil, fmt.Errorf("stored project is invalid: %w", err)
	}
	return topo, nil
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
	invalid, err := h.validateAndPersistRules(doc)
	if err != nil {
		status := http.StatusInternalServerError
		if invalid {
			status = http.StatusUnprocessableEntity
		}
		writeError(w, status, err)
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

// validateAndPersistRules validates doc against the stored project
// (topology + subnets) and, on success, persists it. invalid reports whether
// a failure is the caller's fault (422-worthy) as opposed to a server-side
// problem (500-worthy).
func (h *handlers) validateAndPersistRules(doc PolicyDoc) (invalid bool, err error) {
	topo, err := h.loadTopology()
	if err != nil {
		return false, err
	}

	raw, err := yaml.Marshal(doc)
	if err != nil {
		return false, err
	}
	pol, err := rules.Load(bytes.NewReader(raw))
	if err != nil {
		return true, err
	}
	if err := pol.Validate(topo); err != nil {
		return true, err
	}
	return false, h.store.WriteRules(raw)
}

func (h *handlers) validate(w http.ResponseWriter, r *http.Request) {
	topoRaw, err := h.store.ReadTopology()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	subnetsRaw, err := h.readStoredSubnets()
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
	topo, loadErr := app.LoadProject(topoRaw, subnetsRaw)
	switch {
	case loadErr != nil:
		errs = append(errs, loadErr.Error())
	default:
		if pol, err := rules.Load(bytes.NewReader(rulesRaw)); err != nil {
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
	subnetsRaw, err := h.readStoredSubnets()
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
		SubnetsYAML:  subnetsRaw,
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
