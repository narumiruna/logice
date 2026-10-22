import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app"
import { LivePage } from "./live/page"
import { LivePreview } from "./preview/live-preview"

const root = document.getElementById("root")
if (!root) {
  throw new Error("Application root element is missing")
}

createRoot(root).render(
  <StrictMode>
    {window.location.pathname.replace(/\/$/, "") === "/preview" ? (
      <LivePreview />
    ) : window.location.pathname.replace(/\/$/, "") === "/live" ? (
      <LivePage />
    ) : (
      <App />
    )}
  </StrictMode>,
)
