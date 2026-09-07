#!/usr/bin/env python3
"""Verify local AI Central integration without executing imported skills."""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--ci", action="store_true", help="Check committed context without machine-local AI Central links")
args = parser.parse_args()

def require(condition, message):
    if not condition:
        raise SystemExit(message)

def git(*args):
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True)

for relative in ("AGENTS.md", ".codex/steering/repository-steering.md", ".codex/steering/testing-quality-gates-steering.md"):
    path = ROOT / relative
    require(path.is_file() and not path.is_symlink(), f"Missing project-owned file: {relative}")
    require("{{" not in path.read_text(), f"Unresolved template: {relative}")
    require(git("check-ignore", "-q", "--", relative).returncode == 1, f"Project guidance is ignored: {relative}")

manifest = json.loads((ROOT / "docs/reference/ai-central/provenance.json").read_text())
for relative, expected in manifest["files"].items():
    path = ROOT / "docs/reference/ai-central" / relative
    require(path.is_file(), f"Missing retained reference: {relative}")
    require(hashlib.sha256(path.read_bytes()).hexdigest() == expected, f"Reference hash mismatch: {relative}")

syntax = subprocess.run(["sh", "-n", str(ROOT / "scripts/setup-ai-context.sh")])
require(syntax.returncode == 0, "Invalid bootstrap shell syntax")
tracked = git("ls-files", "-z")
require(tracked.returncode == 0, "Unable to inspect tracked repository files")
for relative in filter(None, tracked.stdout.split("\0")):
    require(not relative.startswith((".agents/skills/", ".codex/skills/", ".review-runs/")),
            f"Machine-local context or review artifacts are tracked: {relative}")

if args.ci:
    print(f"Verified committed project steering, {len(manifest['files'])} reference hashes, shell syntax, and tracked-file boundaries (CI mode).")
    raise SystemExit(0)

installed = ROOT / ".agents/skills"
require(installed.is_dir(), "Missing skills; run sh scripts/setup-ai-context.sh")
for name, source_relative in manifest["installed_skills"].items():
    link = installed / name
    require(link.is_symlink() and (link / "SKILL.md").is_file(), f"Missing/broken skill: {name}")
    resolved = link.resolve()
    require(resolved.as_posix().endswith("/" + source_relative), f"Unexpected skill target: {name}")
    source_root = resolved
    for _ in Path(source_relative).parts:
        source_root = source_root.parent
    require((source_root / "templates/catalog.json").is_file(), f"Invalid AI Central checkout: {name}")
    compat = ROOT / ".codex/skills" / name
    require(compat.is_symlink() and compat.resolve() == resolved, f"Broken compatibility link: {name}")
    for path in (link, compat):
        relative = str(path.relative_to(ROOT))
        require(git("check-ignore", "-q", "--", relative).returncode == 0, f"Local link not ignored: {relative}")

print(f"Verified project steering, {len(manifest['files'])} reference hashes, and {len(manifest['installed_skills'])} skills with compatibility links and Git exclusions.")
