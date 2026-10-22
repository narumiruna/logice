import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app"
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
      {window.location.pathname.replace(/\/$/, "") === "/preview" ? (
        <LivePreview />
      ) : window.location.pathname.replace(/\/$/, "") === "/live" ? (
        <LivePage />
      ) : (
        <App />
      )}
    </ThemeProvider>
  </StrictMode>,
)
