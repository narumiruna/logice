-- +goose Up
CREATE TABLE validation_projects (
    id text PRIMARY KEY,
    display_name text NOT NULL
);

-- +goose Down
DROP TABLE validation_projects;
