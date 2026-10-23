import { writeFileSync } from "node:fs"
import { test } from "@playwright/test"
import { authenticator, credentials, enroll, expect } from "./auth-fixtures"

test("bootstrap administrator enrolls a verified resident passkey", async ({ page }) => {
  const token = process.env.LOGICE_E2E_INVITATION
  const file = process.env.LOGICE_E2E_AUTH_FILE
  if (
    !token ||
    !file ||
    !/^logice-web-check-[a-f0-9]{16}$/.test(process.env.LOGICE_E2E_PROJECT ?? "")
  ) {
    throw new Error("Run this suite through scripts/validate-compose-web.sh")
  }
  const device = await authenticator(page)
  await enroll(page, token)
  await expect(page.getByLabel("Account", { exact: true })).toContainText("Browser administrator")
  const saved = await credentials(device)
  expect(saved.credentials).toHaveLength(1)
  expect(saved.credentials[0].isResidentCredential).toBe(true)
  expect(saved.credentials[0].rpId).toBe("localhost")
  writeFileSync(
    file,
    JSON.stringify({ state: await page.context().storageState(), credentials: saved }),
    { mode: 0o600, flag: "wx" },
  )
})
