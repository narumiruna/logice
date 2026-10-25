# /// script
# requires-python = ">=3.11"
# dependencies = ["PyYAML==6.0.3"]
# ///
"""Test changenote in disposable repositories. Do not publish remote objects."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]
PIN = "66afe581b2f7b19f96188a1f217518c41aaaf77d"


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.cli = shutil.which("changenote")
        self.assertIsNotNone(self.cli, "Install the pinned changenote CLI first.")
        self.directory = tempfile.TemporaryDirectory(prefix="logice-changenote-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        self.env.update({
            "GIT_AUTHOR_NAME": "Release test",
            "GIT_AUTHOR_EMAIL": "release-test@example.invalid",
            "GIT_COMMITTER_NAME": "Release test",
            "GIT_COMMITTER_EMAIL": "release-test@example.invalid",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_TERMINAL_PROMPT": "0",
            "npm_config_offline": "true",
            "npm_config_audit": "false",
            "npm_config_fund": "false",
        })
        self.write(".changenote/config.json", (ROOT / ".changenote/config.json").read_text())
        self.write("VERSION", "0.0.0\n")
        self.write("CHANGELOG.md", "# Logice\n\nPreserve this introduction.\n")
        self.write("web/package.json", json.dumps({
            "name": "logice-web", "version": "0.0.0", "private": True, "description": "Preserve this field."
        }, indent=2) + "\n")
        self.write("web/package-lock.json", json.dumps({
            "name": "logice-web", "version": "0.0.0", "lockfileVersion": 3,
            "packages": {"": {"name": "logice-web", "version": "0.0.0"}},
        }) + "\n")
        self.write(".changenote/feature.md", "---\nlogice: minor\n---\n\nAdd the release fixture.\n")
        self.run_command("git", "init", "--initial-branch=main")
        self.commit("test: initial fixture")
        self.assertEqual(self.run_command(self.cli, "--version").stdout.strip(), "changenote 0.7.0")

    def write(self, path, content):
        destination = self.root / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content)

    def run_command(self, *args, succeeds=True):
        result = subprocess.run(args, cwd=self.root, env=self.env, capture_output=True, text=True, timeout=30)
        if succeeds:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
        return result

    def commit(self, message):
        self.run_command("git", "add", "--", ".changenote", "VERSION", "CHANGELOG.md", "web")
        self.run_command("git", "-c", "commit.gpgsign=false", "commit", "-m", message)

    def snapshot(self):
        return {str(path.relative_to(self.root)): path.read_bytes()
                for path in self.root.rglob("*")
                if path.is_file() and ".git" not in path.relative_to(self.root).parts}

    def version(self):
        plan = json.loads(self.run_command(self.cli, "status").stdout)
        applied = json.loads(self.run_command(self.cli, "version").stdout)
        self.assertEqual(plan, applied)
        return plan

    def test_primary_additional_version_lockfile_notes_and_noop(self):
        before = self.snapshot()
        plan = json.loads(self.run_command(self.cli, "status").stdout)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(plan[0]["version"], "0.1.0")
        self.assertEqual(plan[0]["tag"], "v0.1.0")
        self.version()
        self.assertEqual((self.root / "VERSION").read_text(), "0.1.0\n")
        manifest = json.loads((self.root / "web/package.json").read_text())
        self.assertTrue(manifest["private"])
        self.assertEqual(manifest["version"], "0.1.0")
        self.assertEqual(manifest["description"], "Preserve this field.")
        lock = json.loads((self.root / "web/package-lock.json").read_text())
        self.assertEqual(lock["version"], "0.1.0")
        self.assertEqual(lock["packages"][""]["version"], "0.1.0")
        self.assertFalse((self.root / ".changenote/feature.md").exists())
        changelog = (self.root / "CHANGELOG.md").read_text()
        self.assertIn("Preserve this introduction.", changelog)
        self.assertIn("0.1.0", changelog)
        self.assertIn("Add the release fixture.", changelog)
        batch = json.loads((self.root / ".changenote/releases.json").read_text())
        self.assertEqual(batch, [{key: value for key, value in plan[0].items() if key != "notes"}])
        after = self.snapshot()
        self.assertEqual(self.version(), [])
        self.assertEqual(self.snapshot(), after)

    def test_real_frontend_manifest_and_lockfile_keep_dependency_resolutions(self):
        manifest = json.loads((ROOT / "web/package.json").read_text())
        lock = json.loads((ROOT / "web/package-lock.json").read_text())
        manifest["version"] = "0.0.0"
        lock["version"] = "0.0.0"
        lock["packages"][""]["version"] = "0.0.0"
        dependencies = {name: data for name, data in lock["packages"].items() if name}
        self.write("web/package.json", json.dumps(manifest, indent=2) + "\n")
        self.write("web/package-lock.json", json.dumps(lock, indent=2) + "\n")
        self.version()
        released_manifest = json.loads((self.root / "web/package.json").read_text())
        released_lock = json.loads((self.root / "web/package-lock.json").read_text())
        manifest["version"] = "0.1.0"
        self.assertEqual(released_manifest, manifest)
        self.assertEqual(released_lock["version"], "0.1.0")
        self.assertEqual(released_lock["packages"][""]["version"], "0.1.0")
        self.assertEqual({name: data for name, data in released_lock["packages"].items() if name}, dependencies)

    def test_failed_npm_sync_rolls_back_all_release_files(self):
        self.write("bin/npm", "#!/bin/sh\nprintf 'release-test-npm-failure\\n' >&2\nexit 42\n")
        (self.root / "bin/npm").chmod(0o755)
        self.env["PATH"] = str(self.root / "bin") + os.pathsep + self.env["PATH"]
        before = self.snapshot()
        self.run_command(self.cli, "version", succeeds=False)
        self.assertEqual(self.snapshot(), before)

    def test_version_mismatch_and_unknown_notes_fail_without_writes(self):
        for version in ("0.2.0", "not-semver", "0.1.0-beta.1"):
            self.write("VERSION", version + "\n")
            before = self.snapshot()
            self.run_command(self.cli, "version", succeeds=False)
            self.assertEqual(self.snapshot(), before)
        self.write("VERSION", "0.0.0\n")
        self.write(".changenote/feature.md", "---\nunknown: patch\n---\n\nInvalid package.\n")
        before = self.snapshot()
        self.run_command(self.cli, "version", succeeds=False)
        self.assertEqual(self.snapshot(), before)

    def test_additional_version_symlink_is_rejected(self):
        target = self.root / "web/package.json"
        target.rename(self.root / "original.json")
        target.symlink_to(self.root / "original.json")
        before = self.snapshot()
        self.run_command(self.cli, "version", succeeds=False)
        self.assertEqual(self.snapshot(), before)

    def test_local_tag_requires_committed_clean_release_and_is_repeatable(self):
        self.version()
        self.run_command(self.cli, "tag", succeeds=False)
        self.assertEqual(self.run_command("git", "tag", "--list").stdout.strip(), "")
        self.commit("chore(release): version fixture")
        self.run_command(self.cli, "tag")
        self.run_command(self.cli, "tag")
        self.assertEqual(self.run_command("git", "tag", "--list").stdout.strip(), "v0.1.0")
        self.assertEqual(self.run_command("git", "cat-file", "-t", "v0.1.0").stdout.strip(), "tag")
        self.assertEqual(self.run_command("git", "rev-parse", "v0.1.0^{commit}").stdout,
                         self.run_command("git", "rev-parse", "HEAD").stdout)
        self.assertEqual(self.run_command("git", "remote").stdout.strip(), "")

    def test_release_reconstruction_matches_committed_tree(self):
        parent = self.run_command("git", "rev-parse", "HEAD").stdout.strip()
        self.version()
        self.commit("chore(release): version fixture")
        release = self.run_command("git", "rev-parse", "HEAD").stdout.strip()
        tree = self.run_command("git", "rev-parse", "HEAD^{tree}").stdout
        self.run_command("git", "checkout", "--detach", parent)
        self.version()
        self.run_command("git", "add", "--", ".changenote", "VERSION", "CHANGELOG.md", "web")
        self.assertEqual(self.run_command("git", "write-tree").stdout, tree)
        self.run_command("git", "reset", "--hard", release)
        self.write(".changenote/later.md", "---\nlogice: patch\n---\n\nLater note.\n")
        self.commit("test: later unrelated commit")
        self.assertEqual(self.run_command("git", "log", "--first-parent", "-1", "--format=%H", "--", ".changenote/releases.json").stdout.strip(), release)
        notes = self.run_command(self.cli, "release-notes", "--package", "logice", "--version", "0.1.0").stdout
        self.assertIn("Add the release fixture.", notes)
        self.assertNotIn("Later note.", notes)


    def publication_race(self, newer_batch):
        source = Path(os.environ["CHANGENOTE_ACTION_PATH"])
        self.assertEqual(self.run_command("git", "-C", str(source), "rev-parse", "HEAD").stdout.strip(), PIN)
        self.version()
        self.commit("chore(release): validated batch")
        validated = self.run_command("git", "rev-parse", "HEAD").stdout.strip()
        with tempfile.TemporaryDirectory(prefix="logice-publication-race-") as directory:
            side = Path(directory)
            remote = side / "remote.git"
            self.run_command("git", "init", "--bare", "--initial-branch=main", str(remote))
            self.run_command("git", "remote", "add", "origin", str(remote))
            self.run_command("git", "push", "origin", "main")
            self.write(".changenote/later.md", "---\nlogice: patch\n---\n\nLater change.\n")
            self.commit("test: main advances after validation")
            if newer_batch:
                self.version()
                self.commit("chore(release): unvalidated newer batch")
            newer = self.run_command("git", "rev-parse", "HEAD").stdout.strip()
            self.run_command("git", "push", "origin", "main")
            self.run_command("git", "checkout", "--detach", validated)
            before = self.snapshot()
            (side / "repo.json").write_text(json.dumps({"clone_url": str(remote), "default_branch": "main"}))
            mock = side / "bin/gh"
            mock.parent.mkdir()
            mock.write_text('''#!/bin/sh
printf '%s\\n' "$*" >> "$FIXTURE_CALLS"
case "$*" in
  'api repos/fixture/logice') cat "$FIXTURE_REPO" ;;
  'api --paginate --slurp repos/fixture/logice/releases?per_page=100') printf '[[]]\\n' ;;
  'release create v0.1.0 --repo fixture/logice --verify-tag --title v0.1.0 --notes-file '*)
    printf '%s\\n' "$*" >> "$FIXTURE_WRITES"
    for arg do last=$arg; done
    cat "$last" > "$FIXTURE_NOTES" ;;
  *) printf 'Unexpected mock GitHub command: %s\\n' "$*" >&2; exit 64 ;;
esac
''')
            mock.chmod(0o755)
            self.env.update({
                "PATH": str(mock.parent) + os.pathsep + str(Path(self.cli).parent) + os.pathsep + self.env["PATH"],
                "GH_TOKEN": "fixture-only-token",
                "GITHUB_REPOSITORY": "fixture/logice",
                "GITHUB_OUTPUT": str(side / "output"),
                "INPUT_BASE_BRANCH": "main",
                "FIXTURE_CALLS": str(side / "calls"),
                "FIXTURE_REPO": str(side / "repo.json"),
                "FIXTURE_WRITES": str(side / "writes"),
                "FIXTURE_NOTES": str(side / "notes"),
            })
            result = self.run_command("bash", str(source / "scripts/action/publish.sh"), validated, succeeds=not newer_batch)
            self.assertEqual(self.snapshot(), before)
            self.assertEqual(self.run_command("git", "rev-parse", "HEAD").stdout.strip(), validated)
            self.assertEqual(self.run_command("git", "--git-dir", str(remote), "rev-parse", "refs/heads/main").stdout.strip(), newer)
            if newer_batch:
                self.assertIn("Release batch changed after preview; use an explicit retry.", result.stderr)
                self.assertFalse((side / "writes").exists())
                self.assertEqual((side / "calls").read_text().splitlines(), ["api repos/fixture/logice"])
                self.assertEqual(self.run_command("git", "--git-dir", str(remote), "tag", "--list").stdout.strip(), "")
            else:
                self.assertIn("release create v0.1.0", (side / "writes").read_text())
                self.assertEqual(self.run_command("git", "--git-dir", str(remote), "rev-parse", "v0.1.0^{commit}").stdout.strip(), validated)
                self.assertIn("Add the release fixture.", (side / "notes").read_text())
                self.assertNotIn("Later change.", (side / "notes").read_text())

    @unittest.skipUnless(sys.platform.startswith("linux"), "changenote Actions require Linux; CI runs this test.")
    def test_new_release_batch_after_validation_cannot_write_remote_objects(self):
        self.publication_race(newer_batch=True)

    @unittest.skipUnless(sys.platform.startswith("linux"), "changenote Actions require Linux; CI runs this test.")
    def test_unrelated_main_advance_keeps_the_validated_release_target(self):
        self.publication_race(newer_batch=False)


class DockerWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="logice-docker-tags-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "repo"
        self.root.mkdir()
        self.env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        self.env.update({
            "GIT_AUTHOR_NAME": "Docker test", "GIT_AUTHOR_EMAIL": "docker-test@example.invalid",
            "GIT_COMMITTER_NAME": "Docker test", "GIT_COMMITTER_EMAIL": "docker-test@example.invalid",
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0",
        })
        self.git("init", "--initial-branch=main")
        (self.root / "VERSION").write_text("1.2.3\n")
        self.git("add", "VERSION")
        self.git("-c", "commit.gpgsign=false", "commit", "-m", "test: Docker source")
        self.revision = self.git("rev-parse", "HEAD").strip()
        self.workflow = yaml.load((ROOT / ".github/workflows/docker.yml").read_text(), Loader=yaml.BaseLoader)
        self.image = next(step for step in self.workflow["jobs"]["publish"]["steps"] if step.get("id") == "image")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, env=self.env, text=True, stderr=subprocess.PIPE, timeout=15)

    def metadata(self, ref, tag="", called=False, expected="", component="api", succeeds=True):
        with tempfile.NamedTemporaryFile(dir=self.directory.name) as output:
            env = dict(self.env, REPOSITORY="NarumiRuna/Logice", COMPONENT=component, REF=ref,
                       VERSION_TAG=tag, CALLED=str(called).lower(), EXPECTED_REVISION=expected,
                       GITHUB_OUTPUT=output.name, GITHUB_SHA="not-the-checked-out-commit")
            result = subprocess.run(["bash", "-c", self.image["run"]], cwd=self.root, env=env,
                                    capture_output=True, text=True, timeout=15)
            text = Path(output.name).read_text()
        if not succeeds:
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(text, "")
            return []
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"revision={self.revision}\n", text)
        return text.split("tags<<IMAGE_TAGS\n", 1)[1].split("\nIMAGE_TAGS", 1)[0].splitlines()

    def test_main_latest_and_manual_branch_behavior(self):
        for component in ("api", "web"):
            name = f"ghcr.io/narumiruna/logice-{component}"
            self.assertEqual(self.metadata("refs/heads/main", component=component),
                             [f"{name}:{self.revision}", f"{name}:latest"])
            self.assertEqual(self.metadata("refs/heads/topic", component=component), [f"{name}:{self.revision}"])

    def test_annotated_release_tag_uses_commit_not_tag_object(self):
        self.git("-c", "tag.gpgSign=false", "tag", "-a", "v1.2.3", "-m", "Fixture tag")
        self.assertNotEqual(self.git("rev-parse", "v1.2.3").strip(), self.revision)
        self.git("checkout", "--detach", "v1.2.3")
        self.assertEqual(self.metadata("refs/tags/v1.2.3", "v1.2.3"),
                         [f"ghcr.io/narumiruna/logice-api:{self.revision}", "ghcr.io/narumiruna/logice-api:v1.2.3"])

    def test_reusable_release_never_updates_latest(self):
        self.assertEqual(self.metadata("refs/heads/main", "v1.2.3", called=True, expected=self.revision),
                         [f"ghcr.io/narumiruna/logice-api:{self.revision}", "ghcr.io/narumiruna/logice-api:v1.2.3"])

    def test_invalid_tags_and_unpinned_calls_fail_before_outputs(self):
        for tag in ("latest", "v01.2.3", "v1.2", "v1.2.3-beta.1", "v1.2.3/other", "v1.2.3\nlatest", "v1.2.3; echo unsafe", "v" + "9" * 130 + ".0.0"):
            self.metadata("refs/tags/invalid", tag, succeeds=False)
        for expected, tag in (("", "v1.2.3"), ("main", "v1.2.3"), ("f" * 40, "v1.2.3"), (self.revision, "")):
            self.metadata("refs/heads/main", tag, called=True, expected=expected, succeeds=False)

    def test_docker_triggers_inputs_permissions_and_build_metadata(self):
        events = self.workflow["on"]
        self.assertEqual(events["push"], {"branches": ["main"], "tags": ["v*"]})
        self.assertIn("workflow_dispatch", events)
        self.assertEqual(set(events["workflow_call"]["inputs"]), {"revision", "version-tag"})
        for spec in events["workflow_call"]["inputs"].values():
            self.assertEqual(spec["type"], "string")
            self.assertEqual(spec["required"], "true")
        job = self.workflow["jobs"]["publish"]
        self.assertEqual(job["permissions"], {"contents": "read", "packages": "write"})
        self.assertEqual(job["strategy"]["matrix"]["component"], ["api", "web"])
        self.assertEqual(job["steps"][0]["with"]["ref"], "${{ inputs.revision || github.sha }}")
        self.assertEqual(self.image["env"]["CALLED"], '${{ contains(toJSON(inputs), \'"revision"\') }}')
        self.assertIn("inputs.version-tag", self.image["env"]["VERSION_TAG"])
        build = next(step for step in job["steps"] if step.get("id") == "build")["with"]
        self.assertEqual(build["tags"], "${{ steps.image.outputs.tags }}")
        self.assertIn("steps.image.outputs.revision", build["labels"])
        self.assertEqual(build["platforms"], "linux/amd64,linux/arm64")

    def test_release_tag_metadata_is_bound_to_the_published_commit(self):
        workflow = yaml.load((ROOT / ".github/workflows/release.yml").read_text(), Loader=yaml.BaseLoader)
        publish = workflow["jobs"]["publish"]
        self.assertEqual(publish["outputs"], {
            "release-commit": "${{ steps.publish.outputs.release-commit }}",
            "published": "${{ steps.publish.outputs.published }}",
            "image-tag": "${{ steps.image.outputs.tag }}",
        })
        step = next(step for step in publish["steps"] if step.get("id") == "image")
        with tempfile.NamedTemporaryFile(dir=self.directory.name) as output:
            env = dict(self.env, RELEASE_COMMIT=self.revision, GITHUB_OUTPUT=output.name)
            subprocess.run(["bash", "-e", "-c", step["run"]], cwd=self.root, env=env, check=True, timeout=15)
            self.assertEqual(Path(output.name).read_text(), "tag=v1.2.3\n")
            Path(output.name).write_text("")
            env["RELEASE_COMMIT"] = "f" * 40
            failed = subprocess.run(["bash", "-e", "-c", step["run"]], cwd=self.root, env=env, timeout=15)
            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual(Path(output.name).read_text(), "")


class RepositoryContractTests(unittest.TestCase):
    def test_repository_versions_and_removed_changesets(self):
        version = (ROOT / "VERSION").read_text().strip()
        manifest = json.loads((ROOT / "web/package.json").read_text())
        lock = json.loads((ROOT / "web/package-lock.json").read_text())
        self.assertEqual(manifest["version"], version)
        self.assertEqual(lock["version"], version)
        self.assertEqual(lock["packages"][""]["version"], version)
        self.assertTrue(manifest["private"])
        self.assertNotIn("@changesets/cli", manifest["devDependencies"])
        self.assertNotIn("changeset", manifest["scripts"])
        for path in ("package.json", "package-lock.json", "web/.changeset", "web/scripts/release.mjs"):
            self.assertFalse((ROOT / path).exists(), path)

    def test_workflow_pins_permissions_modes_and_cache_preparation(self):
        workflow = yaml.load((ROOT / ".github/workflows/release.yml").read_text(), Loader=yaml.BaseLoader)
        self.assertEqual(workflow["permissions"], {"contents": "read"})
        self.assertEqual(workflow["on"]["push"]["branches"], ["main"])
        self.assertEqual(workflow["on"]["workflow_dispatch"]["inputs"]["operation"]["default"], "manage-pr")
        self.assertEqual(workflow["concurrency"]["cancel-in-progress"], "false")
        jobs = workflow["jobs"]
        self.assertEqual(jobs["publish"]["permissions"], {"contents": "write"})
        self.assertEqual(jobs["release"]["permissions"], {"contents": "write", "pull-requests": "write"})
        self.assertIn("retry-publication", jobs["publish"]["if"])
        self.assertIn("needs.validate.result == 'success'", jobs["publish"]["if"])
        self.assertIn("!cancelled()", jobs["publish"]["if"])
        self.assertEqual(jobs["validate"]["steps"][0]["with"]["ref"], "${{ github.sha }}")
        self.assertEqual(jobs["release"]["steps"][0]["with"]["ref"], "${{ github.sha }}")
        selected = "${{ needs.validate.outputs.publication-commit }}"
        self.assertEqual(jobs["publish"]["steps"][0]["with"]["ref"], selected)
        self.assertIn("needs.validate.outputs.publication-commit != ''", jobs["publish"]["if"])
        preview = next(step for step in jobs["validate"]["steps"] if step.get("id") == "preview")
        self.assertEqual(preview["uses"], f"narumiruna/changenote/preview@{PIN}")
        self.assertEqual(jobs["validate"]["outputs"]["publication-commit"], "${{ steps.preview.outputs.release-commit }}")
        validate_source = next(step for step in jobs["validate"]["steps"] if step.get("working-directory") == "publication-source")
        self.assertEqual(validate_source["env"]["EXPECTED_RELEASE_COMMIT"], "${{ steps.preview.outputs.release-commit }}")
        for command in ('git rev-parse HEAD', 'sh scripts/check-go.sh', 'npm --prefix web run ci', 'uv run tests/release/check.py'):
            self.assertIn(command, validate_source["run"])
        publish = next(step for step in jobs["publish"]["steps"] if step.get("id") == "publish")
        self.assertEqual(publish["env"]["EXPECTED_RELEASE_COMMIT"], selected)
        self.assertEqual(publish["run"], 'bash "$CHANGENOTE_SOURCE/scripts/action/publish.sh" "$EXPECTED_RELEASE_COMMIT"')
        self.assertEqual(jobs["release"]["steps"][-1]["uses"], f"narumiruna/changenote@{PIN}")
        for name, job in jobs.items():
            self.assertIn("github.ref == 'refs/heads/main'", job["if"])
            if name == "docker":
                self.assertEqual(job["uses"], "./.github/workflows/docker.yml")
                self.assertEqual(job["permissions"], {"contents": "read", "packages": "write", "actions": "read"})
                self.assertEqual(job["with"], {
                    "revision": "${{ needs.publish.outputs.release-commit }}",
                    "version-tag": "${{ needs.publish.outputs.image-tag }}",
                })
                self.assertIn("needs.publish.result == 'success'", job["if"])
                self.assertIn("needs.publish.outputs.published == 'true'", job["if"])
                self.assertIn("inputs.operation == 'retry-publication'", job["if"])
                self.assertIn("needs.publish.outputs.release-commit != ''", job["if"])
                continue
            self.assertLessEqual(int(job["timeout-minutes"]), 15)
            checkout = job["steps"][0]
            self.assertEqual(checkout["with"]["persist-credentials"], "false")
            if name in ("release", "publish"):
                self.assertTrue(any("npm --prefix web ci --ignore-scripts" in step.get("run", "") for step in job["steps"]))
        setup = (ROOT / ".github/actions/setup-changenote/action.yml").read_text()
        self.assertIn('git -C "$source_dir" checkout --detach FETCH_HEAD', setup)
        self.assertIn(f'test "$(git -C "$source_dir" rev-parse HEAD)" = {PIN}', setup)
        self.assertIn('cargo install --path "$CHANGENOTE_SOURCE" --locked', setup)
        self.assertIn("changenote 0.7.0", setup)
        config = json.loads((ROOT / ".changenote/config.json").read_text())
        self.assertIn(PIN, config["$schema"])
        self.assertEqual(config["packages"]["logice"], {
            "path": ".", "version_file": "VERSION", "version_outputs": ["web/package.json"], "tag_prefix": "v",
        })


if __name__ == "__main__":
    unittest.main(verbosity=2)
