package httpapi

import (
	"bytes"
	"context"
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
	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/diagnose"
	"github.com/kudes1/firenet/internal/graph"
	"github.com/kudes1/firenet/internal/pgstore"
	"github.com/kudes1/firenet/internal/projectdoc"
	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

type handlers struct {
	projects *pgstore.Store
	users    *auth.Store
	log      *slog.Logger
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

// writeStoreError maps pgstore's sentinel errors to the right HTTP
// status; anything else is a 500.
func writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, pgstore.ErrDraftNotFound):
		writeError(w, http.StatusNotFound, err)
	case errors.Is(err, pgstore.ErrNoVersions):
		writeError(w, http.StatusNotFound, err)
	case errors.Is(err, pgstore.ErrRevisionMismatch):
		writeError(w, http.StatusConflict, err)
	case errors.Is(err, pgstore.ErrDraftNameTaken):
		writeError(w, http.StatusConflict, err)
	case errors.Is(err, pgstore.ErrConfirmRace):
		writeError(w, http.StatusConflict, err)
	default:
		writeError(w, http.StatusInternalServerError, err)
	}
}

// currentDoc resolves the read-only current confirmed version.
func (h *handlers) currentDoc(r *http.Request) (projectdoc.ProjectDoc, error) {
	v, err := h.projects.CurrentVersion(r.Context())
	if err != nil {
		return projectdoc.ProjectDoc{}, err
	}
	return h.projects.ReadAt(r.Context(), v)
}

// canAccessDraft reports whether the request's caller may read/write
// draft d: its owner, or any admin.
func (h *handlers) canAccessDraft(r *http.Request, d pgstore.Draft) bool {
	user, _ := auth.UserFromContext(r.Context())
	return user.Role == auth.RoleAdmin || user.ID == d.Owner
}

// resolveDraftForAccess loads the {id} path draft and 403s if the caller
// may not access it. Callers stop (return) when ok is false.
func (h *handlers) resolveDraftForAccess(w http.ResponseWriter, r *http.Request) (pgstore.Draft, bool) {
	d, err := h.projects.GetDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return pgstore.Draft{}, false
	}
	if !h.canAccessDraft(r, d) {
		writeError(w, http.StatusForbidden, errors.New("not the owner of this draft"))
		return pgstore.Draft{}, false
	}
	return d, true
}

// deletionErrorsFromDocs diffs prev's topology+subnets against next's and
// reports removed objects still referenced by the proposed rules. A broken
// prev/next or unparseable proposal yields no deletions here — full
// validation reports those instead.
func deletionErrorsFromDocs(prev, next projectdoc.ProjectDoc) []string {
	prevTopoYAML, err := yaml.Marshal(prev.Topology)
	if err != nil {
		return nil
	}
	prevSubnetsYAML, err := yaml.Marshal(prev.Subnets)
	if err != nil {
		return nil
	}
	prevTopo, err := app.LoadProject(prevTopoYAML, prevSubnetsYAML)
	if err != nil {
		return nil
	}

	nextTopoYAML, err := yaml.Marshal(next.Topology)
	if err != nil {
		return nil
	}
	nextSubnetsYAML, err := yaml.Marshal(next.Subnets)
	if err != nil {
		return nil
	}
	nextTopo, err := app.ParseProject(nextTopoYAML, nextSubnetsYAML)
	if err != nil {
		return nil
	}

	rulesYAML, err := yaml.Marshal(next.Rules)
	if err != nil {
		return nil
	}
	pol, err := rules.Load(bytes.NewReader(rulesYAML))
	if err != nil {
		pol = nil // broken rules: topology-only checks; rules load reports the breakage elsewhere
	}
	return app.DeletionErrors(prevTopo, nextTopo, pol)
}

// loadTopologyDoc validates doc's topology+subnets as one merged,
// cross-referenced topology.Topology (mirrors the old loadTopology, now
// sourced from a ProjectDoc instead of the file store).
func loadTopologyDoc(doc projectdoc.ProjectDoc) (*topology.Topology, error) {
	topoYAML, err := yaml.Marshal(doc.Topology)
	if err != nil {
		return nil, err
	}
	subnetsYAML, err := yaml.Marshal(doc.Subnets)
	if err != nil {
		return nil, err
	}
	topo, err := app.LoadProject(topoYAML, subnetsYAML)
	if err != nil {
		return nil, fmt.Errorf("project is invalid: %w", err)
	}
	return topo, nil
}

