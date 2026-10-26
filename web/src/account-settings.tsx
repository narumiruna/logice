import { type FormEvent, useEffect, useState } from "react"
import { flushSync } from "react-dom"
import { useAccount } from "./auth"
import { LanguageSelect, useI18n } from "./i18n"
import { PasskeySettings } from "./passkey-settings"
import { AppShell } from "./shell"
import { ThemeSelect } from "./theme"
import "./projects.css"

export function AccountSettings() {
  const { t } = useI18n()
  const { user, busy, saveName, invite, logout } = useAccount()
  const [name, setName] = useState(user.name)
  const [saved, setSaved] = useState(false)
  const [invitationName, setInvitationName] = useState("")
  const [invitation, setInvitation] = useState<{ token: string; expiresAt: string } | null>(null)
  const [copyState, setCopyState] = useState("")
  useEffect(() => {
    const clear = () => flushSync(() => setInvitation(null))
    window.addEventListener("pagehide", clear)
    return () => window.removeEventListener("pagehide", clear)
  }, [])
  async function save(event: FormEvent) {
    event.preventDefault()
    setSaved(false)
    setSaved(await saveName(name.trim()))
  }
  async function createInvitation(event: FormEvent) {
    event.preventDefault()
    setInvitation(null)
    const result = await invite(invitationName.trim())
    if (result) setInvitation(result)
  }
  async function copyID() {
    try {
      await navigator.clipboard.writeText(user.id)
      setCopyState("Account UUID copied.")
    } catch {
      setCopyState("Copy failed. Select and copy the account UUID below.")
    }
  }
  return (
    <AppShell page="account">
      <main id="main" tabIndex={-1} className="workspace-page">
        <div className="page-heading">
          <div>
            <span className="eyebrow">{t("Your workspace")}</span>
            <h1>{t("Account settings")}</h1>
            <p>{t("Manage your profile, appearance, and account access.")}</p>
          </div>
        </div>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t("Account settings sections")}>
            <a href="#profile">{t("Profile")}</a>
            <a href="#appearance">{t("Appearance")}</a>
            <a href="#security">{t("Security")}</a>
            <a href="#passkeys">{t("Passkeys")}</a>
            {user.admin && <a href="#invitations">{t("Invitations")}</a>}
          </nav>
          <div className="settings-panels">
            <section className="settings-card" id="profile">
              <div className="settings-card-heading">
                <h2>{t("Profile")}</h2>
                <p>{t("Your display name appears in project member lists.")}</p>
              </div>
              <form onSubmit={(event) => void save(event)} className="settings-form">
                <label>
                  {t("Display name")}
                  <input
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value)
                      setSaved(false)
                    }}
                    maxLength={80}
                    required
                    disabled={busy}
                    autoComplete="nickname"
                  />
                </label>
                <button
                  type="submit"
                  className="button button-primary"
                  disabled={busy || !name.trim() || name.trim() === user.name}
                >
                  {t("Save changes")}
                </button>
                {saved && (
                  <p role="status" className="settings-success">
                    {t("Profile saved.")}
                  </p>
                )}
              </form>
              <div className="identity-field">
                <span>{t("Account UUID")}</span>
                <code>{user.id}</code>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => void copyID()}
                >
                  {t("Copy account UUID")}
                </button>
                {copyState && <p role="status">{t(copyState)}</p>}
              </div>
              <p className="settings-hint">
                {t(
                  "Share this UUID with a project Owner to request membership. Changing your name does not change your UUID or permissions.",
                )}
              </p>
            </section>
            <section className="settings-card" id="appearance">
              <div className="settings-card-heading">
                <h2>{t("Appearance")}</h2>
                <p>
                  {t(
                    "Your theme and language are stored in this browser. Telemetry filters stay unchanged.",
                  )}
                </p>
              </div>
              <div className="appearance-options">
                <span>
                  {t("Choose Classic for wider spacing, or Studio for a compact workspace.")}
                </span>
                <ThemeSelect label={t("Appearance theme")} />
                <LanguageSelect />
              </div>
            </section>
            <section className="settings-card" id="security">
              <div className="settings-card-heading">
                <h2>{t("Security and access")}</h2>
                <p>{t("Sign in with a passkey. No password is required.")}</p>
              </div>
              <dl className="settings-facts">
                <div>
                  <dt>{t("Account type")}</dt>
                  <dd>{user.admin ? t("Administrator") : t("Registered account")}</dd>
                </div>
                <div>
                  <dt>{t("Project permissions")}</dt>
                  <dd>{t("Set separately by each project Owner")}</dd>
                </div>
                <div>
                  <dt>{t("Session lifetime")}</dt>
                  <dd>{t("24 hours idle · 7 days maximum")}</dd>
                </div>
              </dl>
              <p className="settings-hint">
                {t(
                  "For a lost passkey, ask your operator to recover this account UUID. Recovery replaces your sign-in credentials; it does not revoke project ingestion tokens.",
                )}
              </p>
              <button
                className="button button-secondary"
                type="button"
                onClick={logout}
                disabled={busy}
              >
                {t("Sign out of this browser")}
              </button>
            </section>
            <PasskeySettings />
            {user.admin && (
              <section className="settings-card" id="invitations">
                <div className="settings-card-heading">
                  <h2>{t("Registration invitations")}</h2>
                  <p>
                    {t(
                      "Invite an account to Logice. Registration does not grant project membership.",
                    )}
                  </p>
                </div>
                <details>
                  <summary>{t("Create an invitation")}</summary>
                  <form
                    className="settings-form"
                    onSubmit={(event) => void createInvitation(event)}
                  >
                    <label htmlFor="invitation-name">{t("Invitation name")}</label>
                    <input
                      id="invitation-name"
                      value={invitationName}
                      onChange={(e) => setInvitationName(e.target.value)}
                      required
                      maxLength={80}
                      disabled={busy}
                    />
                    <button
                      type="submit"
                      className="button button-primary"
                      disabled={busy || !invitationName.trim()}
                    >
                      {t("Create invitation")}
                    </button>
                  </form>
                </details>
                {invitation && (
                  <div className="secret-card" role="status">
                    <p>
                      {t(
                        "Send this one-time invitation through a secure channel. Do not put it in a URL.",
                      )}
                    </p>
                    <label htmlFor="created-invitation">{t("Invitation token")}</label>
                    <input id="created-invitation" readOnly value={invitation.token} />
                    <p>{t("Expires: {date}", { date: invitation.expiresAt })}</p>
                    <button
                      className="button button-secondary"
                      type="button"
                      onClick={() => setInvitation(null)}
                    >
                      {t("Dismiss token")}
                    </button>
                  </div>
                )}
              </section>
            )}
          </div>
        </div>
      </main>
    </AppShell>
  )
}
