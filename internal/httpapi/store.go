package httpapi

import "os"

// FileProjectStore reads a project's files directly on disk. Used only for
// the one-time legacy-file import into version 1 (see internal/cli/legacy.go)
// — live serving goes through internal/pgstore.
type FileProjectStore struct {
	TopologyPath string
	SubnetsPath  string
	RulesPath    string
	LayoutPath   string
}

func (s FileProjectStore) ReadTopology() ([]byte, error) { return os.ReadFile(s.TopologyPath) }
func (s FileProjectStore) ReadSubnets() ([]byte, error)  { return os.ReadFile(s.SubnetsPath) }
func (s FileProjectStore) ReadRules() ([]byte, error)    { return os.ReadFile(s.RulesPath) }

func (s FileProjectStore) ReadLayout() ([]byte, error) {
	b, err := os.ReadFile(s.LayoutPath)
	if os.IsNotExist(err) {
		return nil, nil
	}
	return b, err
}
