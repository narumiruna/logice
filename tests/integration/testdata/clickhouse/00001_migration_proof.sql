-- +goose NO TRANSACTION
-- +goose Up
CREATE TABLE validation_migration_proof (
    id UInt64,
    value String
) ENGINE = MergeTree ORDER BY id;

-- +goose Down
DROP TABLE validation_migration_proof;
