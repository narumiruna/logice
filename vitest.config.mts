import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Feasibility fixtures install and run only in their temporary projects.
    exclude: [...configDefaults.exclude, "tests/fixtures/**"],
  },
})