// requestRevision prefers the client-supplied X-Draft-Revision (from its
// last GET) for the CAS check; falling back to the revision this handler
// itself just read is only a safety net for a client that omits the
// header, not the intended flow.
func requestRevision(r *http.Request, fallback string) string {
	if h := r.Header.Get("X-Draft-Revision"); h != "" {
		return h
	}
	return fallback
}

func (h *handlers) getCurrentTopology(w http.ResponseWriter, r *http.Request) {
	doc, err := h.currentDoc(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, doc.Topology)
}

func (h *handlers) getDraftTopology(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	doc, revision, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("X-Draft-Revision", revision)
	writeJSON(w, http.StatusOK, doc.Topology)
}

func (h *handlers) putDraftTopology(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	var topo projectdoc.TopologyDoc
	if err := json.NewDecoder(r.Body).Decode(&topo); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}

	id := r.PathValue("id")
	prev, revision, err := h.projects.ReadDraft(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	next := prev
	next.Topology = topo

	if errs := deletionErrorsFromDocs(prev, next); len(errs) > 0 {
		writeError(w, http.StatusConflict, errors.New(strings.Join(errs, "; ")))
		return
	}
	if _, err := loadTopologyDoc(next); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}

	newRevision, err := h.projects.WriteDraft(r.Context(), id, next, requestRevision(r, revision))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("X-Draft-Revision", newRevision)
	writeJSON(w, http.StatusOK, topo)
}

// editorSnapshot is the canonical topology+layout returned after a
// topology operation applies. It always reflects the draft's
// storage-sorted state (pgstore.fromEntities' order), so the editor's
// canvas and link identities match what's actually persisted without a
// separate reload.
type editorSnapshot struct {
	Topology TopologyDoc `json:"topology"`
	Layout   LayoutDoc   `json:"layout"`
}

// postDraftTopologyOperation applies one topologyOperation to the draft's
// current document and, on success, returns the resulting canonical
// topology+layout snapshot. The operation is validated the same way a
// full PUT topology would be (deletion guard, then topology.Validate via
// loadTopologyDoc) before it's persisted, so a partially-applied or
// invalid draft is never written.
func (h *handlers) postDraftTopologyOperation(w http.ResponseWriter, r *http.Request) {
	var op topologyOperation
	if err := json.NewDecoder(r.Body).Decode(&op); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}
	h.applyDraftTopologyOperations(w, r, []topologyOperation{op})
}

