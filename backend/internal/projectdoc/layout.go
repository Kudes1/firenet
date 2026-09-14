package projectdoc

// LayoutPoint is a 2D canvas position.
type LayoutPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// LayoutCamera is the canvas viewport's pan/zoom state.
type LayoutCamera struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
}

// LayoutDoc is the full wire shape of the UI canvas layout: node
// positions keyed by name, link waypoints keyed by the same
// "min(a,b)|max(a,b)" pair topology.Validate uses for link identity, and
// the camera's pan/zoom. Purely presentational — never reaches the
// compiler.
type LayoutDoc struct {
	Devices  map[string]LayoutPoint     `json:"devices,omitempty"`
	Networks map[string]LayoutPoint     `json:"networks,omitempty"`
	Links    map[string][][]LayoutPoint `json:"links,omitempty"`
	Camera   *LayoutCamera              `json:"camera,omitempty"`
}
