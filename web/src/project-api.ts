export interface Project {
  id: string
  name: string
  ownerId: string
  role: "Owner" | "Developer" | "Viewer"
}
export interface Member {
  userId: string
  name: string
  role: Project["role"]
}
export interface Token {
  id: string
  name: string
  creatorId: string
  status: string
  expiresAt: string | null
}
export interface Page<T> {
  items: T[]
  hasMore: boolean
}

export function canManageTokens(role: Project["role"]): boolean {
  return role === "Owner" || role === "Developer"
}

export async function projectRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let csrf = ""
  if (method !== "GET") {
    const response = await fetch("/api/auth/csrf", {
      credentials: "same-origin",
      cache: "no-store",
      signal,
    })
    if (!response.ok) throw new Error("Cannot validate this request. Try again.")
    csrf = (await response.json()).csrfToken
  }
  const response = await fetch(`/api/projects${path}`, {
    method,
    signal,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(method === "GET" ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf }),
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  })
  if (response.status === 401) window.dispatchEvent(new Event("logice:session-expired"))
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? path === "" || path.startsWith("?")
          ? "Project API unavailable. Deploy matching API/web versions and apply the project migration."
          : "Project or resource is unavailable."
        : response.status === 403
          ? "Your project role does not permit this action."
          : `Project request failed (${response.status}).`,
    )
  return response.json() as Promise<T>
}
