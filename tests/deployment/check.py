# /// script
# requires-python = ">=3.11"
# dependencies = ["PyYAML==6.0.3"]
# ///
"""Deployment and CI guards with disposable fixtures. No remote writes."""

import copy
from fnmatch import fnmatchcase
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import yaml

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("deployment", ROOT / "scripts/deployment.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
ci_spec = importlib.util.spec_from_file_location("ci_docs_only", ROOT / "scripts/ci-docs-only.py")
ci_docs_only = importlib.util.module_from_spec(ci_spec)
ci_spec.loader.exec_module(ci_docs_only)


def fixture():
    return {"schema": 1, "revision": "a" * 40, "version": "1.2.3",
            "images": {name: f"ghcr.io/narumiruna/logice-{name}@sha256:" + char * 64
                       for name, char in (("api", "b"), ("web", "c"))},
            "run": {"id": 123, "attempt": 1}}


class GitHubFixture:
    def __init__(self):
        self.value = fixture()
        self.run = {"id": 123, "workflow_id": 7, "path": ".github/workflows/release.yml",
                    "head_repository": {"full_name": deploy.REPOSITORY}, "head_branch": "main",
                    "event": "push", "status": "completed", "conclusion": "success", "run_attempt": 1}
        self.artifacts = [{"id": 5, "name": "logice-deployment-1", "expired": False}]
        self.refs = []
        self.pulls = []
        self.writes = []
        self.dispatches = []
        self.base = "d" * 40
        self.head = "e" * 40
        self.files = {}
        self.downloads = 0
        self.dispatch_failure = False
        self.unrelated = False

    def api(self, path, data=None):
        if data is not None:
            self.writes.append((path, data))
            if path == "git/trees":
                self.files = {item["path"]: json.loads(item["content"]) for item in data["tree"]}
                return {"sha": "f" * 40}
            if path == "git/commits":
                return {"sha": self.head}
            if path == "git/refs":
                self.refs.append({"ref": data["ref"], "object": {"sha": data["sha"]}})
                return {}
            if path == "pulls":
                self.pulls.append({"state": "open", "html_url": "https://example.invalid/pull/1"})
                return self.pulls[0]
            raise AssertionError(path)
        if path == "actions/runs/123":
            return self.run
        if path == "actions/workflows/release.yml":
            return {"id": 7}
        if path.startswith("git/matching-refs/heads/"):
            return self.refs
        if path == "git/ref/heads/main":
            return {"object": {"sha": self.base}}
        if path.startswith("git/ref/heads/narumi/chore/"):
            return {"object": {"sha": self.head}}
        if path.startswith("compare/"):
            files = list(self.files) + (["unrelated.go"] if self.unrelated else [])
            return {"total_commits": 1, "files": [{"filename": path} for path in files]}
        if path == f"git/commits/{self.base}":
            return {"tree": {"sha": "0" * 40}}
        raise AssertionError(path)

    def pages(self, path):
        if path.startswith("actions/runs/"):
            return self.artifacts
        if path.startswith("pulls?"):
            return self.pulls
        raise AssertionError(path)

    def download(self, run_id, name, directory):
        self.downloads += 1
        Path(directory, "candidate.json").write_text(json.dumps(self.value))

    def file(self, ref, path):
        return self.files[path]

    def dispatch(self, branch, commit):
        self.dispatches.append((branch, commit))
        if self.dispatch_failure:
            raise RuntimeError("fixture dispatch denied")


class CandidateTests(unittest.TestCase):
    def test_digest_pair_and_all_consumers(self):
        value = deploy.candidate(fixture())
        app = deploy.application(value)
        source = app["spec"]["source"]
        self.assertEqual(source["targetRevision"], value["revision"])
        self.assertEqual(source["path"], "charts/logice")
        for component, ref in value["images"].items():
            image = source["helm"]["valuesObject"][component]["image"]
            self.assertEqual(image["repository"] + "@" + image["digest"], ref)
            self.assertEqual(image["tag"], "")

    def test_partial_mismatched_and_extra_image_records_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            for component in ("api", "web"):
                Path(directory, f"{component}.json").write_text(json.dumps({
                    "component": component, "revision": fixture()["revision"], "image": fixture()["images"][component]}))
            self.assertEqual(deploy.pair(directory, fixture()["revision"]), fixture()["images"])
            Path(directory, "extra.json").write_text("{}")
            with self.assertRaises(ValueError):
                deploy.pair(directory, fixture()["revision"])
            Path(directory, "extra.json").unlink()
            record = json.loads(Path(directory, "web.json").read_text())
            record["revision"] = "f" * 40
            Path(directory, "web.json").write_text(json.dumps(record))
            with self.assertRaises(ValueError):
                deploy.pair(directory, fixture()["revision"])
            Path(directory, "web.json").unlink()
            with self.assertRaises(ValueError):
                deploy.pair(directory, fixture()["revision"])

    def test_invalid_identity_and_bounded_json(self):
        for field, values in {
            "revision": ["main", "a" * 40 + "\n"],
            "version": ["latest", "01.2.3", "1.2.3-beta", "1.2.3\n", "9" * 128 + ".0.0"],
            "schema": [True, 2], "run": [{"id": True, "attempt": 1}, {"id": 123, "attempt": 0}],
        }.items():
            for invalid in values:
                value = fixture()
                value[field] = invalid
                with self.assertRaises(ValueError):
                    deploy.candidate(value)
        for ref in ("ghcr.io/narumiruna/logice-api:latest", fixture()["images"]["web"],
                    fixture()["images"]["api"] + "\nother", fixture()["images"]["api"].replace("b" * 64, "B" * 64)):
            value = fixture()
            value["images"]["api"] = ref
            with self.assertRaises(ValueError):
                deploy.candidate(value)
        for data in ('{"revision":1,"revision":2}', " " * 65537):
            with self.assertRaises(ValueError):
                deploy.decode(data)

    def test_same_pair_is_noop_but_rebuilt_or_older_release_is_rejected(self):
        current = fixture()
        repeated = copy.deepcopy(current)
        repeated["run"]["attempt"] = 2
        self.assertFalse(deploy.forward_only(current, repeated))
        for version in ("1.2.2", "1.2.3", "0.9.0"):
            repeated["version"] = version
            repeated["images"]["api"] = repeated["images"]["api"].replace("b" * 64, "d" * 64)
            with self.assertRaises(ValueError):
                deploy.forward_only(current, repeated)
        repeated["version"] = "1.2.4"
        self.assertTrue(deploy.forward_only(current, repeated))


class SourceTests(unittest.TestCase):
    def test_exact_source_version_and_ancestry_use_real_git(self):
        previous = Path.cwd()
        with tempfile.TemporaryDirectory() as directory:
            env = dict(os.environ, GIT_AUTHOR_NAME="Deployment fixture", GIT_AUTHOR_EMAIL="fixture@example.invalid",
                       GIT_COMMITTER_NAME="Deployment fixture", GIT_COMMITTER_EMAIL="fixture@example.invalid",
                       GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
            def git(*args):
                return subprocess.check_output(["git", *args], cwd=directory, env=env, stderr=subprocess.PIPE, text=True).strip()
            git("init", "--initial-branch=main")
            Path(directory, "VERSION").write_text("1.2.3\n")
            git("add", "VERSION")
            git("-c", "commit.gpgsign=false", "commit", "-m", "test: release source")
            value = fixture()
            value["revision"] = git("rev-parse", "HEAD")
            os.chdir(directory)
            try:
                deploy.verify_source(value, "main")
                value["version"] = "1.2.4"
                with self.assertRaises(ValueError):
                    deploy.verify_source(value, "main")
                value["version"] = "1.2.3"
                git("checkout", "--orphan", "other")
                git("-c", "commit.gpgsign=false", "commit", "-m", "test: unrelated history")
                with self.assertRaises(subprocess.CalledProcessError):
                    deploy.verify_source(value, "other")
            finally:
                os.chdir(previous)


class EvidenceTests(unittest.TestCase):
    def test_successful_exact_run_and_missing_artifact(self):
        github = GitHubFixture()
        self.assertEqual(deploy.release_evidence(github, 123, 1), fixture())
        github.artifacts = []
        self.assertIsNone(deploy.release_evidence(github, 123, 1, allow_missing=True))
        with self.assertRaises(ValueError):
            deploy.release_evidence(github, 123, 1)

    def test_wrong_failed_cancelled_or_untrusted_runs_cannot_promote(self):
        changes = [("workflow_id", 99), ("path", ".github/workflows/docker.yml"),
                   ("head_repository", {"full_name": "untrusted/logice"}), ("head_branch", "topic"),
                   ("event", "pull_request"), ("status", "in_progress"), ("conclusion", "failure"),
                   ("conclusion", "cancelled"), ("run_attempt", 2)]
        for key, value in changes:
            github = GitHubFixture()
            github.run[key] = value
            with self.assertRaises(ValueError):
                deploy.release_evidence(github, 123, 1)
            self.assertEqual(github.downloads, 0)
            self.assertEqual(github.writes, [])

    def test_expired_duplicate_and_replayed_artifacts_fail(self):
        for kind in ("expired", "duplicate", "wrong_attempt", "wrong_run"):
            github = GitHubFixture()
            if kind == "expired":
                github.artifacts[0]["expired"] = True
            elif kind == "duplicate":
                github.artifacts *= 2
            elif kind == "wrong_attempt":
                github.value["run"]["attempt"] = 2
            else:
                github.value["run"]["id"] = 456
            with self.assertRaises(ValueError):
                deploy.release_evidence(github, 123, 1)
            self.assertEqual(github.writes, [])
            if kind == "expired":
                with self.assertRaises(ValueError):
                    deploy.release_evidence(github, 123, 1, allow_missing=True)


class PromotionTests(unittest.TestCase):
    def test_atomic_two_file_draft_pr_and_explicit_ci(self):
        github = GitHubFixture()
        url = deploy.propose(github, fixture(), github.base, None)
        self.assertEqual(url, "https://example.invalid/pull/1")
        tree = next(data for path, data in github.writes if path == "git/trees")
        self.assertEqual({item["path"] for item in tree["tree"]}, {deploy.RELEASE_PATH, deploy.APPLICATION_PATH})
        pull = next(data for path, data in github.writes if path == "pulls")
        self.assertTrue(pull["draft"])
        self.assertEqual(pull["base"], "main")
        self.assertEqual(github.dispatches, [("narumi/chore/deploy-v1-2-3", github.head)])
        before = copy.deepcopy(github.writes)
        self.assertEqual(deploy.propose(github, fixture(), github.base, None), url)
        self.assertEqual(github.writes, before)

    def test_stale_retry_and_changed_base_make_no_remote_writes(self):
        github = GitHubFixture()
        newer = fixture()
        newer["version"] = "1.3.0"
        with self.assertRaises(ValueError):
            deploy.propose(github, fixture(), github.base, newer)
        with self.assertRaises(ValueError):
            deploy.propose(github, fixture(), "1" * 40, None)
        self.assertEqual(github.writes, [])
        self.assertEqual(github.dispatches, [])
        self.assertIsNone(deploy.propose(github, fixture(), github.base, fixture()))

    def test_changed_or_closed_branch_is_not_overwritten(self):
        github = GitHubFixture()
        deploy.propose(github, fixture(), github.base, None)
        before = copy.deepcopy(github.writes)
        github.unrelated = True
        with self.assertRaises(ValueError):
            deploy.propose(github, fixture(), github.base, None)
        github.unrelated = False
        github.files[deploy.RELEASE_PATH]["revision"] = "f" * 40
        with self.assertRaises(ValueError):
            deploy.propose(github, fixture(), github.base, None)
        github.pulls[0]["state"] = "closed"
        with self.assertRaises(ValueError):
            deploy.propose(github, fixture(), github.base, None)
        self.assertEqual(github.writes, before)

    def test_dispatch_failure_is_reported_and_retry_reuses_the_pr(self):
        github = GitHubFixture()
        github.dispatch_failure = True
        with self.assertRaisesRegex(RuntimeError, "dispatch denied"):
            deploy.propose(github, fixture(), github.base, None)
        self.assertEqual(len(github.pulls), 1)
        before = copy.deepcopy(github.writes)
        github.dispatch_failure = False
        deploy.propose(github, fixture(), github.base, None)
        self.assertEqual(github.writes, before)

    def test_ci_dispatch_reuses_current_checks_and_retries_failed_checks(self):
        for status, conclusion, sha, expected_calls in (
            ("completed", "success", "e" * 40, 1),
            ("in_progress", None, "e" * 40, 1),
            ("completed", "failure", "e" * 40, 2),
            ("completed", "success", "f" * 40, 2),
        ):
            runs = [{"workflow_runs": [{"head_sha": sha, "status": status, "conclusion": conclusion}]}]
            with patch.object(deploy, "command", side_effect=[json.dumps(runs), ""]) as run:
                deploy.GitHub().dispatch("narumi/chore/deploy-v1-2-3", "e" * 40)
                self.assertEqual(run.call_count, expected_calls)
                if expected_calls == 2:
                    self.assertEqual(run.call_args.args[:4], ("gh", "workflow", "run", "ci.yml"))

    def test_gitops_record_guard_checks_proof_and_rejects_deletion_or_edits(self):
        old_cwd = Path.cwd()
        with tempfile.TemporaryDirectory() as directory:
            os.chdir(directory)
            try:
                Path(deploy.RELEASE_PATH).parent.mkdir(parents=True)
                value = fixture()
                Path(deploy.RELEASE_PATH).write_text(deploy.encoded(value))
                Path(deploy.APPLICATION_PATH).write_text(deploy.encoded(deploy.application(value)))
                with patch.object(deploy, "git_file", return_value=None), patch.object(deploy, "verify_source") as source:
                    deploy.check("origin/main", GitHubFixture())
                    source.assert_called_once()
                    app = deploy.application(value)
                    app["spec"]["source"]["targetRevision"] = "main"
                    Path(deploy.APPLICATION_PATH).write_text(deploy.encoded(app))
                    with self.assertRaises(ValueError):
                        deploy.check("origin/main", GitHubFixture())
                Path(deploy.RELEASE_PATH).unlink()
                Path(deploy.APPLICATION_PATH).unlink()
                with patch.object(deploy, "git_file", return_value=deploy.encoded(value)):
                    with self.assertRaises(ValueError):
                        deploy.check("origin/main", GitHubFixture())
            finally:
                os.chdir(old_cwd)


class CIDocumentationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="logice-ci-docs-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.addCleanup(os.chdir, Path.cwd())
        os.chdir(self.root)
        self.env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        self.env.update({
            "GIT_AUTHOR_NAME": "CI fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
            "GIT_COMMITTER_NAME": "CI fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0",
        })
        self.git("init", "--initial-branch=main")
        for path in ("README.md", "docs/guide.md", "internal/app.go"):
            self.write(path, "Initial fixture.\n")
        self.base = self.commit("README.md", "docs/guide.md", "internal/app.go")
        self.head = self.base

    def git(self, *args):
        return subprocess.check_output(["git", *args], env=self.env, text=True,
                                       stderr=subprocess.PIPE, timeout=15).strip()

    def write(self, path, content):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def commit(self, *paths):
        if paths:
            self.git("add", "--", *paths)
        self.git("-c", "commit.gpgsign=false", "commit", "-m", "test: CI diff fixture")
        return self.git("rev-parse", "HEAD")

    def event(self, branch="narumi/docs/guide"):
        return {"pull_request": {"base": {"sha": self.base}, "head": {"sha": self.head, "ref": branch}}}

    def selected(self, event=None, event_name="pull_request", revision=""):
        return ci_docs_only.documentation_only(event_name, revision, self.event() if event is None else event)

    def test_only_known_markdown_documentation_can_skip_expensive_jobs(self):
        for path in ("README.md", "CHANGELOG.md", ".changenote/README.md", "docs/guide.md", "docs/deep/guide.md"):
            self.write(path, "Updated documentation.\n")
            self.head = self.commit(path)
            self.assertTrue(self.selected(), path)

    def test_code_release_metadata_and_unlisted_paths_keep_full_tests(self):
        for path in ("internal/app.go", "web/src/app.tsx", ".github/workflows/ci.yml", "scripts/check-go.sh",
                     "docs/fixture.sql", "docs.md", "VERSION", "web/package-lock.json",
                     ".changenote/fix.md", ".changenote/releases.json", "deploy/gitops/logice.json"):
            with self.subTest(path=path), patch.object(ci_docs_only.subprocess, "check_output",
                                                      return_value=f"docs/guide.md\0{path}\0".encode()):
                self.assertFalse(self.selected())

    def test_renaming_code_into_documentation_does_not_hide_its_removal(self):
        self.git("mv", "internal/app.go", "docs/app.md")
        self.head = self.commit()
        self.assertFalse(self.selected())

    def test_deleting_code_keeps_full_tests(self):
        self.git("rm", "--", "internal/app.go")
        self.head = self.commit()
        self.assertFalse(self.selected())

    def test_documentation_renames_and_deletions_stay_documentation_only(self):
        self.git("mv", "docs/guide.md", "docs/renamed.md")
        self.head = self.commit()
        self.assertTrue(self.selected())
        self.git("rm", "--", "docs/renamed.md")
        self.head = self.commit()
        self.assertTrue(self.selected())

    def test_empty_diffs_keep_full_tests(self):
        self.assertFalse(self.selected())

    def test_release_prs_reusable_ci_and_non_pr_events_never_skip(self):
        with patch.object(ci_docs_only.subprocess, "check_output") as diff:
            self.assertFalse(self.selected(event=self.event("narumi/chore/changenote-release-main")))
            self.assertFalse(self.selected(revision="a" * 40))
            for event in ("push", "workflow_dispatch", "merge_group", "workflow_call", ""):
                self.assertFalse(self.selected(event_name=event), event)
            diff.assert_not_called()

    def test_invalid_metadata_and_unavailable_diffs_keep_full_tests(self):
        for event in ({}, {"pull_request": []}, {"pull_request": {"head": {}}},
                      {"pull_request": {"base": {"sha": "main"}, "head": {"sha": self.head, "ref": "docs"}}}):
            self.assertFalse(self.selected(event=event), event)
        for error in (OSError("fixture"), subprocess.CalledProcessError(1, "git"),
                      subprocess.TimeoutExpired("git", 30)):
            with patch.object(ci_docs_only.subprocess, "check_output", side_effect=error):
                self.assertFalse(self.selected())

    def test_null_delimited_paths_do_not_split_newline_filenames(self):
        self.write("docs/multiple\nlines.md", "Documentation.\n")
        self.head = self.commit("docs/multiple\nlines.md")
        self.assertTrue(self.selected())

    def test_cli_outputs_a_decision_and_invalid_json_keeps_full_tests(self):
        self.write("docs/guide.md", "Updated documentation.\n")
        self.head = self.commit("docs/guide.md")
        event = self.root / "event.json"
        output = self.root / "output"
        for content, expected in ((json.dumps(self.event()), "true"), ("invalid-json", "false")):
            event.write_text(content)
            output.write_text("")
            with patch.dict(os.environ, {"GITHUB_EVENT_NAME": "pull_request", "REVISION": "",
                                         "GITHUB_EVENT_PATH": str(event), "GITHUB_OUTPUT": str(output)}):
                ci_docs_only.main()
            self.assertEqual(output.read_text(), f"docs-only={expected}\n")


class WorkflowTests(unittest.TestCase):
    def workflow(self, name):
        return yaml.load((ROOT / f".github/workflows/{name}.yml").read_text(), Loader=yaml.BaseLoader)

    def test_candidate_is_recorded_only_after_both_builds_and_image_validation(self):
        jobs = self.workflow("docker")["jobs"]
        build_job = next(job for job in jobs.values() if "strategy" in job)
        image_job = next(job for job in jobs.values()
                         if any("scripts/deployment.py candidate" in step.get("run", "") for step in job.get("steps", [])))
        self.assertEqual(image_job["needs"], "publish")
        self.assertNotIn("if", image_job)
        self.assertEqual(image_job["permissions"], {"contents": "read", "packages": "read"})
        build = next(step for step in build_job["steps"] if step.get("id") == "build")
        record = next(step for step in build_job["steps"] if "steps.build.outputs.digest" in step.get("env", {}).get("IMAGE", ""))
        self.assertEqual(build["uses"], "docker/build-push-action@v7")
        self.assertNotIn("if", record)
        self.assertNotIn(":latest", record["env"]["IMAGE"])
        steps = image_job["steps"]
        pair = next(index for index, step in enumerate(steps) if step.get("id") == "pair")
        validate = next(index for index, step in enumerate(steps) if "scripts/validate-compose-web.sh" in step.get("run", ""))
        candidate = next(index for index, step in enumerate(steps) if "scripts/deployment.py candidate" in step.get("run", ""))
        upload = next(index for index, step in enumerate(steps)
                      if step.get("with", {}).get("path") == "candidate.json")
        self.assertLess(pair, validate)
        self.assertLess(validate, candidate)
        self.assertLess(candidate, upload)
        for step in steps:
            self.assertNotIn("continue-on-error", step)
            self.assertNotIn("if", step)
        for index in (validate, candidate):
            for component in ("api", "web"):
                self.assertEqual(steps[index]["env"][f"{component.upper()}_IMAGE"],
                                 "${{ steps.pair.outputs." + component + " }}")
        self.assertIn('scripts/validate-compose-web.sh "$API_IMAGE" "$WEB_IMAGE"', steps[validate]["run"])

    def test_source_ci_and_published_image_checks_have_separate_responsibilities(self):
        ci = self.workflow("ci")
        self.assertEqual(set(ci["on"]["workflow_call"]["inputs"]), {"revision"})
        for job in ci["jobs"].values():
            checkout = job["steps"][0]
            self.assertEqual(checkout["with"]["ref"], "${{ inputs.revision || github.sha }}")
            self.assertEqual(checkout["with"]["persist-credentials"], "false")
        jobs = ci["jobs"]
        self.assertEqual({key: job["name"] for key, job in jobs.items()},
                         {"checks": "Checks", "integration": "Integration", "e2e": "E2E"})
        checks = jobs["checks"]
        self.assertNotIn("if", checks)
        self.assertEqual(checks["permissions"], {"contents": "read", "actions": "read"})
        self.assertEqual(checks["steps"][0]["with"]["fetch-depth"], "0")
        self.assertEqual(checks["outputs"], {"docs-only": "${{ steps.changes.outputs.docs-only }}"})
        selector = next(step for step in checks["steps"] if step.get("id") == "changes")
        self.assertEqual(selector["if"], "github.event_name == 'pull_request' && inputs.revision == ''")
        self.assertEqual(selector["run"], "uv run scripts/ci-docs-only.py")
        self.assertEqual(selector["env"], {"REVISION": "${{ inputs.revision }}"})
        commands = "\n".join(step.get("run", "") for step in checks["steps"])
        for command in ("go mod verify", "sh scripts/check-go.sh", "govulncheck@v1.9.0",
                        "npm --prefix web ci", "npm --prefix web run ci", "npm --prefix web audit --audit-level=low",
                        "uv run charts/logice/tests/check.py", "uv run tests/deployment/check.py",
                        "uv run scripts/deployment.py check --base origin/main",
                        "uv run tests/release/check.py", "changenote status"):
            self.assertIn(command, commands)
        for step in checks["steps"]:
            self.assertNotIn("continue-on-error", step)
            if step is not selector:
                self.assertNotIn("if", step)
        for name, minutes in (("checks", "20"), ("integration", "15"), ("e2e", "15")):
            self.assertEqual(jobs[name]["timeout-minutes"], minutes)
        integration = jobs["integration"]
        self.assertEqual(integration["needs"], "checks")
        self.assertEqual(integration["if"], "needs.checks.outputs.docs-only != 'true'")
        self.assertEqual(integration["steps"][-1]["run"],
                         "go test -race -tags=integration -count=1 -timeout=8m -v ./tests/integration/... ./internal/auth/...")
        browser = jobs["e2e"]
        self.assertEqual(browser["needs"], "checks")
        self.assertEqual(browser["if"], "inputs.revision == '' && needs.checks.outputs.docs-only != 'true'")
        self.assertIn("sh scripts/validate-compose-web.sh", browser["steps"][-1]["run"])
        self.assertEqual(ci["on"]["merge_group"]["types"], ["checks_requested"])
        self.assertEqual(ci["on"]["push"]["branches"], ["main"])
        self.assertEqual(ci["on"]["pull_request"]["branches"], ["main"])
        image_job = self.workflow("docker")["jobs"]["validate-images"]
        self.assertEqual(image_job["steps"][0]["with"]["ref"], "${{ inputs.revision }}")
        self.assertEqual(image_job["steps"][0]["with"]["persist-credentials"], "false")

    def test_tooling_fixtures_are_path_scoped_and_manually_available(self):
        ci = self.workflow("ci")
        tooling = self.workflow("tooling")
        self.assertIn("workflow_dispatch", tooling["on"])
        self.assertEqual(tooling["on"]["pull_request"]["branches"], ["main"])
        paths = tooling["on"]["pull_request"]["paths"]
        for path in (".github/workflows/ci.yml", ".github/actions/setup-changenote/action.yml",
                     ".husky/pre-commit", "scripts/check-go.sh", "scripts/pre-commit.sh",
                     "scripts/validate-checks.sh", "scripts/validate-web-layout.sh",
                     "tests/fixtures/web-layout/web/package.json", "web/package.json",
                     "web/biome.json", "web/tsconfig.json", "web/vite.config.ts", "go.mod", "go.sum",
                     ".changenote/config.json"):
            self.assertTrue(any(fnmatchcase(path, pattern) for pattern in paths), path)
        for path in ("web/src/live/tree.tsx", "internal/httpapi/live.go", "README.md"):
            self.assertFalse(any(fnmatchcase(path, pattern) for pattern in paths), path)
        for name in ("check-failure-validation", "web-layout-validation"):
            self.assertNotIn(name, ci["jobs"])
            self.assertIn(name, tooling["jobs"])
        commands = "\n".join(step.get("run", "") for job in tooling["jobs"].values() for step in job["steps"])
        for command in ("sh scripts/validate-checks.sh", "sh scripts/validate-web-layout.sh"):
            self.assertIn(command, commands)

    def test_promotion_has_no_cluster_access_and_uses_trusted_main(self):
        workflow = self.workflow("promote")
        self.assertEqual(workflow["on"]["workflow_run"]["workflows"], ["Release"])
        self.assertEqual(workflow["concurrency"]["cancel-in-progress"], "false")
        job = workflow["jobs"]["propose"]
        self.assertIn("github.event.workflow_run.conclusion == 'success'", job["if"])
        self.assertEqual(job["steps"][0]["with"]["ref"], "main")
        self.assertEqual(job["permissions"], {"contents": "write", "pull-requests": "write", "actions": "write"})
        text = (ROOT / ".github/workflows/promote.yml").read_text()
        for forbidden in ("kubectl", "argocd app", "KUBECONFIG", "pull_request_target"):
            self.assertNotIn(forbidden, text)
        parent = yaml.safe_load((ROOT / "charts/argocd-gitops-parent.example.yaml").read_text())
        self.assertEqual(parent["spec"]["source"]["directory"]["include"], "logice.json")

    def test_pinned_container_failures_never_build_or_continue(self):
        for failure in ("build", "pull", "up"):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                binary = root / "docker"
                binary.write_text('''#!/bin/sh
printf '%s\\n' "$*" >> "$FIXTURE_CALLS"
case "$*" in
  *" config --quiet") exec "$FIXTURE_DOCKER" "$@" ;;
  *" build "*) if [ "$FIXTURE_FAILURE" = build ]; then exit 41; fi ;;
  *" pull "*) if [ "$FIXTURE_FAILURE" = pull ]; then exit 42; fi ;;
  *" up "*) if [ "$FIXTURE_FAILURE" = up ]; then exit 43; fi ;;
  "image inspect "*) printf '%s\\n' "$FIXTURE_REVISION" ;;
esac
exit 0
''')
                binary.chmod(0o755)
                env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ["PATH"],
                           FIXTURE_CALLS=str(root / "calls"), FIXTURE_FAILURE=failure,
                           FIXTURE_DOCKER=shutil.which("docker"),
                           FIXTURE_REVISION=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip())
                images = [] if failure == "build" else list(fixture()["images"].values())
                result = subprocess.run(["sh", "scripts/validate-compose-web.sh", *images],
                                        cwd=ROOT, env=env, text=True, capture_output=True, timeout=30)
                self.assertEqual(result.returncode, {"build": 41, "pull": 42, "up": 43}[failure], result.stdout + result.stderr)
                calls = (root / "calls").read_text()
                self.assertIn(f" {failure} ", calls)
                if failure == "build":
                    self.assertIn(" build api web migrate", calls)
                else:
                    self.assertNotIn(" build ", calls)
                self.assertIn(" down ", calls)
                self.assertNotIn(" bootstrap ", calls)
                if failure in ("build", "pull"):
                    self.assertNotIn(" up ", calls)
        for invalid in ([fixture()["images"]["api"]], [fixture()["images"]["api"] + "\nother", fixture()["images"]["web"]]):
            result = subprocess.run(["sh", "scripts/validate-compose-web.sh", *invalid], cwd=ROOT, capture_output=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
