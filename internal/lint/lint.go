package lint

// Severity is how strongly a Finding should be surfaced. Neither value
// blocks anything — see the package doc.
type Severity string

const (
	SeverityWarning Severity = "warning"
	SeverityInfo    Severity = "info"
)

// Finding is one static-analysis result.
type Finding struct {
	Severity Severity `json:"severity"`
	Chain    string   `json:"chain"`
	Rules    []string `json:"rules,omitempty"`
	Message  string   `json:"message"`
}
