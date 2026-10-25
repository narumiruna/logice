# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Validate release evidence and propose GitOps changes. Never contact a cluster."""

import argparse
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

REPOSITORY = "narumiruna/logice"
RELEASE_PATH = "deploy/gitops/release.json"
APPLICATION_PATH = "deploy/gitops/logice.json"
SHA = re.compile(r"[0-9a-f]{40}")
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON key")
        result[key] = value
    return result


def decode(data):
    require(len(data) <= 65536, "Deployment JSON exceeds 64 KiB")
    return json.loads(data, object_pairs_hook=unique_object)


def read_json(path):
    path = Path(path)
    require(path.is_file() and not path.is_symlink(), "Expected a regular JSON file")
    with path.open("rb") as source:
        return decode(source.read(65537))


def encoded(value):
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def version_key(version):
    require(isinstance(version, str) and len(version) <= 127 and VERSION.fullmatch(version), "Invalid stable release version")
    return tuple(int(part) for part in version.split("."))


def image_ref(component, value):
    prefix = f"ghcr.io/{REPOSITORY}-{component}@sha256:"
    require(isinstance(value, str) and re.fullmatch(re.escape(prefix) + r"[0-9a-f]{64}", value), "Invalid immutable image reference")
    return value


def candidate(value):
    require(isinstance(value, dict) and set(value) == {"schema", "revision", "version", "images", "run"}, "Invalid candidate fields")
    require(type(value["schema"]) is int and value["schema"] == 1, "Unsupported candidate schema")
    require(isinstance(value["revision"], str) and SHA.fullmatch(value["revision"]), "Invalid release revision")
    version_key(value["version"])
    require(isinstance(value["images"], dict) and set(value["images"]) == {"api", "web"}, "Both images are required")
    for component, ref in value["images"].items():
        image_ref(component, ref)
    require(isinstance(value["run"], dict) and set(value["run"]) == {"id", "attempt"}, "Invalid run evidence")
    for number in value["run"].values():
        require(type(number) is int and 0 < number < 2**63, "Invalid workflow run or attempt")
    return value


def pair(directory, revision):
    require(SHA.fullmatch(revision), "Expected an exact revision")
    root = Path(directory)
    require(sorted(p.name for p in root.iterdir()) == ["api.json", "web.json"], "Exactly two image records are required")
    images = {}
    for component in ("api", "web"):
        record = read_json(root / f"{component}.json")
        require(isinstance(record, dict) and set(record) == {"component", "revision", "image"}, "Invalid image record")
        require(record["component"] == component and record["revision"] == revision, "Image pair has different source revisions")
        images[component] = image_ref(component, record["image"])
    return images


def identity(value):
    return {key: value[key] for key in ("revision", "version", "images")}


def forward_only(current, proposed):
    candidate(proposed)
    if current is None:
        return True
    candidate(current)
    if identity(current) == identity(proposed):
        return False
    require(version_key(proposed["version"]) > version_key(current["version"]),
            "Promotion must advance the release version; use a new release, not a stale retry or rebuilt tag")
    return True


def application(value):
    candidate(value)
    images = {}
    for component, ref in value["images"].items():
        repository, digest = ref.split("@")
        images[component] = {"image": {"repository": repository, "digest": digest, "tag": ""}}
    return {
        "apiVersion": "argoproj.io/v1alpha1", "kind": "Application",
        "metadata": {"name": "logice", "namespace": "argocd"},
        "spec": {
            "project": "private",
            "source": {
                "repoURL": f"https://github.com/{REPOSITORY}",
                "targetRevision": value["revision"], "path": "charts/logice",
                "helm": {"releaseName": "logice", "valuesObject": images},
            },
            "destination": {"server": "https://kubernetes.default.svc", "namespace": "logice"},
            "syncPolicy": {"automated": {"prune": True, "selfHeal": True}, "syncOptions": ["CreateNamespace=true"]},
        },
    }


def command(*args):
    return subprocess.check_output(args, text=True, timeout=90).strip()


def git_file(ref, path):
    found = command("git", "ls-tree", "--name-only", ref, "--", path)
    if not found:
        return None
    return command("git", "show", f"{ref}:{path}")


def verify_source(value, base="origin/main"):
    require(command("git", "show", f'{value["revision"]}:VERSION') == value["version"], "Release version does not match its source")
    subprocess.run(["git", "merge-base", "--is-ancestor", value["revision"], base], check=True, timeout=30)


