package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var errLiveEncoding = errors.New("invalid live JSON value")
var liveTimeType = reflect.TypeFor[time.Time]()
var liveRawType = reflect.TypeFor[json.RawMessage]()

// liveEncodedSize counts the encoder's compact, HTML-escaped JSON, including
// its final newline. Large strings and raw fields are scanned without copying.
// The second capped writer remains an independent final output check.
func liveEncodedSize(ctx context.Context, value any) (int, error) {
	c := liveJSONSize{ctx: ctx}
	if err := c.value(reflect.ValueOf(value)); err != nil {
		return 0, err
	}
	if err := c.add(1); err != nil {
		return 0, err
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	return c.size, nil
}

type liveJSONSize struct {
	ctx         context.Context
	size, steps int
}

func (c *liveJSONSize) add(n int) error {
	c.steps++
	if c.steps%4096 == 1 {
		if err := c.ctx.Err(); err != nil {
			return err
		}
	}
	if n > liveResponseLimit-c.size {
		return errLiveResponseTooLarge
	}
	c.size += n
	return nil
}

func (c *liveJSONSize) value(v reflect.Value) error {
	if v.Type() == liveTimeType {
		raw, err := v.Interface().(time.Time).MarshalJSON()
		if err != nil {
			return errLiveEncoding
		}
		return c.add(len(raw))
	}
	if v.Type() == liveRawType {
		return c.raw(v.Bytes())
	}
	switch v.Kind() {
	case reflect.String:
		return c.string(v.String())
	case reflect.Bool:
		if v.Bool() {
			return c.add(4)
		}
		return c.add(5)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		var buf [32]byte
		return c.add(len(strconv.AppendInt(buf[:0], v.Int(), 10)))
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		var buf [32]byte
		return c.add(len(strconv.AppendUint(buf[:0], v.Uint(), 10)))
	case reflect.Struct:
		if err := c.add(2); err != nil {
			return err
		}
		first := true
		for i := 0; i < v.NumField(); i++ {
			field := v.Type().Field(i)
			if !field.IsExported() {
				continue
			}
			name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
			if name == "-" {
				continue
			}
			if name == "" {
				name = field.Name
			}
			if !first {
				if err := c.add(1); err != nil {
					return err
				}
			}
			first = false
			if err := c.string(name); err != nil {
				return err
			}
			if err := c.add(1); err != nil {
				return err
			}
			if err := c.value(v.Field(i)); err != nil {
				return err
			}
		}
		return nil
	case reflect.Map:
		if v.IsNil() {
			return c.add(4)
		}
		if v.Type().Key().Kind() != reflect.String {
			return errLiveEncoding
		}
		if err := c.add(2); err != nil {
			return err
		}
		iter := v.MapRange()
		first := true
		for iter.Next() {
			if !first {
				if err := c.add(1); err != nil {
					return err
				}
			}
			first = false
			if err := c.string(iter.Key().String()); err != nil {
				return err
			}
			if err := c.add(1); err != nil {
				return err
			}
			if err := c.value(iter.Value()); err != nil {
				return err
			}
		}
		return nil
	case reflect.Slice:
		if v.IsNil() {
			return c.add(4)
		}
		if err := c.add(2); err != nil {
			return err
		}
		for i := 0; i < v.Len(); i++ {
			if i > 0 {
				if err := c.add(1); err != nil {
					return err
				}
			}
			if err := c.value(v.Index(i)); err != nil {
				return err
			}
		}
		return nil
	default:
		return errLiveEncoding
	}
}

func (c *liveJSONSize) string(s string) error {
	if err := c.add(2); err != nil {
		return err
	}
	for i := 0; i < len(s); {
		b := s[i]
		n, advance := 1, 1
		if b < utf8.RuneSelf {
			switch b {
			case '"', '\\', '\b', '\f', '\n', '\r', '\t':
				n = 2
			case '<', '>', '&':
				n = 6
			default:
				if b < 0x20 {
					n = 6
				}
			}
		} else {
			r, width := utf8.DecodeRuneInString(s[i:])
			advance = width
			n = width
			if (r == utf8.RuneError && width == 1) || r == '\u2028' || r == '\u2029' {
				n = 6
			}
		}
		if err := c.add(n); err != nil {
			return err
		}
		i += advance
	}
	return nil
}

// RawMessage encoding compacts whitespace outside strings, preserves existing
// escapes, and escapes literal HTML characters and U+2028/U+2029. It does not
// replace invalid UTF-8 bytes, unlike the ordinary string encoder.
func (c *liveJSONSize) raw(raw []byte) error {
	if raw == nil {
		return c.add(4)
	}
	inside, escaped := false, false
	for i := 0; i < len(raw); i++ {
		b := raw[i]
		if !inside && (b == ' ' || b == '\n' || b == '\r' || b == '\t') {
			if err := c.add(0); err != nil {
				return err
			}
			continue
		}
		n := 1
		if b == '<' || b == '>' || b == '&' {
			n = 6
		}
		if b == 0xe2 && i+2 < len(raw) && raw[i+1] == 0x80 && (raw[i+2] == 0xa8 || raw[i+2] == 0xa9) {
			n = 6
			i += 2
		}
		if err := c.add(n); err != nil {
			return err
		}
		if inside {
			if escaped {
				escaped = false
			} else if b == '\\' {
				escaped = true
			} else if b == '"' {
				inside = false
			}
		} else if b == '"' {
			inside = true
		}
	}
	if !json.Valid(raw) {
		return errLiveEncoding
	}
	return c.ctx.Err()
}
