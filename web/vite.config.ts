import { defineConfig } from "vitest/config"

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/v1": "http://127.0.0.1:8080",
    },
  },
  preview: {
    host: "127.0.0.1",
    strictPort: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["e2e/**", "**/*.spec.*", "node_modules/**", "dist/**"],
  },
})
