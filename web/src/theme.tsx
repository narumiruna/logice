import { createContext, type ReactNode, useContext, useState } from "react"

export type Theme = "classic" | "studio"
export const themeStorageKey = "logice.theme"

export function isTheme(value: unknown): value is Theme {
  return value === "classic" || value === "studio"
}

export function readTheme(): Theme {
  try {
    const value = window.localStorage.getItem(themeStorageKey)
    return isTheme(value) ? value : "classic"
  } catch {
    // Storage can be unavailable in restricted browsers or server rendering.
    return "classic"
  }
}

export function initializeTheme(): Theme {
  const theme = readTheme()
  document.documentElement.dataset.theme = theme
  return theme
}

const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void } | null>(null)

export function ThemeProvider({
  initialTheme = "classic",
  children,
}: {
  initialTheme?: Theme
  children: ReactNode
}) {
  const [theme, setCurrentTheme] = useState(initialTheme)

  function setTheme(value: Theme) {
    document.documentElement.dataset.theme = value
    setCurrentTheme(value)
    try {
      window.localStorage.setItem(themeStorageKey, value)
    } catch {
      // Switching still works for this page when the preference cannot be saved.
    }
  }

  return <ThemeContext value={{ theme, setTheme }}>{children}</ThemeContext>
}

export function ThemeSelect({ label = "Theme" }: { label?: string }) {
  const context = useContext(ThemeContext)
  if (!context) throw new Error("ThemeSelect requires ThemeProvider")
  return (
    <label className="theme-select">
      <span>{label}</span>
      <select
        value={context.theme}
        onChange={(event) => {
          if (isTheme(event.target.value)) context.setTheme(event.target.value)
        }}
      >
        <option value="classic">Classic</option>
        <option value="studio">Studio</option>
      </select>
    </label>
  )
}
