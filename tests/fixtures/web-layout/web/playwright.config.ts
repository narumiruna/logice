import { defineConfig } from "@playwright/test"

// Collection only: no webServer, browser installation, or browser launch.
export default defineConfig({ testDir: "./e2e", reporter: "list" })
