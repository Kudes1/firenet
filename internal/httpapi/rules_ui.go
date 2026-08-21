package httpapi

import (
	"bytes"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/kudes1/firenet/internal/topology"
)

type endpointOption struct {
	Name    string
	Checked bool
}

type ruleRowView struct {
	Index int
	Rule  RuleDoc
	Src   []endpointOption
	Dst   []endpointOption
}

type bannerView struct {
	Message string
	Kind    string // "ok" or "error"
}

type rulesPanelView struct {
	Doc    PolicyDoc
	Rows   []ruleRowView
	Banner *bannerView
}

var ruleFieldKeyRE = regexp.MustCompile(`^rules\[(\d+)\]\[(\w+)\]$`)

// parseRulesForm reconstructs a PolicyDoc from a submitted #rules-form: every
// row's fields are named rules[N][field], so the whole unsaved table travels
// in one request without any server-side draft/session state.
func parseRulesForm(r *http.Request) (PolicyDoc, error) {
	if err := r.ParseForm(); err != nil {
		return PolicyDoc{}, fmt.Errorf("parse form: %w", err)
	}
	seen := map[int]bool{}
	for key := range r.PostForm {
		if m := ruleFieldKeyRE.FindStringSubmatch(key); m != nil {
			i, _ := strconv.Atoi(m[1])
			seen[i] = true
		}
	}
	indices := make([]int, 0, len(seen))
	for i := range seen {
		indices = append(indices, i)
	}
	sort.Ints(indices)

	doc := PolicyDoc{
		DefaultAction: r.PostForm.Get("defaultAction"),
		ChainName:     r.PostForm.Get("chainName"),
		ChainPosition: r.PostForm.Get("chainPosition"),
	}
	for _, i := range indices {
		p := fmt.Sprintf("rules[%d]", i)
		doc.Rules = append(doc.Rules, RuleDoc{
			Name:     r.PostForm.Get(p + "[name]"),
			Src:      r.PostForm[p+"[src]"],
			Dst:      r.PostForm[p+"[dst]"],
			Proto:    r.PostForm.Get(p + "[proto]"),
			SrcPorts: splitPorts(r.PostForm.Get(p + "[srcPorts]")),
			DstPorts: splitPorts(r.PostForm.Get(p + "[dstPorts]")),
			Action:   r.PostForm.Get(p + "[action]"),
			Mirror:   r.PostForm.Get(p+"[mirror]") != "",
		})
	}
	return doc, nil
}

func splitPorts(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// endpointNames mirrors the client-side Topology.endpointNames() ordering:
// "any", then subnets sorted, then zones sorted, as two separate groups.
func (h *handlers) endpointNames() ([]string, error) {
	topoRaw, err := h.store.ReadTopology()
	if err != nil {
		return nil, err
	}
	topo, err := topology.Load(bytes.NewReader(topoRaw))
	if err != nil {
		return nil, fmt.Errorf("load stored topology: %w", err)
	}
	var subnets, zones []string
	for n := range topo.Subnets {
		subnets = append(subnets, n)
	}
	for n := range topo.Zones {
		zones = append(zones, n)
	}
	sort.Strings(subnets)
	sort.Strings(zones)
	names := append([]string{"any"}, subnets...)
	return append(names, zones...), nil
}

func ruleOptions(names, selected []string) []endpointOption {
	opts := make([]endpointOption, len(names))
	for i, n := range names {
		opts[i] = endpointOption{Name: n, Checked: slices.Contains(selected, n)}
	}
	return opts
}

func buildRows(doc PolicyDoc, endpoints []string) []ruleRowView {
	rows := make([]ruleRowView, len(doc.Rules))
	for i, rule := range doc.Rules {
		rows[i] = ruleRowView{Index: i, Rule: rule, Src: ruleOptions(endpoints, rule.Src), Dst: ruleOptions(endpoints, rule.Dst)}
	}
	return rows
}

func (h *handlers) renderRulesPanel(w http.ResponseWriter, doc PolicyDoc, banner *bannerView) {
	endpoints, err := h.endpointNames()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	view := rulesPanelView{Doc: doc, Rows: buildRows(doc, endpoints), Banner: banner}
	if err := rulesTmpl.ExecuteTemplate(w, "rules-panel", view); err != nil {
		h.log.Error("render rules panel", "err", err)
	}
}

func (h *handlers) renderRulesTbody(w http.ResponseWriter, doc PolicyDoc) {
	endpoints, err := h.endpointNames()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := rulesTmpl.ExecuteTemplate(w, "rules-rows", buildRows(doc, endpoints)); err != nil {
		h.log.Error("render rules tbody", "err", err)
	}
}

func (h *handlers) renderBanner(w http.ResponseWriter, message, kind string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := rulesTmpl.ExecuteTemplate(w, "rules-banner", &bannerView{Message: message, Kind: kind}); err != nil {
		h.log.Error("render rules banner", "err", err)
	}
}

func (h *handlers) uiRules(w http.ResponseWriter, r *http.Request) {
	raw, err := h.store.ReadRules()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	var doc PolicyDoc
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	h.renderRulesPanel(w, doc, nil)
}

func (h *handlers) uiRulesAdd(w http.ResponseWriter, r *http.Request) {
	doc, err := parseRulesForm(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	doc.Rules = append(doc.Rules, RuleDoc{})
	endpoints, err := h.endpointNames()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	idx := len(doc.Rules) - 1
	row := ruleRowView{Index: idx, Rule: doc.Rules[idx], Src: ruleOptions(endpoints, nil), Dst: ruleOptions(endpoints, nil)}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := rulesTmpl.ExecuteTemplate(w, "rules-row", row); err != nil {
		h.log.Error("render rules row", "err", err)
	}
}

func (h *handlers) uiRulesDelete(w http.ResponseWriter, r *http.Request) {
	idx, err := strconv.Atoi(r.PathValue("index"))
	if err != nil {
		http.Error(w, "bad index", http.StatusBadRequest)
		return
	}
	doc, err := parseRulesForm(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if idx >= 0 && idx < len(doc.Rules) {
		doc.Rules = append(doc.Rules[:idx], doc.Rules[idx+1:]...)
	}
	h.renderRulesTbody(w, doc)
}

func (h *handlers) uiRulesMove(delta int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		idx, err := strconv.Atoi(r.PathValue("index"))
		if err != nil {
			http.Error(w, "bad index", http.StatusBadRequest)
			return
		}
		doc, err := parseRulesForm(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		j := idx + delta
		if idx >= 0 && idx < len(doc.Rules) && j >= 0 && j < len(doc.Rules) {
			doc.Rules[idx], doc.Rules[j] = doc.Rules[j], doc.Rules[idx]
		}
		h.renderRulesTbody(w, doc)
	}
}

func (h *handlers) uiRulesSave(w http.ResponseWriter, r *http.Request) {
	doc, err := parseRulesForm(r)
	if err != nil {
		h.renderBanner(w, "Ошибка формы: "+err.Error(), "error")
		return
	}
	if _, err := h.validateAndPersistRules(doc); err != nil {
		h.renderBanner(w, "Ошибка сохранения правил: "+err.Error(), "error")
		return
	}
	h.renderBanner(w, "Правила сохранены", "ok")
}
