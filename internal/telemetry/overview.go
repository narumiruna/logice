package telemetry

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"
)

var ErrOverviewBusy = errors.New("overview admission full")
var overviewSlots = make(chan struct{}, 2)

type OverviewReader interface {
	Overview(context.Context, Filter) (Overview, error)
}
type OverviewStats struct {
	Spans           string   `json:"spans"`
	Traces          string   `json:"traces"`
	Logs            string   `json:"logs"`
	ErrorTraces     string   `json:"errorTraces"`
	RootSpans       string   `json:"rootSpans"`
	P50NS           *string  `json:"p50Ns"`
	P95NS           *string  `json:"p95Ns"`
	ErrorProportion *float64 `json:"errorProportion"`
	Conflicts       string   `json:"conflicts"`
}
type OverviewBucket struct {
	From time.Time `json:"from"`
	To   time.Time `json:"to"`
	OverviewStats
}
type Overview struct {
	From      time.Time `json:"from"`
	To        time.Time `json:"to"`
	QueriedAt time.Time `json:"queriedAt"`
	OverviewStats
	Buckets []OverviewBucket `json:"buckets"`
}

func blankOverviewStats() OverviewStats {
	return OverviewStats{Spans: "0", Traces: "0", Logs: "0", ErrorTraces: "0", RootSpans: "0", Conflicts: "0"}
}
func overviewQuery(f Filter, logs bool) (string, []any) {
	grouped, args := liveGroupedSQL(LiveFilter{project: f.project, From: f.From, To: f.To, Service: f.Service}, logs)
	// Canonical matching payloads use the same full-content ordering as Live.
	projection := `SELECT identity,traceGroup,conflict,parentConflict,toInt64(JSONExtractString(representative,1)) AS ns,JSONExtractString(representative,4) AS parent,toUInt64OrZero(JSONExtractString(representative,13)) AS duration,JSONExtractString(representative,14) AS status FROM (` + grouped + `)`
	if logs {
		projection = `SELECT identity,traceGroup,conflict,parentConflict,toInt64(JSONExtractString(representative,1)) AS ns,'' AS parent,toUInt64(0) AS duration,'' AS status FROM (` + grouped + `)`
	}
	valid := `startsWith(identity,'span:')`
	root := valid + ` AND parent='' AND NOT conflict AND NOT parentConflict AND duration<=9223372036854775807`
	q := `SELECT grouping(bucket),toUInt8(bucket),toString(count()),toString(uniqExactIf(traceGroup,` + valid + `)),toString(uniqExactIf(traceGroup,` + valid + ` AND status='Error')),toString(countIf(` + root + `)),toString(quantileExactIf(0.5)(duration,` + root + `)),toString(quantileExactIf(0.95)(duration,` + root + `)),toString(countIf(conflict)) FROM (SELECT *,toUInt8(intDiv((toInt128(ns)-toInt128(?)+1)*60-1,toInt128(?))) AS bucket FROM (` + projection + `)) GROUP BY GROUPING SETS ((bucket),()) ORDER BY grouping(bucket),bucket`
	// Bucket parameters appear before the grouped query's placeholders.
	return q, append([]any{f.From.UnixNano(), f.To.Sub(f.From).Nanoseconds()}, args...)
}
func (s *Store) Overview(ctx context.Context, f Filter) (Overview, error) {
	f.project = projectFrom(ctx)
	if f.project == "" {
		return Overview{}, ErrScope
	}
	if err := f.Validate(); err != nil {
		return Overview{}, err
	}
	if f.Search != "" || f.ErrorsOnly || f.TraceID != "" || f.MinSeverity != 0 {
		return Overview{}, errors.New("overview supports time and service only")
	}
	select {
	case overviewSlots <- struct{}{}:
		defer func() { <-overviewSlots }()
	default:
		return Overview{}, ErrOverviewBusy
	}
	result := Overview{From: f.From, To: f.To, QueriedAt: time.Now().UTC(), OverviewStats: blankOverviewStats(), Buckets: make([]OverviewBucket, 60)}
	width := f.To.Sub(f.From).Nanoseconds()
	for i := range result.Buckets {
		result.Buckets[i] = OverviewBucket{From: f.From.Add(time.Duration(int64(i)*(width/60) + int64(i)*(width%60)/60)), To: f.From.Add(time.Duration(int64(i+1)*(width/60) + int64(i+1)*(width%60)/60)), OverviewStats: blankOverviewStats()}
	}
	ctx, cancel := queryContext(ctx)
	defer cancel()
	for _, logs := range []bool{false, true} {
		q, args := overviewQuery(f, logs)
		rows, err := s.db.QueryContext(liveDriverContext{ctx}, q, args...)
		if err != nil {
			return Overview{}, err
		}
		for rows.Next() {
			var total uint64
			var bucket uint8
			var records, traces, errors, roots, p50, p95, conflicts string
			if err = rows.Scan(&total, &bucket, &records, &traces, &errors, &roots, &p50, &p95, &conflicts); err != nil {
				rows.Close()
				return Overview{}, err
			}
			target := &result.OverviewStats
			if total == 0 {
				if bucket >= 60 {
					rows.Close()
					return Overview{}, fmt.Errorf("invalid overview bucket")
				}
				target = &result.Buckets[bucket].OverviewStats
			}
			if logs {
				target.Logs = records
			} else {
				target.Spans = records
				target.Traces = traces
				target.ErrorTraces = errors
				target.RootSpans = roots
				target.Conflicts = conflicts
				if roots != "0" {
					a, b := p50, p95
					target.P50NS = &a
					target.P95NS = &b
				}
				den, _ := strconv.ParseFloat(traces, 64)
				num, _ := strconv.ParseFloat(errors, 64)
				if den > 0 {
					ratio := num / den
					target.ErrorProportion = &ratio
				}
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return Overview{}, err
		}
	}
	if ctx.Err() != nil {
		return Overview{}, ctx.Err()
	}
	return result, nil
}
