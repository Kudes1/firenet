package diagnose

// MergeMarks unions per-pair marks into one spread picture, mirroring the
// frontend merge semantics:
//   - hl/ok/okE/denyE/half/halfE simply union;
//   - deny survives everything (deny beats half beats ok), but an element
//     that any fully round-tripping pair marks ok loses its half marking —
//     ok is promoted after the union;
//   - the first deny info per router wins (same rule in practice).
func MergeMarks(marks []*MapMark) *MapMark {
	m := &MapMark{
		Highlight: []string{},
		Ok:        []string{},
		OkE:       []string{},
		DenyE:     []string{},
		Half:      []string{},
		HalfE:     []string{},
		Deny:      map[string]DenyInfo{},
	}
	for _, src := range marks {
		if src == nil {
			continue
		}
		m.addHL(src.Highlight...)
		m.addOk(src.Ok...)
		m.addOkE(src.OkE...)
		m.addDenyE(src.DenyE...)
		m.Half = appendUnique(m.Half, src.Half...)
		m.HalfE = appendUnique(m.HalfE, src.HalfE...)
		for r, info := range src.Deny {
			if _, ok := m.Deny[r]; !ok {
				m.Deny[r] = info
			}
		}
	}
	// deny beats ok is already resolved inside each per-pair mark (MarkMap
	// removes the denying router from ok); the merge only unions. The
	// renderer keeps final priority: denyE/half/okE are checked in that
	// order at paint time.
	// A full round-trip through an element promotes it out of half.
	for _, n := range m.Ok {
		m.removeHalf(n)
	}
	for _, k := range m.OkE {
		m.removeHalfE(k)
	}
	return m
}

func appendUnique(list []string, items ...string) []string {
	for _, it := range items {
		if !containsStr(list, it) {
			list = append(list, it)
		}
	}
	return list
}

func (m *MapMark) removeHalf(name string) {
	for i, n := range m.Half {
		if n == name {
			m.Half = append(m.Half[:i], m.Half[i+1:]...)
			return
		}
	}
}

func (m *MapMark) removeHalfE(key string) {
	for i, k := range m.HalfE {
		if k == key {
			m.HalfE = append(m.HalfE[:i], m.HalfE[i+1:]...)
			return
		}
	}
}
