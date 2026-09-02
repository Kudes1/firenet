package httpapi

import (
	"net/http"
	"strings"

	"github.com/kudes1/firenet/internal/projectdoc"
)

// searchEntry is one row of the search index served to /ui/search. The
// client-side filter matches queries against these flat fields; Prefixes
// carries the entity's CIDR blocks for semantic IP/CIDR matching.
type searchEntry struct {
	Type        string   `json:"type"`
	Name        string   `json:"name"`
	Details     string   `json:"details,omitempty"`
	Description string   `json:"description,omitempty"`
	Prefixes    []string `json:"prefixes,omitempty"`
}

// buildSearchIndex flattens a project into search rows: devices, subnets,
// networks, sets, unions, links and rules. Subnet/member references are
// resolved to their CIDRs so one IP/CIDR query finds every entity that
// contains it.
func buildSearchIndex(doc projectdoc.ProjectDoc) []searchEntry {
	cidrOf := make(map[string]string, len(doc.Subnets.Subnets))
	for _, s := range doc.Subnets.Subnets {
		cidrOf[s.Name] = s.CIDR
	}
	prefixesOf := func(names, extra []string) []string {
		var out []string
		for _, n := range names {
			if c, ok := cidrOf[n]; ok {
				out = append(out, c)
			}
		}
		return append(out, extra...)
	}

	out := make([]searchEntry, 0,
		len(doc.Topology.Devices)+len(doc.Subnets.Subnets)+
			len(doc.Topology.Networks)+len(doc.Topology.Sets)+
			len(doc.Topology.Unions)+len(doc.Topology.Links)+len(doc.Rules.Chains))
	for _, d := range doc.Topology.Devices {
		out = append(out, searchEntry{Type: "device", Name: d.Name, Details: d.Kind, Description: d.Description})
	}
	for _, s := range doc.Subnets.Subnets {
		out = append(out, searchEntry{Type: "subnet", Name: s.Name, Details: s.CIDR, Description: s.Description, Prefixes: []string{s.CIDR}})
	}
	for _, n := range doc.Topology.Networks {
		out = append(out, searchEntry{
			Type: "network", Name: n.Name, Details: strings.Join(n.Subnets, ", "), Description: n.Description,
			Prefixes: prefixesOf(n.Subnets, nil),
		})
	}
	for _, s := range doc.Topology.Sets {
		// Host addresses contribute their /32 form, mirroring what the
		// compiled ipset contains.
		addrs := make([]string, 0, len(s.Addresses))
		for _, a := range s.Addresses {
			addrs = append(addrs, a+"/32")
		}
		out = append(out, searchEntry{
			Type: "set", Name: s.Name, Details: strings.Join(append(append([]string{}, s.Subnets...), s.Addresses...), ", "), Description: s.Description,
			Prefixes: prefixesOf(s.Subnets, addrs),
		})
	}
	for _, u := range doc.Topology.Unions {
		out = append(out, searchEntry{
			Type: "union", Name: u.Name, Details: strings.Join(append(append([]string{}, u.Devices...), u.Networks...), ", "), Description: u.Description,
		})
	}
	for _, l := range doc.Topology.Links {
		out = append(out, searchEntry{Type: "link", Name: l.A.Device + " — " + l.B.Device})
	}
	for _, c := range doc.Rules.Chains {
		for _, r := range c.Rules {
			parts := []string{r.Action}
			if r.Proto != "any" {
				parts = append(parts, r.Proto)
			}
			if len(r.SrcPorts) > 0 {
				parts = append(parts, "sp:"+strings.Join(r.SrcPorts, ","))
			}
			if len(r.DstPorts) > 0 {
				parts = append(parts, "dp:"+strings.Join(r.DstPorts, ","))
			}
			if r.Comment != "" {
				parts = append(parts, r.Comment)
			}
			out = append(out, searchEntry{
				Type: "rule", Name: r.Name, Details: strings.Join(r.Src, ", ") + " → " + strings.Join(r.Dst, ", "),
				Description: strings.Join(parts, " · "),
			})
		}
	}
	return out
}

func (h *handlers) getCurrentSearchIndex(w http.ResponseWriter, r *http.Request) {
	doc, err := h.currentDoc(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, buildSearchIndex(doc))
}

func (h *handlers) getDraftSearchIndex(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	doc, revision, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("X-Draft-Revision", revision)
	writeJSON(w, http.StatusOK, buildSearchIndex(doc))
}