class GitHub:
    def api(self, path, data=None):
        args = ["gh", "api", f"repos/{REPOSITORY}/{path}"]
        if data is not None:
            args.extend(["--method", "POST", "--input", "-"])
        result = subprocess.run(args, input=None if data is None else json.dumps(data), text=True,
                                capture_output=True, check=True, timeout=90)
        return json.loads(result.stdout)

    def pages(self, path):
        pages = json.loads(command("gh", "api", "--paginate", "--slurp", f"repos/{REPOSITORY}/{path}"))
        return [item for page in pages for item in (page if isinstance(page, list) else page["artifacts"])]

    def download(self, run_id, name, directory):
        command("gh", "run", "download", str(run_id), "--repo", REPOSITORY, "--name", name, "--dir", str(directory))

    def file(self, ref, path):
        result = self.api(f"contents/{path}?ref={ref}")
        require(result.get("type") == "file" and result.get("encoding") == "base64", "Expected a repository file")
        return decode(base64.b64decode(result["content"], validate=False))

    def dispatch(self, branch, commit):
        pages = json.loads(command("gh", "api", "--paginate", "--slurp",
                                   f"repos/{REPOSITORY}/actions/workflows/ci.yml/runs?event=workflow_dispatch&branch={branch}&per_page=100"))
        runs = [run for page in pages for run in page["workflow_runs"] if run["head_sha"] == commit]
        if runs and (runs[0]["status"] != "completed" or runs[0]["conclusion"] == "success"):
            return
        command("gh", "workflow", "run", "ci.yml", "--repo", REPOSITORY, "--ref", branch)


def release_evidence(github, run_id, attempt=None, allow_missing=False):
    require(type(run_id) is int and 0 < run_id < 2**63, "Invalid Release run ID")
    run = github.api(f"actions/runs/{run_id}")
    workflow = github.api("actions/workflows/release.yml")
    require(run.get("workflow_id") == workflow["id"] and run.get("path") == ".github/workflows/release.yml", "Not the Release workflow")
    require(run.get("head_repository", {}).get("full_name") == REPOSITORY and run.get("head_branch") == "main", "Release must come from this repository's main branch")
    require(run.get("event") in ("push", "workflow_dispatch") and run.get("status") == "completed" and run.get("conclusion") == "success", "Release run did not complete successfully")
    if attempt is not None:
        require(run["run_attempt"] == attempt, "Release attempt changed; use the current successful attempt")
    name = f'logice-deployment-{run["run_attempt"]}'
    artifacts = github.pages(f"actions/runs/{run_id}/artifacts?per_page=100")
    matches = [a for a in artifacts if a["name"] == name]
    if not matches and allow_missing:
        return None
    require(len(matches) == 1 and not matches[0]["expired"], "One current, unexpired deployment candidate is required")
    with tempfile.TemporaryDirectory(prefix="logice-candidate-") as directory:
        github.download(run_id, name, directory)
        require([p.name for p in Path(directory).iterdir()] == ["candidate.json"], "Unexpected candidate artifact files")
        value = candidate(read_json(Path(directory) / "candidate.json"))
    require(value["run"] == {"id": run_id, "attempt": run["run_attempt"]}, "Candidate is not from this Release attempt")
    return value


def propose(github, proposed, base, current):
    if not forward_only(current, proposed):
        return None
    branch = "narumi/chore/deploy-v" + proposed["version"].replace(".", "-")
    files = {RELEASE_PATH: proposed, APPLICATION_PATH: application(proposed)}
    refs = github.api(f"git/matching-refs/heads/{branch}")
    matching = [ref for ref in refs if ref["ref"] == f"refs/heads/{branch}"]
    require(len(matching) <= 1, "Ambiguous promotion branch")
    pulls = github.pages(f"pulls?state=all&head=narumiruna:{branch}&base=main&per_page=100")
    require(len(pulls) <= 1, "Ambiguous promotion pull request")
    if pulls:
        require(pulls[0]["state"] == "open", "Promotion PR was closed; do not recreate it automatically")
    if matching:
        commit = matching[0]["object"]["sha"]
        diff = github.api(f"compare/{base}...{commit}")
        require(diff.get("total_commits") == 1 and {item["filename"] for item in diff.get("files", [])} == set(files),
                "Promotion branch contains unrelated changes; do not reuse it")
        for path, value in files.items():
            require(github.file(commit, path) == value, "Promotion branch already contains different evidence; do not overwrite it")
    else:
        require(not pulls, "Promotion PR has no branch")
        require(github.api("git/ref/heads/main")["object"]["sha"] == base, "main changed; retry promotion before writing")
        parent = github.api(f"git/commits/{base}")
        tree = github.api("git/trees", {"base_tree": parent["tree"]["sha"], "tree": [
            {"path": path, "mode": "100644", "type": "blob", "content": encoded(value)} for path, value in files.items()
        ]})
        commit = github.api("git/commits", {"message": f'chore(deploy): promote Logice v{proposed["version"]}',
                                           "tree": tree["sha"], "parents": [base]})["sha"]
        github.api("git/refs", {"ref": f"refs/heads/{branch}", "sha": commit})
    if pulls:
        pull = pulls[0]
    else:
        evidence_url = f'https://github.com/{REPOSITORY}/actions/runs/{proposed["run"]["id"]}/attempts/{proposed["run"]["attempt"]}'
        body = f'''## Deployment candidate

Promote one tested API/web pair from `{proposed["revision"]}`.

- API: `{proposed["images"]["api"]}`
- Web: `{proposed["images"]["web"]}`
- Evidence: {evidence_url}

This PR changes the pinned chart and both image references together. It does not deploy until the GitOps parent is adopted and this PR is approved and merged.

## Operator approval

- [ ] Complete CI on this exact PR head with the latest base. Require up-to-date branches or a merge queue.
- [ ] Verify the GitOps source, Secret keys, registry access, storage, and HTTPS origin.
- [ ] Record database/key backup and restore evidence. Confirm a schema-compatible rollback target or a forward-fix procedure.
- [ ] Record real user-verifying Passkey evidence on the intended HTTPS origin. Virtual tests do not close this gate.
- [ ] Approve the Recreate outage and old-browser/new-API compatibility.

After merge and sync, record the running digests and authenticated project list/create checks. See docs/deployment.md. Do not auto-merge this PR.
'''
        pull = github.api("pulls", {"title": f'chore(deploy): promote Logice v{proposed["version"]}',
                                    "head": branch, "base": "main", "draft": True, "body": body})
    # GITHUB_TOKEN-created PRs do not cause pull_request CI. Dispatch explicitly.
    # A failure is fatal; an idempotent retry reuses the branch and PR.
    require(github.api(f"git/ref/heads/{branch}")["object"]["sha"] == commit, "Promotion branch changed before CI dispatch")
    github.dispatch(branch, commit)
    return pull["html_url"]


