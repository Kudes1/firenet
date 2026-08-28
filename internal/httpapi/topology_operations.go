package httpapi

import (
	"fmt"

	"github.com/kudes1/firenet/internal/projectdoc"
)

// canonicalLink orders two device names so a link's identity doesn't
// depend on which side is A and which is B.
func canonicalLink(a, b string) (string, string) {
	if a > b {
		return b, a
	}
	return a, b
}

// linkIndex finds the link between devices a and b by endpoint pair,
// never by array position.
func linkIndex(links []LinkDoc, a, b string) int {
	a, b = canonicalLink(a, b)
	for i, l := range links {
		x, y := canonicalLink(l.A.Device, l.B.Device)
		if x == a && y == b {
			return i
		}
	}
	return -1
}

// layoutLinkKey is the LayoutDoc.Links map key for the link between a and
// b: "min(a,b)|max(a,b)", the same identity linkIndex uses (and the same
// format pgstore.linkKey stores waypoints under).
func layoutLinkKey(a, b string) string {
	a, b = canonicalLink(a, b)
	return a + "|" + b
}

func deviceIndex(devices []DeviceDoc, name string) int {
	for i, d := range devices {
		if d.Name == name {
			return i
		}
	}
	return -1
}

func networkIndex(networks []NetworkDoc, name string) int {
	for i, n := range networks {
		if n.Name == name {
			return i
		}
	}
	return -1
}

func unionIndex(unions []UnionDoc, name string) int {
	for i, u := range unions {
		if u.Name == name {
			return i
		}
	}
	return -1
}

// removeString returns ss without its first occurrence of s.
func removeString(ss []string, s string) []string {
	for i, v := range ss {
		if v == s {
			return append(ss[:i:i], ss[i+1:]...)
		}
	}
	return ss
}

func removeAllStrings(ss []string, s string) []string {
	next := make([]string, 0, len(ss))
	for _, v := range ss {
		if v != s {
			next = append(next, v)
		}
	}
	return next
}

// cloneProjectDoc deep-copies the parts of doc a topology operation can
// mutate (Topology, Layout), so applying an operation never aliases the
// caller's slices/maps. Subnets and Rules are never written by a topology
// operation, so a shallow copy of doc is enough for them.
func cloneProjectDoc(doc projectdoc.ProjectDoc) projectdoc.ProjectDoc {
	next := doc
	next.Topology.Devices = append([]DeviceDoc(nil), doc.Topology.Devices...)
	next.Topology.Links = append([]LinkDoc(nil), doc.Topology.Links...)
	next.Topology.Sets = append([]SetDoc(nil), doc.Topology.Sets...)

	next.Topology.Networks = make([]NetworkDoc, len(doc.Topology.Networks))
	for i, n := range doc.Topology.Networks {
		n.Subnets = append([]string(nil), n.Subnets...)
		n.Attach = append([]EndpointDoc(nil), n.Attach...)
		next.Topology.Networks[i] = n
	}

	next.Topology.Unions = make([]UnionDoc, len(doc.Topology.Unions))
	for i, u := range doc.Topology.Unions {
		u.Devices = append([]string(nil), u.Devices...)
		u.Networks = append([]string(nil), u.Networks...)
		next.Topology.Unions[i] = u
	}

	next.Layout.Devices = cloneLayoutPoints(doc.Layout.Devices)
	next.Layout.Networks = cloneLayoutPoints(doc.Layout.Networks)
	next.Layout.Links = make(map[string][][]LayoutPoint, len(doc.Layout.Links))
	for k, waypoints := range doc.Layout.Links {
		next.Layout.Links[k] = append([][]LayoutPoint(nil), waypoints...)
	}
	if doc.Layout.Camera != nil {
		camera := *doc.Layout.Camera
		next.Layout.Camera = &camera
	}
	return next
}

func cloneLayoutPoints(m map[string]LayoutPoint) map[string]LayoutPoint {
	next := make(map[string]LayoutPoint, len(m))
	for k, v := range m {
		next[k] = v
	}
	return next
}

