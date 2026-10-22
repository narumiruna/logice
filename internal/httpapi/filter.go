package httpapi

import (
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/narumiruna/logice/internal/telemetry"
)

func parseFilter(rawQuery, route, traceID string, now time.Time) (telemetry.Filter, error) {
	f := telemetry.Filter{From: now.Add(-time.Hour), To: now, Limit: 50}
	values, err := url.ParseQuery(rawQuery)
	if err != nil {
		return f, errors.New("invalid query parameters")
	}
	allowed := map[string]bool{"from": true, "to": true}
	if route != "detail" {
		for _, key := range []string{"service", "search", "limit"} {
			allowed[key] = true
		}
		if route == "traces" {
			allowed["errorsOnly"] = true
		} else {
			allowed["minSeverity"], allowed["traceId"] = true, true
		}
	}
	for key, entries := range values {
		if !allowed[key] {
			return f, errors.New("unknown query parameter")
		}
		if len(entries) != 1 {
			return f, errors.New("duplicate query parameter")
		}
	}
	if values.Has("from") != values.Has("to") {
		return f, errors.New("from and to must be supplied together")
	}
	if values.Has("from") {
		f.From, err = time.Parse(time.RFC3339Nano, values.Get("from"))
		if err != nil {
			return f, errors.New("from must be an RFC3339Nano timestamp")
		}
		f.To, err = time.Parse(time.RFC3339Nano, values.Get("to"))
		if err != nil {
			return f, errors.New("to must be an RFC3339Nano timestamp")
		}
	}
	f.Service, f.Search = values.Get("service"), values.Get("search")
	if values.Has("limit") {
		f.Limit, err = strconv.Atoi(values.Get("limit"))
		if err != nil || f.Limit < 1 || f.Limit > 100 {
			return f, errors.New("limit must be between 1 and 100")
		}
	}
	if values.Has("errorsOnly") {
		f.ErrorsOnly, err = strconv.ParseBool(values.Get("errorsOnly"))
		if err != nil {
			return f, errors.New("errorsOnly must be a boolean")
		}
	}
	if values.Has("minSeverity") {
		f.MinSeverity, err = strconv.Atoi(values.Get("minSeverity"))
		if err != nil {
			return f, errors.New("minSeverity must be between 0 and 24")
		}
	}
	f.TraceID = strings.ToLower(values.Get("traceId"))
	if values.Has("traceId") && f.TraceID == "" {
		return f, errors.New("traceId must not be empty")
	}
	if route == "detail" {
		f.TraceID = strings.ToLower(traceID)
	}
	return f, f.Validate()
}
