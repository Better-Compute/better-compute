// Package support builds what leaves a node for support (logs.collect, support bundles) and scans it
// for secrets first (PLAN.md §6 "Support bundles are scanned for bcjt_/biam_ tokens", §16 v0.1
// "support bundles hold no tokens"). The patterns mirror @better-compute/pki redact.ts.
package support

import (
	"regexp"
	"sort"
	"strings"
)

// Kind is a kind of secret the scanner recognizes.
type Kind string

// Secret kinds.
const (
	KindJoinToken   Kind = "join-token"
	KindIAMToken    Kind = "iam-token"
	KindJWT         Kind = "jwt"
	KindPrivateKey  Kind = "private-key"
	KindURLPassword Kind = "url-password"
	KindKnown       Kind = "known-value"
)

type pattern struct {
	kind Kind
	re   *regexp.Regexp
	// group, when non-zero, is the submatch that is the secret.
	group int
}

var patterns = []pattern{
	{kind: KindPrivateKey, re: regexp.MustCompile(`(?s)-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----.*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----`)},
	{kind: KindJoinToken, re: regexp.MustCompile(`\bbcjt_[A-Za-z0-9._-]+`)},
	{kind: KindIAMToken, re: regexp.MustCompile(`\bbiam_[A-Za-z0-9._-]+`)},
	{kind: KindJWT, re: regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){2,4}`)},
	// The password of scheme://user:password@host (a redacted one is never matched again).
	{kind: KindURLPassword, re: regexp.MustCompile(`(?i)\b[a-z][a-z0-9+.-]*://[^\s:/@]*:([^\s@/]+)@`), group: 1},
}

// Finding is one secret in a text.
type Finding struct {
	Kind   Kind
	Index  int
	Length int
}

// Find returns every secret in text, in order of position; overlapping matches merge into one
// finding covering their union, with the kind of the longest match. Known values (at least 8
// characters) are found too.
func Find(text string, known ...string) []Finding {
	var matches []Finding
	all := patterns
	var values []string
	for _, v := range known {
		if len(v) >= 8 {
			values = append(values, regexp.QuoteMeta(v))
		}
	}
	if len(values) > 0 {
		sort.Slice(values, func(i, j int) bool { return len(values[i]) > len(values[j]) })
		all = append([]pattern{{kind: KindKnown, re: regexp.MustCompile(strings.Join(values, "|"))}}, patterns...)
	}
	for _, p := range all {
		for _, m := range p.re.FindAllStringSubmatchIndex(text, -1) {
			start, end := m[0], m[1]
			if p.group > 0 {
				start, end = m[2*p.group], m[2*p.group+1]
				if strings.HasPrefix(text[start:end], "[redacted:") {
					continue
				}
			}
			if end > start {
				matches = append(matches, Finding{Kind: p.kind, Index: start, Length: end - start})
			}
		}
	}
	sort.SliceStable(matches, func(i, j int) bool {
		if matches[i].Index != matches[j].Index {
			return matches[i].Index < matches[j].Index
		}
		return matches[i].Length > matches[j].Length
	})
	var merged []Finding
	var longest []int
	for _, m := range matches {
		if n := len(merged); n > 0 && m.Index < merged[n-1].Index+merged[n-1].Length {
			last := &merged[n-1]
			last.Length = max(last.Length, m.Index+m.Length-last.Index)
			// Ties go to the pattern that says what the secret is (join-token over known-value).
			if m.Length > longest[n-1] || (m.Length == longest[n-1] && last.Kind == KindKnown) {
				last.Kind = m.Kind
				longest[n-1] = m.Length
			}
			continue
		}
		merged = append(merged, m)
		longest = append(longest, m.Length)
	}
	return merged
}

// Redact replaces every secret with [redacted:<kind>]; a token keeps its prefix (bcjt_[redacted]) so a
// reader still sees which credential was there. It returns the text and the number of findings.
func Redact(text string, known ...string) (string, int) {
	findings := Find(text, known...)
	if len(findings) == 0 {
		return text, 0
	}
	var b strings.Builder
	at := 0
	for _, f := range findings {
		b.WriteString(text[at:f.Index])
		switch f.Kind {
		case KindJoinToken:
			b.WriteString("bcjt_[redacted]")
		case KindIAMToken:
			b.WriteString("biam_[redacted]")
		default:
			b.WriteString("[redacted:" + string(f.Kind) + "]")
		}
		at = f.Index + f.Length
	}
	b.WriteString(text[at:])
	return b.String(), len(findings)
}
