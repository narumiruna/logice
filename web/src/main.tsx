import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app"
import { SessionGate } from "./auth"
import { LivePage } from "./live/page"
import { LivePreview } from "./preview/live-preview"
import { initializeTheme, ThemeProvider } from "./theme"

const root = document.getElementById("root")
if (!root) {
  throw new Error("Application root element is missing")
}

const initialTheme = initializeTheme()

createRoot(root).render(
  <StrictMode>
    <ThemeProvider initialTheme={initialTheme}>
      <SessionGate>
        {window.location.pathname.replace(/\/$/, "") === "/preview" ? (
          <LivePreview />
        ) : window.location.pathname.replace(/\/$/, "") === "/live" ? (
          <LivePage />
        ) : (
          <App />
        )}
      </SessionGate>
    </ThemeProvider>
  </StrictMode>,
)
