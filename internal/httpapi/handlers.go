package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/kudes1/firenet/internal/app"
	"github.com/kudes1/firenet/internal/diagnose"
	"github.com/kudes1/firenet/internal/graph"
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
	if errs := h.deletionErrors(raw, subnetsRaw); len(errs) > 0 {
		writeError(w, http.StatusConflict, errors.New(strings.Join(errs, "; ")))
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

// getLinkExports serves the reachable export candidates for one side of a
// link: networks and subnets the side's device can reach when that very
// link is excluded from the graph (GET /api/link-exports?link=N&side=a|b).
func (h *handlers) getLinkExports(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	idx, err := strconv.Atoi(q.Get("link"))
	side := q.Get("side")
	if err != nil || idx < 0 || (side != "a" && side != "b") {
		writeError(w, http.StatusUnprocessableEntity, errors.New("invalid link index or side"))
		return
	}
	topo, err := h.loadTopology()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if idx >= len(topo.Links) {
		writeError(w, http.StatusNotFound, fmt.Errorf("no link %d", idx))
		return
	}
	l := topo.Links[idx]
	dev := l.A.Device
	if side == "b" {
		dev = l.B.Device
	}
	names, err := graph.ReachableEntities(topo, dev, idx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	out := make([]EntityDoc, 0, len(names))
	for _, n := range names {
		cidr := ""
		if s, ok := topo.Subnets[n]; ok {
			cidr = s.CIDR.String()
		}
		out = append(out, EntityDoc{Name: n, CIDR: cidr})
	}
	writeJSON(w, http.StatusOK, map[string]any{"entities": out})
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
	if errs := h.deletionErrors(topoRaw, raw); len(errs) > 0 {
		writeError(w, http.StatusConflict, errors.New(strings.Join(errs, "; ")))
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

// deletionErrors diffs the stored project against the proposed one
// (nextTopologyYAML merged with subnetsYAML) and reports removed objects
// that are still referenced. A broken stored state or unparseable proposal
// yields no deletions here — full validation reports those instead.
func (h *handlers) deletionErrors(nextTopologyYAML, subnetsYAML []byte) []string {
	prev, err := h.loadTopology()
	if err != nil {
		return nil
	}
	next, err := app.ParseProject(nextTopologyYAML, subnetsYAML)
	if err != nil {
		return nil
	}
	pol, err := h.loadPolicy()
	if err != nil {
		pol = nil // broken rules.yaml: topology-only checks; rules load reports the breakage
	}
	return app.DeletionErrors(prev, next, pol)
}

func (h *handlers) loadPolicy() (*rules.Policy, error) {
	raw, err := h.store.ReadRules()
	if err != nil {
		return nil, err
	}
	return rules.Load(bytes.NewReader(raw))
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
	pol, err := rules.Load(bytes.NewReader(raw))
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("parse stored rules: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, NewPolicyDoc(pol))
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
	pol := doc.ToPolicy()
	if err := pol.Validate(topo); err != nil {
		return true, err
	}
	raw, err := yaml.Marshal(doc)
	if err != nil {
		return false, err
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

type diagnoseRequest struct {
	Src      string   `json:"src"`
	Dst      string   `json:"dst"`
	Proto    string   `json:"proto"`
	SrcPorts []string `json:"srcPorts"`
	DstPorts []string `json:"dstPorts"`
}

var diagnoseProtos = map[string]bool{"": true, "tcp": true, "udp": true, "icmp": true}

// validatePortSpec accepts a single port number or a "lo:hi" range,
// mirroring the compiled-rule port syntax MatchFlow compares against.
func validatePortSpec(spec string) error {
	loStr, hiStr, ranged := strings.Cut(spec, ":")
	if !ranged {
		hiStr = loStr
	}
	lo, err1 := strconv.Atoi(loStr)
	hi, err2 := strconv.Atoi(hiStr)
	switch {
	case err1 != nil || err2 != nil || lo < 1 || hi > 65535:
		return fmt.Errorf("invalid port spec %q", spec)
	case lo > hi:
		return fmt.Errorf("invalid port range %q: from must not exceed to", spec)
	}
	return nil
}

func validatePortList(ports []string) error {
	for _, p := range ports {
		if err := validatePortSpec(p); err != nil {
			return err
		}
	}
	return nil
}

func (h *handlers) diagnose(w http.ResponseWriter, r *http.Request) {
	var req diagnoseRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusUnprocessableEntity, fmt.Errorf("invalid body: %w", err))
		return
	}
	if !diagnoseProtos[req.Proto] {
		writeError(w, http.StatusUnprocessableEntity, fmt.Errorf("invalid proto %q", req.Proto))
		return
	}
	src, err := netip.ParseAddr(req.Src)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, fmt.Errorf("invalid src IP: %w", err))
		return
	}
	dst, err := netip.ParseAddr(req.Dst)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, fmt.Errorf("invalid dst IP: %w", err))
		return
	}
	if err := validatePortList(req.SrcPorts); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	if err := validatePortList(req.DstPorts); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}

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

	rep, err := app.Diagnose(r.Context(), h.log, app.DiagnoseOptions{
		TopologyYAML: topoRaw,
		SubnetsYAML:  subnetsRaw,
		RulesYAML:    rulesRaw,
		Flow: diagnose.Flow{
			Src:      src,
			Dst:      dst,
			Proto:    rules.Proto(req.Proto),
			SrcPorts: req.SrcPorts,
			DstPorts: req.DstPorts,
		},
	})
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, rep)
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
