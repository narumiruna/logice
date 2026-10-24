package alerts

import (
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/narumiruna/logice/internal/telemetry"
)

type Rule struct {
	ID            string     `json:"id"`
	ProjectID     string     `json:"projectId"`
	DestinationID string     `json:"destinationId"`
	Name          string     `json:"name"`
	Kind          string     `json:"kind"`
	Service       string     `json:"service"`
	Threshold     string     `json:"threshold"`
	MinPopulation int        `json:"minPopulation"`
	Enabled       bool       `json:"enabled"`
	Revision      string     `json:"revision"`
	State         string     `json:"state"`
	Bad           int        `json:"bad"`
	Good          int        `json:"good"`
	Active        bool       `json:"incidentActive"`
	LastNotified  *time.Time `json:"lastNotified"`
	CreatedAt     time.Time  `json:"createdAt"`
	Lease         string     `json:"-"`
	LastWindowTo  *time.Time `json:"lastWindowTo"`
}

func (r Rule) Valid() bool {
	if !utf8.ValidString(r.Service) || len(r.Service) > 200 || r.MinPopulation < 1 || r.MinPopulation > 1_000_000 || r.Name == "" || len([]rune(r.Name)) > 80 || strings.TrimSpace(r.Name) != r.Name {
		return false
	}
	switch r.Kind {
	case "error_ratio":
		f, err := strconv.ParseFloat(r.Threshold, 64)
		return err == nil && !math.IsNaN(f) && !math.IsInf(f, 0) && f >= 0 && f <= 1
	case "root_p95":
		v, err := strconv.ParseUint(r.Threshold, 10, 63)
		return err == nil && v > 0
	case "no_data":
		return r.Threshold == "0"
	}
	return false
}

// Evaluate separates unavailable/insufficient populations from actual healthy data.
func Evaluate(r Rule, o telemetry.Overview, queryError error, now time.Time) (Rule, string) {
	next := r
	if queryError != nil {
		next.State = "unknown"
		next.Bad = 0
		next.Good = 0
		return next, ""
	}
	if now.Before(r.CreatedAt.Add(5 * time.Minute)) {
		next.State = "pending"
		return next, ""
	}
	breach := false
	switch r.Kind {
	case "no_data":
		breach = o.Spans == "0" && o.Logs == "0"
	case "error_ratio":
		population, err := strconv.ParseUint(o.Traces, 10, 64)
		if err != nil || population < uint64(r.MinPopulation) || o.ErrorProportion == nil {
			next.State = "unknown"
			next.Bad = 0
			next.Good = 0
			return next, ""
		}
		threshold, _ := strconv.ParseFloat(r.Threshold, 64)
		breach = *o.ErrorProportion > threshold
	case "root_p95":
		population, err := strconv.ParseUint(o.RootSpans, 10, 64)
		if err != nil || population < uint64(r.MinPopulation) || o.P95NS == nil {
			next.State = "unknown"
			next.Bad = 0
			next.Good = 0
			return next, ""
		}
		value, err := strconv.ParseUint(*o.P95NS, 10, 63)
		if err != nil {
			next.State = "unknown"
			return next, ""
		}
		threshold, _ := strconv.ParseUint(r.Threshold, 10, 63)
		breach = value > threshold
	default:
		next.State = "unknown"
		return next, ""
	}
	transition := ""
	if breach {
		next.Good = 0
		next.Bad = min(r.Bad+1, 3)
		next.State = "pending"
		if r.Active {
			next.State = "firing"
		} else if next.Bad >= 3 {
			next.State = "firing"
			next.Active = true
			transition = "firing"
		}
	} else {
		next.Bad = 0
		next.Good = min(r.Good+1, 2)
		if r.Active {
			next.State = "firing"
			if next.Good >= 2 {
				next.Active = false
				next.State = "resolved"
				transition = "resolved"
			}
		} else {
			next.State = "resolved"
		}
	}
	// Preserve a transition even during cooldown by postponing the state commit.
	if transition != "" && r.LastNotified != nil && now.Sub(*r.LastNotified) < 5*time.Minute {
		next.Active = r.Active
		transition = ""
		if r.Active {
			next.State = "firing"
		} else {
			next.State = "pending"
		}
	}
	return next, transition
}