// postDraftTopologyOperationsBatch applies a list of topologyOperations to
// the draft as one all-or-nothing step: every operation is applied in
// order before the resulting document is validated once, against its
// final state — not after each individual operation, the way
// postDraftTopologyOperation validates a lone op. This matters for a
// caller (the canvas editor's multi-select delete) whose operations are
// only jointly valid: deleting a switch alone can make a network
// unreachable from a router that still exports it via some untouched
// filtered link, even though deleting the switch, the router and the
// network together is perfectly valid.
func (h *handlers) postDraftTopologyOperationsBatch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Operations []topologyOperation `json:"operations"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}
	if len(body.Operations) == 0 {
		writeError(w, http.StatusBadRequest, errors.New("missing operations"))
		return
	}
	h.applyDraftTopologyOperations(w, r, body.Operations)
}

// applyDraftTopologyOperations is the shared write path behind both the
// single-operation and batch endpoints: read, apply every op in order,
// validate the resulting document once, CAS-write it, and respond with
// the canonical post-write snapshot.
func (h *handlers) applyDraftTopologyOperations(w http.ResponseWriter, r *http.Request, ops []topologyOperation) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	id := r.PathValue("id")
	prev, revision, err := h.projects.ReadDraft(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	next := prev
	for _, op := range ops {
		next, err = applyTopologyOperation(next, op)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, err)
			return
		}
	}
	if errs := deletionErrorsFromDocs(prev, next); len(errs) > 0 {
		writeError(w, http.StatusConflict, errors.New(strings.Join(errs, "; ")))
		return
	}
	if _, err := loadTopologyDoc(next); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}

	if _, err := h.projects.WriteDraft(r.Context(), id, next, requestRevision(r, revision)); err != nil {
		writeStoreError(w, err)
		return
	}
	// Re-read rather than trust next: the store applies its own canonical
	// sort, and this also reports the true post-write revision even if
	// another write raced in between.
	saved, savedRevision, err := h.projects.ReadDraft(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("X-Draft-Revision", savedRevision)
	writeJSON(w, http.StatusOK, editorSnapshot{Topology: saved.Topology, Layout: saved.Layout})
}

// getLinkExports serves the reachable export candidates for one side of a
// link: networks and subnets the side's device can reach when that very
// link is excluded from the graph.
func (h *handlers) getDraftLinkExports(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	doc, _, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	h.writeLinkExports(w, r, doc)
}

func (h *handlers) getCurrentLinkExports(w http.ResponseWriter, r *http.Request) {
	doc, err := h.currentDoc(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	h.writeLinkExports(w, r, doc)
}

func (h *handlers) writeLinkExports(w http.ResponseWriter, r *http.Request, doc projectdoc.ProjectDoc) {
	q := r.URL.Query()
	side := q.Get("side")
	if side != "a" && side != "b" {
		writeError(w, http.StatusUnprocessableEntity, errors.New("invalid link index or side"))
		return
	}

	// The link candidates flow (topology operations) identifies its link
	// by canonical endpoint pair; /ui/links still identifies it by array
	// index. Resolve by pair when both a and b are given, otherwise fall
	// back to the legacy index so /ui/links keeps working unmodified.
	a, hasA := q["a"]
	b, hasB := q["b"]
	byPair := hasA && hasB

	var idx int
	if byPair {
		idx = linkIndex(doc.Topology.Links, a[0], b[0])
		if idx < 0 {
			writeError(w, http.StatusNotFound, fmt.Errorf("no link between %q and %q", a[0], b[0]))
			return
		}
	} else {
		var err error
		idx, err = strconv.Atoi(q.Get("link"))
		if err != nil || idx < 0 {
			writeError(w, http.StatusUnprocessableEntity, errors.New("invalid link index or side"))
			return
		}
	}

	topo, err := loadTopologyDoc(doc)
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
	out := make([]projectdoc.EntityDoc, 0, len(names))
	for _, n := range names {
		cidr := ""
		if s, ok := topo.Subnets[n]; ok {
			cidr = s.CIDR.String()
		}
		out = append(out, projectdoc.EntityDoc{Name: n, CIDR: cidr})
	}
	writeJSON(w, http.StatusOK, map[string]any{"entities": out})
}

func (h *handlers) getCurrentSubnets(w http.ResponseWriter, r *http.Request) {
	doc, err := h.currentDoc(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, doc.Subnets)
}

func (h *handlers) getDraftSubnets(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	doc, revision, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("X-Draft-Revision", revision)
	writeJSON(w, http.StatusOK, doc.Subnets)
}

func (h *handlers) putDraftSubnets(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	var subnets projectdoc.SubnetsDoc
	if err := json.NewDecoder(r.Body).Decode(&subnets); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}

	id := r.PathValue("id")
	prev, revision, err := h.projects.ReadDraft(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	next := prev
	next.Subnets = subnets

	if errs := deletionErrorsFromDocs(prev, next); len(errs) > 0 {
		writeError(w, http.StatusConflict, errors.New(strings.Join(errs, "; ")))
		return
	}
	if _, err := loadTopologyDoc(next); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}

	newRevision, err := h.projects.WriteDraft(r.Context(), id, next, requestRevision(r, revision))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("X-Draft-Revision", newRevision)
	writeJSON(w, http.StatusOK, subnets)
}

func (h *handlers) getCurrentRules(w http.ResponseWriter, r *http.Request) {
	doc, err := h.currentDoc(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, doc.Rules)
}

func (h *handlers) getDraftRules(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	doc, revision, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("X-Draft-Revision", revision)
	writeJSON(w, http.StatusOK, doc.Rules)
}

func (h *handlers) putDraftRules(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	var policy projectdoc.PolicyDoc
	if err := json.NewDecoder(r.Body).Decode(&policy); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}

	id := r.PathValue("id")
	prev, revision, err := h.projects.ReadDraft(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	next := prev
	next.Rules = policy

	topo, err := loadTopologyDoc(next)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	pol := policy.ToPolicy()
	if err := pol.Validate(topo); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}

	newRevision, err := h.projects.WriteDraft(r.Context(), id, next, requestRevision(r, revision))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("X-Draft-Revision", newRevision)
	writeJSON(w, http.StatusOK, policy)
}

func (h *handlers) getCurrentLayout(w http.ResponseWriter, r *http.Request) {
	doc, err := h.currentDoc(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, doc.Layout)
}

func (h *handlers) getDraftLayout(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	doc, revision, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("X-Draft-Revision", revision)
	writeJSON(w, http.StatusOK, doc.Layout)
}

func (h *handlers) putDraftLayout(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	var layout projectdoc.LayoutDoc
	if err := json.NewDecoder(r.Body).Decode(&layout); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}

	id := r.PathValue("id")
	prev, revision, err := h.projects.ReadDraft(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	next := prev
	next.Layout = layout

	newRevision, err := h.projects.WriteDraft(r.Context(), id, next, requestRevision(r, revision))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("X-Draft-Revision", newRevision)
	writeJSON(w, http.StatusOK, layout)
}

func validateDoc(doc projectdoc.ProjectDoc) []string {
	var errs []string
	topo, err := loadTopologyDoc(doc)
	if err != nil {
		return append(errs, err.Error())
	}
	pol := doc.Rules.ToPolicy()
	if err := pol.Validate(topo); err != nil {
		errs = append(errs, err.Error())
	}
	return errs
}

func (h *handlers) validateCurrent(w http.ResponseWriter, r *http.Request) {
	doc, err := h.currentDoc(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	errs := validateDoc(doc)
	writeJSON(w, http.StatusOK, map[string]any{"valid": len(errs) == 0, "errors": errs})
}

func (h *handlers) validateDraft(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	doc, _, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	errs := validateDoc(doc)
	writeJSON(w, http.StatusOK, map[string]any{"valid": len(errs) == 0, "errors": errs})
}

func (h *handlers) compileDoc(ctx context.Context, doc projectdoc.ProjectDoc) (any, error) {
	topoYAML, err := yaml.Marshal(doc.Topology)
	if err != nil {
		return nil, err
	}
	subnetsYAML, err := yaml.Marshal(doc.Subnets)
	if err != nil {
		return nil, err
	}
	rulesYAML, err := yaml.Marshal(doc.Rules)
	if err != nil {
		return nil, err
	}
	return app.Compile(ctx, h.log, app.CompileOptions{TopologyYAML: topoYAML, SubnetsYAML: subnetsYAML, RulesYAML: rulesYAML})
}

func (h *handlers) compileCurrent(w http.ResponseWriter, r *http.Request) {
	doc, err := h.currentDoc(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	devices, err := h.compileDoc(r.Context(), doc)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, devices)
}

func (h *handlers) compileDraft(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	doc, _, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	devices, err := h.compileDoc(r.Context(), doc)
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

// parseDiagnoseRequest decodes and validates the request body shared by
// both diagnose variants; the returned diagnose.Flow is ready to compile.
func parseDiagnoseRequest(r *http.Request) (diagnose.Flow, error) {
	var req diagnoseRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return diagnose.Flow{}, fmt.Errorf("invalid body: %w", err)
	}
	if !diagnoseProtos[req.Proto] {
		return diagnose.Flow{}, fmt.Errorf("invalid proto %q", req.Proto)
	}
	src, err := netip.ParseAddr(req.Src)
	if err != nil {
		return diagnose.Flow{}, fmt.Errorf("invalid src IP: %w", err)
	}
	dst, err := netip.ParseAddr(req.Dst)
	if err != nil {
		return diagnose.Flow{}, fmt.Errorf("invalid dst IP: %w", err)
	}
	if err := validatePortList(req.SrcPorts); err != nil {
		return diagnose.Flow{}, err
	}
	if err := validatePortList(req.DstPorts); err != nil {
		return diagnose.Flow{}, err
	}
	return diagnose.Flow{Src: src, Dst: dst, Proto: rules.Proto(req.Proto), SrcPorts: req.SrcPorts, DstPorts: req.DstPorts}, nil
}

func (h *handlers) diagnoseDoc(ctx context.Context, doc projectdoc.ProjectDoc, flow diagnose.Flow) (any, error) {
	topoYAML, err := yaml.Marshal(doc.Topology)
	if err != nil {
		return nil, err
	}
	subnetsYAML, err := yaml.Marshal(doc.Subnets)
	if err != nil {
		return nil, err
	}
	rulesYAML, err := yaml.Marshal(doc.Rules)
	if err != nil {
		return nil, err
	}
	return app.Diagnose(ctx, h.log, app.DiagnoseOptions{TopologyYAML: topoYAML, SubnetsYAML: subnetsYAML, RulesYAML: rulesYAML, Flow: flow})
}

func (h *handlers) diagnoseCurrent(w http.ResponseWriter, r *http.Request) {
	flow, err := parseDiagnoseRequest(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	doc, err := h.currentDoc(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	rep, err := h.diagnoseDoc(r.Context(), doc, flow)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

func (h *handlers) diagnoseDraft(w http.ResponseWriter, r *http.Request) {
	flow, err := parseDiagnoseRequest(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	doc, _, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	rep, err := h.diagnoseDoc(r.Context(), doc, flow)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

// spreadRequest is the body of the network-propagation endpoint: the source
// input (subnet name, network name, or literal IP) plus an optional traffic
// filter shared by every candidate diagnostic.
type spreadRequest struct {
	Src      string   `json:"src"`
	Proto    string   `json:"proto"`
	DstPorts []string `json:"dstPorts"`
}

// spreadDoc runs the network-propagation query over one project document:
// resolve the input into sources, diagnose every other subnet toward them,
// and merge the per-pair map marks into one picture.
func (h *handlers) spreadDoc(ctx context.Context, doc projectdoc.ProjectDoc, req spreadRequest) (*diagnose.SpreadResult, error) {
	topoYAML, err := yaml.Marshal(doc.Topology)
	if err != nil {
		return nil, err
	}
	subnetsYAML, err := yaml.Marshal(doc.Subnets)
	if err != nil {
		return nil, err
	}
	rulesYAML, err := yaml.Marshal(doc.Rules)
	if err != nil {
		return nil, err
	}
	return app.Spread(ctx, h.log, app.SpreadOptions{
		TopologyYAML: topoYAML,
		SubnetsYAML:  subnetsYAML,
		RulesYAML:    rulesYAML,
		Input:        req.Src,
		Proto:        rules.Proto(req.Proto),
		DstPorts:     req.DstPorts,
	})
}

func parseSpreadRequest(r *http.Request) (spreadRequest, error) {
	var req spreadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return req, fmt.Errorf("invalid body: %w", err)
	}
	if req.Src == "" {
		return req, fmt.Errorf("src: источник не указан")
	}
	if !diagnoseProtos[req.Proto] {
		return req, fmt.Errorf("invalid proto %q", req.Proto)
	}
	if err := validatePortList(req.DstPorts); err != nil {
		return req, err
	}
	return req, nil
}

func (h *handlers) spreadCurrent(w http.ResponseWriter, r *http.Request) {
	req, err := parseSpreadRequest(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	doc, err := h.currentDoc(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	out, err := h.spreadDoc(r.Context(), doc, req)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *handlers) spreadDraft(w http.ResponseWriter, r *http.Request) {
	req, err := parseSpreadRequest(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	doc, _, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	out, err := h.spreadDoc(r.Context(), doc, req)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *handlers) lintDoc(ctx context.Context, doc projectdoc.ProjectDoc) (any, error) {
	topo, err := loadTopologyDoc(doc)
	if err != nil {
		return nil, err
	}
	pol := doc.Rules.ToPolicy()
	return app.Lint(ctx, h.log, topo, &pol)
}

func (h *handlers) lintCurrent(w http.ResponseWriter, r *http.Request) {
	doc, err := h.currentDoc(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	findings, err := h.lintDoc(r.Context(), doc)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"findings": findings})
}

func (h *handlers) lintDraft(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	doc, _, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	findings, err := h.lintDoc(r.Context(), doc)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"findings": findings})
}
