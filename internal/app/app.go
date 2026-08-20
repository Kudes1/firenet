// Package app holds firenet's core logic, independent of any delivery
// mechanism (CLI today, HTTP later).
package app

import "runtime/debug"

// Version returns the module version embedded in the build, or "dev" when
// running outside of a versioned build (e.g. `go run`).
func Version() string {
	info, ok := debug.ReadBuildInfo()
	if !ok || info.Main.Version == "" {
		return "dev"
	}
	return info.Main.Version
}
