const projectPattern =
  /^\/projects\/([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})(?=\/|$)/

export function projectId(
  href = typeof window === "undefined" ? "/" : window.location.href,
): string {
  return projectPattern.exec(new URL(href, "http://local").pathname)?.[1] ?? ""
}

export function projectPath(path: string, href?: string): string {
  const id = projectId(href)
  return id ? `/projects/${id}${path}` : path
}

export function projectApi(path: string): string {
  const id = projectId()
  if (!id) throw new Error("Select a project before reading telemetry.")
  return `/api/projects/${id}${path}`
}

export function localProjectPath(href: string): string {
  return new URL(href, "http://local").pathname.replace(projectPattern, "") || "/"
}
