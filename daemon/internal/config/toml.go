package config

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// This file parses the TOML subset described in the package comment into a flat document; Parse
// then maps the document onto Config.

type kind uint8

const (
	kindString kind = iota + 1
	kindInt
	kindBool
)

func (k kind) String() string {
	switch k {
	case kindString:
		return "a string"
	case kindInt:
		return "an integer"
	case kindBool:
		return "true or false"
	}
	return "a value"
}

type value struct {
	kind    kind
	str     string
	num     int64
	boolean bool
	line    int
}

type header struct {
	name string
	line int
}

type entry struct {
	section string
	key     string
	value   value
}

// document is a parsed file: section headers and key/value entries in file order.
type document struct {
	sections []header
	entries  []entry
}

func parseDocument(data []byte) (*document, error) {
	if !utf8.Valid(data) {
		return nil, errorAt(0, "the file is not valid UTF-8")
	}
	doc := &document{}
	section := ""
	sections := map[string]bool{}
	keys := map[string]bool{}
	text := strings.TrimPrefix(string(data), "﻿")
	for i, raw := range strings.Split(text, "\n") {
		line := i + 1
		s := strings.TrimSpace(raw)
		if s == "" || s[0] == '#' {
			continue
		}
		if s[0] == '[' {
			name, err := parseHeader(s)
			if err != nil {
				return nil, errorAt(line, "%v", err)
			}
			if sections[name] {
				return nil, errorAt(line, "section [%s] appears twice", name)
			}
			sections[name] = true
			section = name
			doc.sections = append(doc.sections, header{name: name, line: line})
			continue
		}
		key, rest, ok := strings.Cut(s, "=")
		if !ok {
			return nil, errorAt(line, "expected key = value")
		}
		key = strings.TrimSpace(key)
		if !isBare(key) {
			return nil, errorAt(line, "key %q must be bare (A-Z a-z 0-9 _ -); dotted and quoted keys are not supported", key)
		}
		v, err := parseValue(strings.TrimSpace(rest))
		if err != nil {
			return nil, errorAt(line, "%s: %v", key, err)
		}
		v.line = line
		name := qualified(section, key)
		if keys[name] {
			return nil, errorAt(line, "%s appears twice", name)
		}
		keys[name] = true
		doc.entries = append(doc.entries, entry{section: section, key: key, value: v})
	}
	return doc, nil
}

func parseHeader(s string) (string, error) {
	if strings.HasPrefix(s, "[[") {
		return "", errors.New("arrays of tables are not supported")
	}
	end := strings.IndexByte(s, ']')
	if end < 0 {
		return "", errors.New("unterminated section header")
	}
	name := strings.TrimSpace(s[1:end])
	if !isBare(name) {
		return "", fmt.Errorf("section name %q must be bare (A-Z a-z 0-9 _ -)", name)
	}
	if err := trailing(s[end+1:]); err != nil {
		return "", err
	}
	return name, nil
}

// parseValue parses the text after "=", already trimmed, including any trailing comment.
func parseValue(s string) (value, error) {
	switch {
	case s == "":
		return value{}, errors.New("missing value")
	case strings.HasPrefix(s, `"""`) || strings.HasPrefix(s, "'''"):
		return value{}, errors.New("multi-line strings are not supported")
	case s[0] == '"':
		str, rest, err := parseBasicString(s)
		if err != nil {
			return value{}, err
		}
		if err := trailing(rest); err != nil {
			return value{}, err
		}
		return value{kind: kindString, str: str}, nil
	case s[0] == '\'':
		end := strings.IndexByte(s[1:], '\'')
		if end < 0 {
			return value{}, errors.New("unterminated literal string")
		}
		str := s[1 : 1+end]
		if hasControl(str) {
			return value{}, errors.New("control characters are not allowed in literal strings")
		}
		if err := trailing(s[2+end:]); err != nil {
			return value{}, err
		}
		return value{kind: kindString, str: str}, nil
	case s[0] == '[' || s[0] == '{':
		return value{}, errors.New("arrays and inline tables are not supported")
	}
	token := s
	if i := strings.IndexByte(s, '#'); i >= 0 {
		token = strings.TrimSpace(s[:i])
	}
	switch token {
	case "":
		return value{}, errors.New("missing value")
	case "true":
		return value{kind: kindBool, boolean: true}, nil
	case "false":
		return value{kind: kindBool}, nil
	}
	n, err := parseInteger(token)
	if err != nil {
		return value{}, err
	}
	return value{kind: kindInt, num: n}, nil
}

// parseBasicString parses a "..." string at the start of s and returns it with the text after it.
func parseBasicString(s string) (string, string, error) {
	var b strings.Builder
	for i := 1; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"':
			return b.String(), s[i+1:], nil
		case c == '\\':
			if i+1 >= len(s) {
				return "", "", errors.New("unterminated escape sequence")
			}
			i++
			switch s[i] {
			case 'b':
				b.WriteByte('\b')
			case 't':
				b.WriteByte('\t')
			case 'n':
				b.WriteByte('\n')
			case 'f':
				b.WriteByte('\f')
			case 'r':
				b.WriteByte('\r')
			case '"':
				b.WriteByte('"')
			case '\\':
				b.WriteByte('\\')
			case 'u', 'U':
				size := 4
				if s[i] == 'U' {
					size = 8
				}
				if i+size >= len(s) {
					return "", "", errors.New("unterminated unicode escape")
				}
				digits := s[i+1 : i+1+size]
				code, err := strconv.ParseUint(digits, 16, 32)
				if err != nil || !utf8.ValidRune(rune(code)) {
					return "", "", fmt.Errorf("invalid unicode escape %q", digits)
				}
				b.WriteRune(rune(code))
				i += size
			default:
				return "", "", fmt.Errorf("invalid escape sequence \\%c", s[i])
			}
		case c < 0x20 && c != '\t' || c == 0x7f:
			return "", "", errors.New("control characters must be escaped")
		default:
			b.WriteByte(c)
		}
	}
	return "", "", errors.New("unterminated string")
}

// parseInteger parses a TOML decimal integer: an optional sign, no leading zeros, _ only between
// digits. Hexadecimal, octal and binary forms are rejected along with everything else.
func parseInteger(token string) (int64, error) {
	unsupported := fmt.Errorf("unsupported value %q: strings need quotes; floats, dates and arrays are not supported", token)
	digits := strings.TrimLeft(token, "+-")
	if digits == "" || len(token)-len(digits) > 1 {
		return 0, unsupported
	}
	if len(digits) > 1 && digits[0] == '0' {
		return 0, fmt.Errorf("integer %q must not have a leading zero", token)
	}
	afterDigit := false
	for i := 0; i < len(digits); i++ {
		c := digits[i]
		switch {
		case c >= '0' && c <= '9':
			afterDigit = true
		case c == '_' && afterDigit && i+1 < len(digits):
			afterDigit = false
		default:
			return 0, unsupported
		}
	}
	n, err := strconv.ParseInt(strings.ReplaceAll(token, "_", ""), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("integer %q is out of range", token)
	}
	return n, nil
}

// trailing accepts what may follow a value or header: nothing, or a comment.
func trailing(rest string) error {
	rest = strings.TrimSpace(rest)
	if rest != "" && rest[0] != '#' {
		return fmt.Errorf("unexpected %q (only a # comment may follow)", rest)
	}
	return nil
}

func isBare(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

func hasControl(s string) bool {
	for i := 0; i < len(s); i++ {
		if c := s[i]; c < 0x20 && c != '\t' || c == 0x7f {
			return true
		}
	}
	return false
}
