package httpapi

import (
	"embed"
	"html/template"
	"strings"
)

//go:embed templates
var templateFiles embed.FS

// rulesTmpl is parsed once at package init: it's immutable, doesn't depend on
// store/log, and every handlers instance shares it.
var rulesTmpl = template.Must(template.New("rules").Funcs(template.FuncMap{
	"join": strings.Join,
}).ParseFS(templateFiles, "templates/*.gohtml"))