def check(base, github):
    old_text = git_file(base, RELEASE_PATH)
    old_app = git_file(base, APPLICATION_PATH)
    current = candidate(decode(old_text)) if old_text is not None else None
    release = Path(RELEASE_PATH)
    app = Path(APPLICATION_PATH)
    if not release.exists() and not app.exists():
        require(current is None and old_app is None, "Do not remove deployment records to bypass promotion guards")
        return
    proposed = candidate(read_json(release))
    require(read_json(app) == application(proposed), "Application must match the tested chart revision and image pair")
    if old_text is not None and proposed == current and old_app is not None and decode(old_app) == application(proposed):
        return
    require(forward_only(current, proposed), "Deployment evidence changed without a new release")
    verify_source(proposed, base)
    require(release_evidence(github, proposed["run"]["id"], proposed["run"]["attempt"]) == proposed, "Deployment files do not match successful Release evidence")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="operation", required=True)
    pairs = subs.add_parser("pair")
    pairs.add_argument("directory")
    pairs.add_argument("revision")
    manifest = subs.add_parser("candidate")
    manifest.add_argument("--revision", required=True)
    manifest.add_argument("--version", required=True)
    manifest.add_argument("--api-image", required=True)
    manifest.add_argument("--web-image", required=True)
    manifest.add_argument("--output", required=True)
    promote = subs.add_parser("promote")
    promote.add_argument("run_id", type=int)
    promote.add_argument("--attempt", type=int)
    promote.add_argument("--allow-missing", action="store_true")
    checking = subs.add_parser("check")
    checking.add_argument("--base", default="origin/main")
    args = parser.parse_args()
    if args.operation == "pair":
        images = pair(args.directory, args.revision)
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            for component, ref in images.items():
                output.write(f"{component}={ref}\n")
    elif args.operation == "candidate":
        require(command("git", "rev-parse", "HEAD") == args.revision, "Candidate checkout differs from the tested source")
        require(args.version == "v" + Path("VERSION").read_text().strip(), "Candidate version differs from the tested source")
        value = candidate({"schema": 1, "revision": args.revision, "version": args.version[1:],
                           "images": {"api": args.api_image, "web": args.web_image},
                           "run": {"id": int(os.environ["GITHUB_RUN_ID"]), "attempt": int(os.environ["GITHUB_RUN_ATTEMPT"])}})
        Path(args.output).write_text(encoded(value))
    elif args.operation == "check":
        check(args.base, GitHub())
    else:
        github = GitHub()
        value = release_evidence(github, args.run_id, args.attempt, args.allow_missing)
        if value is None:
            print("No deployment candidate. GitOps state is unchanged.")
            return
        base = command("git", "rev-parse", "origin/main")
        require(command("git", "rev-parse", "HEAD") == base, "Promotion tooling must come from current main")
        verify_source(value)
        old = git_file(base, RELEASE_PATH)
        url = propose(github, value, base, candidate(decode(old)) if old is not None else None)
        print(url or "This image pair is already promoted. GitOps state is unchanged.")


if __name__ == "__main__":
    main()
