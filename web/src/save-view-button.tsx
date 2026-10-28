import { useState } from "react"
import { useI18n } from "./i18n"
import { canManageTokens, projectErrorMessage, projectRequest } from "./project-api"
import { useProject } from "./project-context"
import { captureView, type ViewDefinition, viewHref } from "./view-definition"

export function SaveViewButton({ definition }: { definition?: ViewDefinition }) {
  const { t } = useI18n()
  const context = useProject()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Error | string>("")
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
        {t("Save current view")}
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
                setMessage(error instanceof Error ? error : "Cannot save view.")
              } finally {
                setBusy(false)
              }
            })()
          }}
        >
          <label>
            {t("Saved view name")}
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
          </label>
          <button type="submit" className="button button-primary" disabled={busy || !name.trim()}>
            {t("Save view")}
          </button>
        </form>
      )}
      {message && <p role="status">{projectErrorMessage(message, t)}</p>}
    </div>
  )
}
