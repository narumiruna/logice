import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { createGitHubRelease, releaseInfo } from "./release.mjs"

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const manifest = JSON.stringify({ name: "logice-web", version: "0.1.0", private: true })
const changelog =
  "# logice-web\n\n## 0.1.0\n\n### Minor Changes\n\n- Release support.\n\n## 0.0.0\n\nOld notes.\n"

test("release notes contain only the selected stable version", () => {
  assert.deepEqual(releaseInfo(manifest, changelog), {
    version: "0.1.0",
    tag: "v0.1.0",
    notes: "### Minor Changes\n\n- Release support.",
  })
})

test("invalid, public, initial, prerelease, and undocumented versions fail closed", () => {
  for (const value of [
    { name: "other", version: "0.1.0", private: true },
    { name: "logice-web", version: "0.1.0", private: false },
    { name: "logice-web", version: "0.0.0", private: true },
    { name: "logice-web", version: "1.0.0-beta.1", private: true },
    { name: "logice-web", version: "$(unsafe)", private: true },
  ])
    assert.throws(() => releaseInfo(JSON.stringify(value), changelog))
  assert.throws(() => releaseInfo(manifest, "# No release notes"))
  assert.throws(() => releaseInfo(manifest, "## 0.1.0\n\n"))
})

function releaseRunner({
  exists = false,
  lookupStatus = 404,
  createFails = false,
  missingTag = false,
  taggedManifest = manifest,
} = {}) {
  const calls = []
  let notesPath
  const run = (file, args) => {
    calls.push([file, args])
    if (file === "git") {
      if (missingTag) return { status: 128, stdout: "" }
      return { status: 0, stdout: args[1].endsWith("package.json") ? taggedManifest : changelog }
    }
    if (args[0] === "api")
      return exists
        ? { status: 0, stdout: "{}" }
        : { status: 1, stderr: `gh: lookup failed (HTTP ${lookupStatus})` }
    assert.deepEqual(args.slice(0, 8), [
      "release",
      "create",
      "v0.1.0",
      "--repo",
      "owner/logice",
      "--verify-tag",
      "--title",
      "v0.1.0",
    ])
    notesPath = args.at(-1)
    assert.equal(readFileSync(notesPath, "utf8"), "### Minor Changes\n\n- Release support.")
    return { status: createFails ? 1 : 0 }
  }
  return { run, calls, notesPath: () => notesPath }
}

test("release creation uses the existing tag and removes temporary notes", () => {
  const fixture = releaseRunner()
  assert.equal(createGitHubRelease("/unused", "owner/logice", "v0.1.0", fixture.run), "created")
  assert.equal(existsSync(fixture.notesPath()), false)
  assert.deepEqual(fixture.calls[0], ["git", ["show", "v0.1.0:web/package.json"]])
  assert.deepEqual(fixture.calls[1], ["git", ["show", "v0.1.0:web/CHANGELOG.md"]])
})

test("reruns skip an existing release without changing its notes or tag", () => {
  const fixture = releaseRunner({ exists: true })
  assert.equal(createGitHubRelease("/unused", "owner/logice", "v0.1.0", fixture.run), "exists")
  assert.equal(fixture.calls.length, 3)
})

test("API denial, missing tags, and tag/version mismatch cannot create a release", () => {
  for (const options of [
    { lookupStatus: 403 },
    { missingTag: true },
    { taggedManifest: JSON.stringify({ name: "logice-web", private: true, version: "0.2.0" }) },
  ]) {
    const fixture = releaseRunner(options)
    assert.throws(() => createGitHubRelease("/unused", "owner/logice", "v0.1.0", fixture.run))
    assert.equal(
      fixture.calls.some(([file, args]) => file === "gh" && args[0] === "release"),
      false,
    )
  }
  assert.throws(() => createGitHubRelease("/unused", undefined, "v0.1.0"))
})

test("a failed release can be retried after the tag was pushed", () => {
  const failed = releaseRunner({ createFails: true })
  assert.throws(() => createGitHubRelease("/unused", "owner/logice", "v0.1.0", failed.run))
  assert.equal(existsSync(failed.notesPath()), false)
  const retry = releaseRunner()
  assert.equal(createGitHubRelease("/unused", "owner/logice", "v0.1.0", retry.run), "created")
})

test("real Changesets versions the private package and tags only a disposable repository", {
  timeout: 30_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "logice-changesets-test-"))
  const dir = join(root, "web")
  const env = {
    ...process.env,
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key]
  }
  Object.assign(env, {
    GIT_AUTHOR_NAME: "Release test",
    GIT_AUTHOR_EMAIL: "release-test@example.invalid",
    GIT_COMMITTER_NAME: "Release test",
    GIT_COMMITTER_EMAIL: "release-test@example.invalid",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  })
  const run = (file, args, cwd = root) =>
    execFileSync(file, args, { cwd, env, encoding: "utf8", stdio: "pipe", timeout: 20_000 })
  try {
    mkdirSync(join(dir, ".changeset"), { recursive: true })
    mkdirSync(join(dir, "node_modules/.bin"), { recursive: true })
    const scripts = JSON.parse(readFileSync(join(web, "package.json"), "utf8")).scripts
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "logice-web",
        version: "0.0.0",
        private: true,
        scripts: { "version:release": scripts["version:release"] },
      }),
    )
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({
        name: "logice-web",
        version: "0.0.0",
        lockfileVersion: 3,
        packages: { "": { name: "logice-web", version: "0.0.0" } },
      }),
    )
    writeFileSync(
      join(dir, ".changeset/config.json"),
      readFileSync(join(web, ".changeset/config.json")),
    )
    writeFileSync(
      join(dir, ".changeset/release-workflow.md"),
      '---\n"logice-web": minor\n---\n\nRelease fixture.\n',
    )
    symlinkSync(
      join(web, "node_modules/@changesets/cli/bin.js"),
      join(dir, "node_modules/.bin/changeset"),
    )
    writeFileSync(join(root, ".gitignore"), "node_modules/\n")
    run("git", ["init", "--initial-branch=main"])
    run("git", ["add", "web", ".gitignore"])
    run("git", ["-c", "commit.gpgsign=false", "commit", "-m", "test: initial release fixture"])
    run("npm", ["run", "version:release"], dir)
    assert.equal(JSON.parse(readFileSync(join(dir, "package.json"))).version, "0.1.0")
    const lock = JSON.parse(readFileSync(join(dir, "package-lock.json")))
    assert.equal(lock.version, "0.1.0")
    assert.equal(lock.packages[""].version, "0.1.0")
    assert.equal(existsSync(join(dir, ".changeset/release-workflow.md")), false)
    assert.match(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), /## 0\.1\.0/)
    run("git", ["add", "web"])
    run("git", ["-c", "commit.gpgsign=false", "commit", "-m", "chore(release): version fixture"])
    const output = join(root, "events.ndjson")
    env.CHANGESETS_OUTPUT = output
    const entry = new URL("./release.mjs", import.meta.url).href
    run(process.execPath, [
      "--input-type=module",
      "-e",
      'const { main } = await import(process.argv[1]); main("tag", process.argv[2])',
      entry,
      root,
    ])
    assert.equal(run("git", ["tag", "--list"]).trim(), "v0.1.0")
    assert.equal(JSON.parse(readFileSync(output, "utf8").trim()).tag, "v0.1.0")
    run(process.execPath, [
      "--input-type=module",
      "-e",
      'const { main } = await import(process.argv[1]); main("tag", process.argv[2])',
      entry,
      root,
    ])
    assert.equal(run("git", ["tag", "--list"]).trim(), "v0.1.0")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
