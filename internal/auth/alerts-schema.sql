-- Workspace migration 3: durable alert rules, leases, and delivery outbox.
CREATE TABLE IF NOT EXISTS alert_destinations (
 id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id),name text NOT NULL,
 encrypted_url bytea NOT NULL,revision bigint NOT NULL DEFAULT 1,disabled boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alert_destinations_project ON alert_destinations(project_id,id);
CREATE TABLE IF NOT EXISTS alert_rules (
 id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id),destination_id uuid NOT NULL REFERENCES alert_destinations(id),
 name text NOT NULL,kind text NOT NULL CHECK(kind IN ('error_ratio','root_p95','no_data')),
 service text NOT NULL DEFAULT '',threshold text NOT NULL,min_population integer NOT NULL,enabled boolean NOT NULL DEFAULT true,
 revision bigint NOT NULL DEFAULT 1,state text NOT NULL DEFAULT 'pending',bad integer NOT NULL DEFAULT 0,good integer NOT NULL DEFAULT 0,
 incident_active boolean NOT NULL DEFAULT false,last_notified timestamptz,created_at timestamptz NOT NULL DEFAULT now(),next_at timestamptz NOT NULL DEFAULT now(),lease_id uuid,lease_until timestamptz,last_window_to timestamptz
);
CREATE INDEX IF NOT EXISTS alert_rules_project ON alert_rules(project_id,id);
CREATE INDEX IF NOT EXISTS alert_rules_due ON alert_rules(next_at) WHERE enabled;
CREATE TABLE IF NOT EXISTS alert_incidents (
 id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id),rule_id uuid NOT NULL REFERENCES alert_rules(id),revision bigint NOT NULL,
 transition text NOT NULL,window_to timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(rule_id,revision,transition,window_to)
);
CREATE INDEX IF NOT EXISTS alert_incidents_project ON alert_incidents(project_id,created_at DESC,id);
CREATE TABLE IF NOT EXISTS alert_deliveries (
 id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id),destination_id uuid NOT NULL REFERENCES alert_destinations(id),rule_id uuid REFERENCES alert_rules(id),revision bigint,
 payload jsonb NOT NULL,state text NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0,next_at timestamptz NOT NULL DEFAULT now(),lease_id uuid,lease_until timestamptz,
 last_result text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(rule_id,revision,id)
);
CREATE INDEX IF NOT EXISTS alert_deliveries_due ON alert_deliveries(next_at) WHERE state='pending';
CREATE INDEX IF NOT EXISTS alert_deliveries_project ON alert_deliveries(project_id,created_at DESC,id);
INSERT INTO workspace_schema_versions(version) VALUES(3) ON CONFLICT DO NOTHING;
