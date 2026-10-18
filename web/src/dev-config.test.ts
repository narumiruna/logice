import { expect, test } from "vitest"
import config from "../vite.config"

test("development stays on loopback and proxies the API without path rewriting", () => {
  expect(config).toMatchObject({
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: { "/api": "http://127.0.0.1:8080" },
    },
    preview: { host: "127.0.0.1", strictPort: true },
  })
})

test("unit tests use Node.js and do not collect Playwright tests", () => {
  expect(config).toMatchObject({
    test: {
      environment: "node",
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      exclude: ["e2e/**", "**/*.spec.*", "node_modules/**", "dist/**"],
    },
  })
})
