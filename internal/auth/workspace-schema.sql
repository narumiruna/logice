-- Additive workspace migration; keep the authentication v2 contract compatible.
CREATE TABLE IF NOT EXISTS workspace_schema_versions (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS project_views (
 id uuid PRIMARY KEY,
 project_id uuid NOT NULL REFERENCES projects(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 definition jsonb NOT NULL,
 revision bigint NOT NULL DEFAULT 1,
 creator_user_id uuid NOT NULL REFERENCES auth_users(id),
 updater_user_id uuid NOT NULL REFERENCES auth_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_views_project ON project_views(project_id,id);
CREATE INDEX IF NOT EXISTS project_events_page ON project_events(project_id,id DESC);
INSERT INTO workspace_schema_versions(version) VALUES(1) ON CONFLICT DO NOTHING;
