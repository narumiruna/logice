# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Skip expensive PR checks only for a verified Markdown documentation diff."""

import json
import os
from pathlib import Path
import re
import subprocess

SHA = re.compile(r"[0-9a-f]{40}")


def documentation_only(event_name, revision, event):
    if event_name != "pull_request" or revision:
        return False
    try:
        pull = event["pull_request"]
        branch = pull["head"]["ref"]
        if not isinstance(branch, str) or not branch or branch == "narumi/chore/changenote-release-main":
            return False
        base, head = pull["base"]["sha"], pull["head"]["sha"]
        if any(not isinstance(ref, str) or not SHA.fullmatch(ref) for ref in (base, head)):
            return False
        changed = subprocess.check_output(
            ["git", "diff", "--name-only", "--no-renames", "-z", f"{base}...{head}", "--"],
            stderr=subprocess.DEVNULL, timeout=30,
        )
        paths = [os.fsdecode(path) for path in changed.split(b"\0") if path]
        return bool(paths) and all(
            path in {"README.md", "CHANGELOG.md", ".changenote/README.md"}
            or (path.startswith("docs/") and path.endswith(".md"))
            for path in paths
        )
    except (KeyError, TypeError, OSError, subprocess.SubprocessError):
        return False


def main():
    try:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    except (KeyError, OSError, ValueError):
        event = {}
    docs_only = documentation_only(os.environ.get("GITHUB_EVENT_NAME", ""), os.environ.get("REVISION", ""), event)
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"docs-only={str(docs_only).lower()}\n")
    print("Documentation-only PR: skip Integration and E2E." if docs_only else "Full source validation is required.")


if __name__ == "__main__":
    main()
