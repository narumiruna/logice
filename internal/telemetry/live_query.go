package telemetry

import (
	"fmt"
	"strings"
)

// These lists inventory the pinned exporter's stored columns. Materialized log
// columns are included even though their values derive from resource attributes.
var liveSpanColumns = []string{"Timestamp", "TraceId", "SpanId", "ParentSpanId", "TraceState", "SpanName", "SpanKind", "ServiceName", "ResourceAttributes", "ScopeName", "ScopeVersion", "SpanAttributes", "Duration", "StatusCode", "StatusMessage", "Events.Timestamp", "Events.Name", "Events.Attributes", "Links.TraceId", "Links.SpanId", "Links.TraceState", "Links.Attributes"}
var liveLogColumns = []string{"Timestamp", "TraceId", "SpanId", "TraceFlags", "SeverityText", "SeverityNumber", "ServiceName", "Body", "ResourceSchemaUrl", "ResourceAttributes", "ScopeSchemaUrl", "ScopeName", "ScopeVersion", "ScopeAttributes", "LogAttributes", "EventName", "__otel_materialized_k8s.cluster.name", "__otel_materialized_k8s.container.name", "__otel_materialized_k8s.deployment.name", "__otel_materialized_k8s.namespace.name", "__otel_materialized_k8s.node.name", "__otel_materialized_k8s.pod.name", "__otel_materialized_k8s.pod.uid", "__otel_materialized_deployment.environment.name"}

func liveMapSQL(column string) string {
	return "arraySort(x -> tuple(x.1,x.2), arrayZip(mapKeys(" + column + "),mapValues(" + column + ")))"
}

func livePayloadSQL(logs bool) string {
	columns := liveSpanColumns
	if logs {
		columns = liveLogColumns
	}
	parts := make([]string, len(columns))
	for i, c := range columns {
		q := "`" + c + "`"
		switch c {
		case "Timestamp":
			q = "toString(toUnixTimestamp64Nano(Timestamp))"
		case "Duration":
			q = "toString(Duration)"
		case "ResourceAttributes", "ScopeAttributes", "SpanAttributes", "LogAttributes":
			q = liveMapSQL(q)
		case "Events.Timestamp":
			q = "arrayMap(t -> toString(toUnixTimestamp64Nano(t)), `Events.Timestamp`)"
		case "Events.Attributes", "Links.Attributes":
			q = "arrayMap(m -> " + liveMapSQL("m") + ", " + q + ")"
		}
		parts[i] = q
	}
	return "toJSONString(tuple(" + strings.Join(parts, ",") + "))"
}

func liveMatch(f LiveFilter, logs bool) (string, []any) {
	clauses := []string{"1"}
	args := []any{}
	if f.Service != "" {
		clauses = append(clauses, "ServiceName = ?")
		args = append(args, f.Service)
	}
	if f.Search != "" {
		column := "SpanName"
		if logs {
			column = "Body"
		}
		clauses = append(clauses, "(positionCaseInsensitiveUTF8("+column+", ?) > 0 OR positionCaseInsensitiveUTF8(TraceId, ?) > 0 OR positionCaseInsensitiveUTF8(SpanId, ?) > 0)")
		args = append(args, f.Search, f.Search, f.Search)
	}
	if logs {
		threshold := f.MinSeverity
		if f.ErrorsOnly && threshold < 17 {
			threshold = 17
		}
		clauses = append(clauses, "SeverityNumber >= ?")
		args = append(args, threshold)
	} else if f.ErrorsOnly {
		clauses = append(clauses, "StatusCode = 'Error'")
	}
	return strings.Join(clauses, " AND "), args
}

func liveIdentitySQL(logs bool) string {
	if logs {
		return "concat('log:v1:', lower(hex(SHA256(payload))))"
	}
	return `if(match(TraceId, '^[0-9a-fA-F]{32}$') AND lower(TraceId) != repeat('0',32) AND match(SpanId, '^[0-9a-fA-F]{16}$') AND lower(SpanId) != repeat('0',16), concat('span:',ResourceAttributes['logice.project.id'],':',lower(TraceId),':',lower(SpanId)), concat('span-content:v1:',lower(hex(SHA256(payload)))))`
}

