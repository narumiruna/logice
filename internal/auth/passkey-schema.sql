-- Workspace migration 2: self-service credential metadata and bound ceremonies.
ALTER TABLE auth_credentials ADD COLUMN IF NOT EXISTS management_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE auth_credentials ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT 'Passkey';
ALTER TABLE auth_credentials ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE auth_credentials ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS auth_credentials_management ON auth_credentials(management_id);
ALTER TABLE auth_ceremonies DROP CONSTRAINT IF EXISTS auth_ceremonies_kind_check;
ALTER TABLE auth_ceremonies ADD CONSTRAINT auth_ceremonies_kind_check CHECK(kind IN ('enroll','login','manage_assert','credential_add'));
INSERT INTO workspace_schema_versions(version) VALUES(2) ON CONFLICT DO NOTHING;
