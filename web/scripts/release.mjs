import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export function releaseInfo(manifest, changelog) {
  const { name, version, private: isPrivate } = JSON.parse(manifest)
  if (
    name !== "logice-web" ||
    isPrivate !== true ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
    version === "0.0.0"
  ) {
    throw new Error(
      "Release requires the private logice-web package and a stable version after 0.0.0.",
    )
  }
  const sections = changelog.split(/^## /m).slice(1)
  const section = sections.find((value) => value.split("\n", 1)[0].trim() === version)
  const notes = section?.slice(section.indexOf("\n") + 1).trim()
  if (!notes)
    throw new Error(
      `Missing changelog entry for ${version}. Run the Changesets version command first.`,
    )
  return { version, tag: `v${version}`, notes }
}

// Read release notes from the tag, not from a later commit with the same version.
// This also permits recovery when the tag push passed but release creation failed.
export function createGitHubRelease(root, repo, tag, run = spawnSync) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) {
    throw new Error("GITHUB_REPOSITORY must identify the release repository.")
  }
  const command = (file, args) => run(file, args, { cwd: root, encoding: "utf8", timeout: 60_000 })
  const tagged = (path) => {
    const result = command("git", ["show", `${tag}:${path}`])
    if (result.status !== 0)
      throw new Error(`Cannot read ${path} from ${tag}. Fetch the release tag first.`)
    return result.stdout
  }
  const info = releaseInfo(tagged("web/package.json"), tagged("web/CHANGELOG.md"))
  if (info.tag !== tag) throw new Error("The tag does not match its package version.")
  const existing = command("gh", ["api", `repos/${repo}/releases/tags/${tag}`])
  if (existing.status === 0) return "exists"
  if (!/\(HTTP 404\)/.test(existing.stderr ?? "")) {
    throw new Error("Cannot check the GitHub release. Check token access and API availability.")
  }
  const directory = mkdtempSync(join(tmpdir(), "logice-release-"))
  try {
    const notes = join(directory, "notes.md")
    writeFileSync(notes, info.notes)
    const created = command("gh", [
      "release",
      "create",
      tag,
      "--repo",
      repo,
      "--verify-tag",
      "--title",
      tag,
      "--notes-file",
      notes,
    ])
    if (created.status !== 0)
      throw new Error(
        "GitHub release creation failed. Rerun the workflow after fixing access or API availability.",
      )
    return "created"
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export function main(mode, root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")) {
  const web = join(root, "web")
  const info = releaseInfo(
    readFileSync(join(web, "package.json"), "utf8"),
    readFileSync(join(web, "CHANGELOG.md"), "utf8"),
  )
  if (mode === "tag") {
    execFileSync(join(web, "node_modules/.bin/changeset"), ["git-tag"], {
      cwd: web,
      stdio: "inherit",
      timeout: 60_000,
    })
  } else if (mode === "github") {
    console.log(
      `GitHub release ${info.tag}: ${createGitHubRelease(root, process.env.GITHUB_REPOSITORY, info.tag)}`,
    )
  } else {
    throw new Error("Use tag or github.")
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2])
}
