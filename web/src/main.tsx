import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { AccountSettings } from "./account-settings"
import { App } from "./app"
import { SessionGate } from "./auth"
import { initializeLocale, LocaleProvider } from "./i18n"
import { LivePage } from "./live/page"
import { LivePreview } from "./preview/live-preview"
import { localProjectPath } from "./project-path"
import { ProjectGate } from "./projects"
import { initializeTheme, ThemeProvider } from "./theme"

const root = document.getElementById("root")
if (!root) {
  throw new Error("Application root element is missing")
}

const initialTheme = initializeTheme()
const initialLocale = initializeLocale()

createRoot(root).render(
  <StrictMode>
    <ThemeProvider initialTheme={initialTheme}>
      <LocaleProvider initialLocale={initialLocale}>
        <SessionGate>
          {window.location.pathname.replace(/\/$/, "") === "/account" ? (
            <AccountSettings />
          ) : localProjectPath(window.location.href).replace(/\/$/, "") === "/preview" ? (
            <LivePreview />
          ) : (
            <ProjectGate>
              {localProjectPath(window.location.href).replace(/\/$/, "") === "/live" ? (
                <LivePage />
              ) : (
                <App />
              )}
            </ProjectGate>
          )}
        </SessionGate>
      </LocaleProvider>
    </ThemeProvider>
  </StrictMode>,
)
