import { useState } from "react"
import { canManageTokens, projectRequest } from "./project-api"
import { useProject } from "./project-context"
import { captureView, type ViewDefinition, viewHref } from "./view-definition"

export function SaveViewButton({ definition }: { definition?: ViewDefinition }) {
  const context = useProject()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  if (!context || !canManageTokens(context.project.role)) return null
  return (
    <div>
      <button
        type="button"
        className="button button-secondary"
        onClick={() => {
          setOpen(!open)
          setMessage("")
        }}
      >
        Save current view
      </button>
      {open && (
        <form
          className="settings-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (busy) return
            setBusy(true)
            setMessage("")
            void (async () => {
              try {
                const d = definition ?? captureView(location.href)
                viewHref(d, context.project.id)
                await projectRequest(`/${context.project.id}/views`, "POST", {
                  name: name.trim(),
                  definition: d,
                })
                setMessage("View saved.")
                setOpen(false)
              } catch (error) {
                setMessage(error instanceof Error ? error.message : "Cannot save view.")
              } finally {
                setBusy(false)
              }
            })()
          }}
        >
          <label>
            Saved view name
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
          </label>
          <button type="submit" className="button button-primary" disabled={busy || !name.trim()}>
            Save view
          </button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  )
}
