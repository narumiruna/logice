-- +goose NO TRANSACTION
-- +goose Up
CREATE TABLE validation_partial_ddl (id UInt64) ENGINE = MergeTree ORDER BY id;
-- Deliberate runtime failure after successful DDL. ClickHouse cannot roll back
-- the preceding table creation, and Goose must not mark this version applied.
SELECT CAST('not-a-number' AS UInt64);

-- +goose Down
DROP TABLE validation_partial_ddl;
