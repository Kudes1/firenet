package httpapi

import (
	"fmt"
	"os"
	"path/filepath"
)

// FileProjectStore reads/writes a project's files directly on disk. Used
// only for the one-time legacy-file import into version 1 (see
// internal/cli/legacy.go) — live serving goes through internal/pgstore.
type FileProjectStore struct {
	TopologyPath string
	SubnetsPath  string
	RulesPath    string
	LayoutPath   string
}

func (s FileProjectStore) ReadTopology() ([]byte, error) { return os.ReadFile(s.TopologyPath) }
func (s FileProjectStore) WriteTopology(b []byte) error  { return writeFileAtomic(s.TopologyPath, b) }
func (s FileProjectStore) ReadSubnets() ([]byte, error)  { return os.ReadFile(s.SubnetsPath) }
func (s FileProjectStore) WriteSubnets(b []byte) error   { return writeFileAtomic(s.SubnetsPath, b) }
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
