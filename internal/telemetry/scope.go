package telemetry

import (
	"context"
	"errors"
)

type projectKey struct{}

// WithProject carries a project authorized by the server, never by an SDK header.
func WithProject(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, projectKey{}, id)
}

func projectFrom(ctx context.Context) string {
	id, _ := ctx.Value(projectKey{}).(string)
	return id
}

var ErrScope = errors.New("authorized project scope required")
