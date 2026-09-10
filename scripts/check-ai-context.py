#!/usr/bin/env python3
"""Verify local AI Central integration without executing imported skills."""
from pathlib import Path
import argparse
import hashlib
import json
import re
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

project_guidance = (
    "AGENTS.md",
    ".codex/steering/repository-steering.md",
    ".codex/steering/testing-quality-gates-steering.md",
    ".codex/steering/javascript-typescript-resolution.md",
)
for relative in project_guidance:
    path = ROOT / relative
    require(path.is_file() and not path.is_symlink(), f"Missing project-owned file: {relative}")
    require("{{" not in path.read_text(), f"Unresolved template: {relative}")
    require(git("check-ignore", "-q", "--", relative).returncode == 1, f"Project guidance is ignored: {relative}")

agents_text = (ROOT / "AGENTS.md").read_text()
require("When CCE tools are available" in agents_text, "AGENTS.md must make CCE use conditional on tool availability")
require("When CCE tools are unavailable" in agents_text, "AGENTS.md must define the filesystem-search fallback")

resolution_text = (ROOT / ".codex/steering/javascript-typescript-resolution.md").read_text()
require("repository root" in resolution_text, "JavaScript/TypeScript steering must define its project scope")
for command in ("npm run format:check", "npm run lint", "npm run typecheck", "npm test", "npm run build", "npm audit"):
    require(f"`{command}`" in resolution_text,
            f"JavaScript/TypeScript steering is missing command mapping: {command}")

manifest = json.loads((ROOT / "docs/reference/ai-central/provenance.json").read_text())
setup_text = (ROOT / "scripts/setup-ai-context.sh").read_text()
profiles = re.search(r"--profiles ([a-z0-9,-]+)", setup_text)
bundles = re.search(r"--bundles ([a-z0-9,-]+)", setup_text)
require(profiles is not None and profiles.group(1).split(",") == manifest["profiles"],
        "Setup profiles disagree with retained provenance")
require(bundles is not None and bundles.group(1).split(",") == manifest["bundles"],
        "Setup bundles disagree with retained provenance")
for relative, expected in manifest["files"].items():
    path = ROOT / "docs/reference/ai-central" / relative
    require(path.is_file(), f"Missing retained reference: {relative}")
    require(hashlib.sha256(path.read_bytes()).hexdigest() == expected, f"Reference hash mismatch: {relative}")

for relative in ("scripts/setup-ai-context.sh", "support/collect-bug-report-info.sh"):
    syntax = subprocess.run(["sh", "-n", str(ROOT / relative)])
    require(syntax.returncode == 0, f"Invalid shell syntax: {relative}")
tracked = git("ls-files", "-z")
require(tracked.returncode == 0, "Unable to inspect tracked repository files")
for relative in filter(None, tracked.stdout.split("\0")):
    require(not relative.startswith((".agents/skills/", ".codex/skills/", ".review-runs/"))
            and relative != ".codex/steering/javascript-typescript-steering.md",
            f"Machine-local context or review artifacts are tracked: {relative}")

if args.ci:
    print(f"Verified committed project steering, {len(manifest['files'])} reference hashes, shell syntax, and tracked-file boundaries (CI mode).")
    raise SystemExit(0)

installed = ROOT / ".agents/skills"
require(installed.is_dir(), "Missing skills; run sh scripts/setup-ai-context.sh")
language_steering = ROOT / ".codex/steering/javascript-typescript-steering.md"
require(language_steering.is_symlink() and language_steering.is_file(),
        "Missing JavaScript/TypeScript steering; run sh scripts/setup-ai-context.sh")
require(git("check-ignore", "-q", "--", str(language_steering.relative_to(ROOT))).returncode == 0,
        "JavaScript/TypeScript steering link is not ignored")
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
