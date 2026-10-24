-- Additive authentication schema. Applied under a transaction-level advisory lock.
CREATE TABLE IF NOT EXISTS auth_schema_versions (
 version integer PRIMARY KEY,
 applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_users (
 id uuid PRIMARY KEY,
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
 admin boolean NOT NULL DEFAULT false,
 active boolean NOT NULL DEFAULT false,
 generation bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_credentials (
 id bytea PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES auth_users(id),
 data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_credentials_user ON auth_credentials(user_id);
CREATE TABLE IF NOT EXISTS auth_invitations (
 token_hash bytea PRIMARY KEY,
 user_id uuid NOT NULL UNIQUE REFERENCES auth_users(id),
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_browsers (
 token_hash bytea PRIMARY KEY,
 generation bigint NOT NULL DEFAULT 0,
 touched_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_sessions (
 token_hash bytea PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES auth_users(id),
 browser_hash bytea,
 created_at timestamptz NOT NULL DEFAULT now(),
 last_seen timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
-- Keep migration retries safe if an earlier initializer created the sessions table.
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS browser_hash bytea;
CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);
CREATE TABLE IF NOT EXISTS auth_ceremonies (
 token_hash bytea PRIMARY KEY,
 kind text NOT NULL CHECK (kind IN ('enroll', 'login')),
 csrf_hash bytea NOT NULL,
 data bytea NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes'
);
CREATE TABLE IF NOT EXISTS auth_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 action text NOT NULL,
 user_id uuid NOT NULL REFERENCES auth_users(id),
 occurred_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO auth_schema_versions(version) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS projects (
 id uuid PRIMARY KEY,
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
 owner_user_id uuid NOT NULL REFERENCES auth_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner_user_id) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS project_members (
 project_id uuid NOT NULL REFERENCES projects(id),
 user_id uuid NOT NULL REFERENCES auth_users(id),
 role text NOT NULL CHECK (role IN ('Developer','Viewer')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,user_id)
);
CREATE INDEX IF NOT EXISTS project_members_user ON project_members(user_id);
CREATE TABLE IF NOT EXISTS project_tokens (
 id uuid PRIMARY KEY,
 project_id uuid NOT NULL REFERENCES projects(id),
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
 token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32),
 creator_user_id uuid NOT NULL REFERENCES auth_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz,
 revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS project_tokens_project ON project_tokens(project_id);
CREATE TABLE IF NOT EXISTS project_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 project_id uuid NOT NULL REFERENCES projects(id),
 actor_user_id uuid NOT NULL REFERENCES auth_users(id),
 action text NOT NULL,
 target text NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO auth_schema_versions(version) VALUES (2) ON CONFLICT DO NOTHING;
