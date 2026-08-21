package httpapi

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// ProjectStore is the persistence seam between the HTTP API and where a
// project's topology/rules/layout actually live. FileProjectStore (a single
// directory's worth of files) is the only implementation today; a future
// multi-project/team server can swap in a different one without touching a
// single handler.
type ProjectStore interface {
	ReadTopology() ([]byte, error)
	WriteTopology([]byte) error
	ReadRules() ([]byte, error)
	WriteRules([]byte) error
	// ReadLayout returns (nil, nil) if no layout has been saved yet.
	ReadLayout() ([]byte, error)
	WriteLayout([]byte) error
}

// FileProjectStore reads/writes a project's files directly on disk.
type FileProjectStore struct {
	TopologyPath string
	RulesPath    string
	LayoutPath   string
}

func (s FileProjectStore) ReadTopology() ([]byte, error) { return os.ReadFile(s.TopologyPath) }
func (s FileProjectStore) WriteTopology(b []byte) error  { return writeFileAtomic(s.TopologyPath, b) }
func (s FileProjectStore) ReadRules() ([]byte, error)    { return os.ReadFile(s.RulesPath) }
func (s FileProjectStore) WriteRules(b []byte) error     { return writeFileAtomic(s.RulesPath, b) }

func (s FileProjectStore) ReadLayout() ([]byte, error) {
	b, err := os.ReadFile(s.LayoutPath)
	if os.IsNotExist(err) {
		return nil, nil
	}
	return b, err
}

func (s FileProjectStore) WriteLayout(b []byte) error { return writeFileAtomic(s.LayoutPath, b) }

// EnsureSeeded creates empty-but-valid topology/rules files at the store's
// paths if they don't already exist, so a brand-new project can be started
// purely from the browser instead of requiring hand-written YAML up front.
func (s FileProjectStore) EnsureSeeded() error {
	if err := seedIfMissing(s.TopologyPath, emptyTopologyYAML()); err != nil {
		return err
	}
	return seedIfMissing(s.RulesPath, emptyPolicyYAML())
}

func emptyTopologyYAML() []byte {
	b, err := yaml.Marshal(TopologyDoc{
		Devices: []DeviceDoc{},
		Links:   []LinkDoc{},
		Subnets: []SubnetDoc{},
		Zones:   []ZoneDoc{},
	})
	if err != nil {
		panic(err) // static value, can't fail
	}
	return b
}

func emptyPolicyYAML() []byte {
	b, err := yaml.Marshal(PolicyDoc{DefaultAction: "deny", Rules: []RuleDoc{}})
	if err != nil {
		panic(err) // static value, can't fail
	}
	return b
}

func seedIfMissing(path string, content []byte) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("stat %s: %w", path, err)
	}
	return writeFileAtomic(path, content)
}

// writeFileAtomic writes via a temp file + rename so a mid-write crash can't
// corrupt the user's real config file.
func writeFileAtomic(path string, b []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".firenet-tmp-*")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op once renamed into place

	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp file: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("rename into place: %w", err)
	}
	return nil
}