// Canonical content is grouped, not its digest. The aggregation evaluates all
// variants before filtering and limiting a valid span identity.
func liveGroupedSQL(f LiveFilter, logs bool) (string, []any) {
	table := "otel_traces"
	if logs {
		table = "otel_logs"
	}
	match, args := liveMatch(f, logs)
	args = append(args, f.project, f.From.UnixNano(), f.To.UnixNano())
	parent := "lower(ParentSpanId)"
	if logs {
		parent = "''"
	}
	base := `SELECT ` + livePayloadSQL(logs) + ` AS payload, ` + liveIdentitySQL(logs) + ` AS identity,
 lower(TraceId) AS trace, ` + parent + ` AS parent, toUnixTimestamp64Nano(Timestamp) AS ns, (` + match + `) AS matches
 FROM logice.` + table + ` WHERE ` + scope
	// Logs must remain grouped by complete content, even if an identity collides.
	group := "identity, if(startsWith(identity,'span-content:v1:'),payload,'')"
	if logs {
		group = "identity, payload"
	}
	query := `SELECT identity, minIf(payload,matches) AS representative, count() AS occurrences,
 uniqExact(payload)>1 AS conflict, uniqExact(parent)>1 AS parentConflict,
 maxIf(ns,matches) AS latest, min(trace) AS traceGroup
 FROM (` + base + `) GROUP BY ` + group + ` HAVING countIf(matches)>0`
	return query, args
}

func liveMatchingQuery(f LiveFilter, logs bool) (string, []any) {
	q, args := liveGroupedSQL(f, logs)
	// Check digest collisions across all grouped matching content before LIMIT.
	// Valid span identities have already combined all their stored variants.
	return "SELECT identity,representative,occurrences,conflict,parentConflict,latest FROM (SELECT *,count() OVER (PARTITION BY identity) AS identityVariants FROM (" + q + ")) WHERE throwIf(identityVariants > 1, 'live identity collision') = 0 ORDER BY latest DESC,identity ASC LIMIT 501", args
}

func liveHistogramQuery(f LiveFilter, logs bool) (string, []any) {
	match, args := liveMatch(f, logs)
	table, errorPredicate := "otel_traces", "StatusCode = 'Error'"
	if logs {
		table, errorPredicate = "otel_logs", "SeverityNumber >= 17"
	}
	// Boundaries are floor(i*width/60). This ceiling-based inverse assigns a
	// timestamp exactly on an uneven boundary to the following bucket.
	q := `SELECT toUInt8(intDiv((toInt128(toUnixTimestamp64Nano(Timestamp))-toInt128(?)+1)*60-1,toInt128(?))) AS bucket,
 count(), countIf(` + errorPredicate + `) FROM logice.` + table + ` WHERE (` + match + `) AND ` + scope + ` GROUP BY bucket ORDER BY bucket`
	return q, append([]any{f.From.UnixNano(), f.To.Sub(f.From).Nanoseconds()}, append(args, f.project, f.From.UnixNano(), f.To.UnixNano())...)
}

func liveContextQuery(f LiveFilter, traces []string, matching []LiveRecord) (string, []any) {
	// Context has no service/text/severity predicates. Parent references are
	// passed as trace/span pairs so a parent from another trace cannot win rank.
	pairs := []string{}
	ids := []string{}
	for _, r := range matching {
		ids = append(ids, r.ID)
		if parent, ok := liveMatchingParent(r); ok {
			pairs = append(pairs, strings.ToLower(r.TraceID)+":"+strings.ToLower(parent))
		}
	}
	base := `SELECT ` + livePayloadSQL(false) + ` AS payload, ` + liveIdentitySQL(false) + ` AS identity,
 lower(TraceId) AS trace, lower(ParentSpanId) AS parent, toUnixTimestamp64Nano(Timestamp) AS ns
 FROM logice.otel_traces WHERE ` + scope + ` AND lower(TraceId) IN (?)
 AND match(SpanId, '^[0-9a-fA-F]{16}$') AND lower(SpanId) != repeat('0',16)`
	grouped := `SELECT identity,min(payload) AS representative,count() AS occurrences,uniqExact(payload)>1 AS conflict,uniqExact(parent)>1 AS parentConflict,min(ns) AS earliest,min(trace) AS traceGroup
 FROM (` + base + `) GROUP BY identity HAVING identity NOT IN (?)`
	// Per-trace rank followed by trace priority is a nonrecursive round-robin
	// allocation. The extra row is a limit sentinel.
	query := `SELECT identity,representative,occurrences,conflict,parentConflict,earliest FROM (
 SELECT *,row_number() OVER (PARTITION BY traceGroup ORDER BY has(?, concat(traceGroup,':',splitByChar(':',identity)[4])) DESC,earliest ASC,identity ASC) AS rank
 FROM (` + grouped + `)) ORDER BY rank ASC,indexOf(?,traceGroup) ASC,identity ASC LIMIT ` + fmt.Sprint(LiveContextLimit+1)
	// Placeholders occur in SQL textual order: rank references precede base.
	return query, []any{pairs, f.project, f.From.UnixNano(), f.To.UnixNano(), traces, ids, traces}
}