// applyTopologyOperation applies exactly one draft-mutating command to a
// copy of doc and returns the result; doc itself is never mutated. Only
// the fields the command's Kind names are read from op.
//
// This keeps doc's own topology+layout internally consistent for that one
// command (e.g. deleting a device also drops the links/attachments/union
// memberships/layout position that named it) — it does not run
// cross-document validation (rules references, full topology.Validate).
// That stays the HTTP handler's job, run once after the operation applies.
//
// On error, doc is returned unchanged.
func applyTopologyOperation(doc projectdoc.ProjectDoc, op topologyOperation) (projectdoc.ProjectDoc, error) {
	next := cloneProjectDoc(doc)
	topo := &next.Topology
	layout := &next.Layout

	switch op.Kind {

	case "create-device":
		if op.Device == nil {
			return doc, fmt.Errorf("create-device: missing device")
		}
		topo.Devices = append(topo.Devices, *op.Device)

	case "delete-device":
		if op.DeviceName == "" {
			return doc, fmt.Errorf("delete-device: missing deviceName")
		}
		i := deviceIndex(topo.Devices, op.DeviceName)
		if i < 0 {
			return doc, fmt.Errorf("delete-device: unknown device %q", op.DeviceName)
		}
		topo.Devices = append(topo.Devices[:i:i], topo.Devices[i+1:]...)

		kept := topo.Links[:0]
		for _, l := range topo.Links {
			if l.A.Device == op.DeviceName || l.B.Device == op.DeviceName {
				delete(layout.Links, layoutLinkKey(l.A.Device, l.B.Device))
				continue
			}
			kept = append(kept, l)
		}
		topo.Links = kept

		for ni, n := range topo.Networks {
			for ei, e := range n.Attach {
				if e.Device == op.DeviceName {
					topo.Networks[ni].Attach = append(n.Attach[:ei:ei], n.Attach[ei+1:]...)
					break
				}
			}
		}
		for ui, u := range topo.Unions {
			topo.Unions[ui].Devices = removeString(u.Devices, op.DeviceName)
		}
		delete(layout.Devices, op.DeviceName)

	case "create-network":
		if op.Network == nil {
			return doc, fmt.Errorf("create-network: missing network")
		}
		topo.Networks = append(topo.Networks, *op.Network)

	case "delete-network":
		if op.NetworkName == "" {
			return doc, fmt.Errorf("delete-network: missing networkName")
		}
		i := networkIndex(topo.Networks, op.NetworkName)
		if i < 0 {
			return doc, fmt.Errorf("delete-network: unknown network %q", op.NetworkName)
		}
		topo.Networks = append(topo.Networks[:i:i], topo.Networks[i+1:]...)
		for ui, u := range topo.Unions {
			topo.Unions[ui].Networks = removeString(u.Networks, op.NetworkName)
		}
		for li, l := range topo.Links {
			if l.Filter == nil {
				continue
			}
			filter := *l.Filter
			filter.AExports = removeAllStrings(filter.AExports, op.NetworkName)
			filter.BExports = removeAllStrings(filter.BExports, op.NetworkName)
			topo.Links[li].Filter = &filter
		}
		delete(layout.Networks, op.NetworkName)

	case "create-link":
		if op.Link == nil {
			return doc, fmt.Errorf("create-link: missing link")
		}
		topo.Links = append(topo.Links, *op.Link)

	case "delete-link":
		if op.Link == nil {
			return doc, fmt.Errorf("delete-link: missing link")
		}
		i := linkIndex(topo.Links, op.Link.A.Device, op.Link.B.Device)
		if i < 0 {
			return doc, fmt.Errorf("delete-link: unknown link %q-%q", op.Link.A.Device, op.Link.B.Device)
		}
		delete(layout.Links, layoutLinkKey(op.Link.A.Device, op.Link.B.Device))
		topo.Links = append(topo.Links[:i:i], topo.Links[i+1:]...)

	case "set-link-filter":
		if op.Link == nil || op.Filter == nil {
			return doc, fmt.Errorf("set-link-filter: missing link or filter")
		}
		i := linkIndex(topo.Links, op.Link.A.Device, op.Link.B.Device)
		if i < 0 {
			return doc, fmt.Errorf("set-link-filter: unknown link %q-%q", op.Link.A.Device, op.Link.B.Device)
		}
		filter := *op.Filter
		topo.Links[i].Filter = &filter

	case "clear-link-filter":
		if op.Link == nil {
			return doc, fmt.Errorf("clear-link-filter: missing link")
		}
		i := linkIndex(topo.Links, op.Link.A.Device, op.Link.B.Device)
		if i < 0 {
			return doc, fmt.Errorf("clear-link-filter: unknown link %q-%q", op.Link.A.Device, op.Link.B.Device)
		}
		topo.Links[i].Filter = nil

	case "create-union":
		if op.Union == nil {
			return doc, fmt.Errorf("create-union: missing union")
		}
		topo.Unions = append(topo.Unions, *op.Union)

	case "delete-union":
		if op.UnionName == "" {
			return doc, fmt.Errorf("delete-union: missing unionName")
		}
		i := unionIndex(topo.Unions, op.UnionName)
		if i < 0 {
			return doc, fmt.Errorf("delete-union: unknown union %q", op.UnionName)
		}
		topo.Unions = append(topo.Unions[:i:i], topo.Unions[i+1:]...)

	case "attach-network":
		if op.NetworkName == "" || op.Attach == nil {
			return doc, fmt.Errorf("attach-network: missing networkName or attach")
		}
		i := networkIndex(topo.Networks, op.NetworkName)
		if i < 0 {
			return doc, fmt.Errorf("attach-network: unknown network %q", op.NetworkName)
		}
		for _, e := range topo.Networks[i].Attach {
			if e.Device == op.Attach.Device {
				return doc, fmt.Errorf("attach-network: %q already attached to %q", op.Attach.Device, op.NetworkName)
			}
		}
		topo.Networks[i].Attach = append(topo.Networks[i].Attach, *op.Attach)

	case "detach-network":
		if op.NetworkName == "" || op.Attach == nil {
			return doc, fmt.Errorf("detach-network: missing networkName or attach")
		}
		ni := networkIndex(topo.Networks, op.NetworkName)
		if ni < 0 {
			return doc, fmt.Errorf("detach-network: unknown network %q", op.NetworkName)
		}
		attach := topo.Networks[ni].Attach
		ei := -1
		for i, e := range attach {
			if e.Device == op.Attach.Device {
				ei = i
				break
			}
		}
		if ei < 0 {
			return doc, fmt.Errorf("detach-network: %q is not attached to %q", op.Attach.Device, op.NetworkName)
		}
		topo.Networks[ni].Attach = append(attach[:ei:ei], attach[ei+1:]...)

	case "union-add-device":
		if op.UnionName == "" || op.DeviceName == "" {
			return doc, fmt.Errorf("union-add-device: missing unionName or deviceName")
		}
		i := unionIndex(topo.Unions, op.UnionName)
		if i < 0 {
			return doc, fmt.Errorf("union-add-device: unknown union %q", op.UnionName)
		}
		for _, d := range topo.Unions[i].Devices {
			if d == op.DeviceName {
				return doc, fmt.Errorf("union-add-device: %q already in union %q", op.DeviceName, op.UnionName)
			}
		}
		topo.Unions[i].Devices = append(topo.Unions[i].Devices, op.DeviceName)

	case "union-remove-device":
		if op.UnionName == "" || op.DeviceName == "" {
			return doc, fmt.Errorf("union-remove-device: missing unionName or deviceName")
		}
		i := unionIndex(topo.Unions, op.UnionName)
		if i < 0 {
			return doc, fmt.Errorf("union-remove-device: unknown union %q", op.UnionName)
		}
		topo.Unions[i].Devices = removeString(topo.Unions[i].Devices, op.DeviceName)

	case "union-add-network":
		if op.UnionName == "" || op.NetworkName == "" {
			return doc, fmt.Errorf("union-add-network: missing unionName or networkName")
		}
		i := unionIndex(topo.Unions, op.UnionName)
		if i < 0 {
			return doc, fmt.Errorf("union-add-network: unknown union %q", op.UnionName)
		}
		for _, n := range topo.Unions[i].Networks {
			if n == op.NetworkName {
				return doc, fmt.Errorf("union-add-network: %q already in union %q", op.NetworkName, op.UnionName)
			}
		}
		topo.Unions[i].Networks = append(topo.Unions[i].Networks, op.NetworkName)

	case "union-remove-network":
		if op.UnionName == "" || op.NetworkName == "" {
			return doc, fmt.Errorf("union-remove-network: missing unionName or networkName")
		}
		i := unionIndex(topo.Unions, op.UnionName)
		if i < 0 {
			return doc, fmt.Errorf("union-remove-network: unknown union %q", op.UnionName)
		}
		topo.Unions[i].Networks = removeString(topo.Unions[i].Networks, op.NetworkName)

	case "set-device-position":
		if op.DeviceName == "" || op.Position == nil {
			return doc, fmt.Errorf("set-device-position: missing deviceName or position")
		}
		if deviceIndex(topo.Devices, op.DeviceName) < 0 {
			return doc, fmt.Errorf("set-device-position: unknown device %q", op.DeviceName)
		}
		layout.Devices[op.DeviceName] = *op.Position

	case "set-network-position":
		if op.NetworkName == "" || op.Position == nil {
			return doc, fmt.Errorf("set-network-position: missing networkName or position")
		}
		if networkIndex(topo.Networks, op.NetworkName) < 0 {
			return doc, fmt.Errorf("set-network-position: unknown network %q", op.NetworkName)
		}
		layout.Networks[op.NetworkName] = *op.Position

	case "set-link-waypoints":
		if op.Link == nil {
			return doc, fmt.Errorf("set-link-waypoints: missing link")
		}
		if linkIndex(topo.Links, op.Link.A.Device, op.Link.B.Device) < 0 {
			return doc, fmt.Errorf("set-link-waypoints: unknown link %q-%q", op.Link.A.Device, op.Link.B.Device)
		}
		layout.Links[layoutLinkKey(op.Link.A.Device, op.Link.B.Device)] = op.Waypoints

	case "set-camera":
		if op.Camera == nil {
			return doc, fmt.Errorf("set-camera: missing camera")
		}
		camera := *op.Camera
		layout.Camera = &camera

	default:
		return doc, fmt.Errorf("unknown topology operation kind %q", op.Kind)
	}

	return next, nil
}
