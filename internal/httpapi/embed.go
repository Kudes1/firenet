package httpapi

import "embed"

//go:embed web
var webFiles embed.FS

//go:embed templates
var templateFiles embed.FS
