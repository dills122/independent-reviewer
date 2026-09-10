#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage: support/collect-bug-report-info.sh [options]

Collect review-before-sharing metadata for a public bug report. The command
does not upload anything or include source, diff contents, changed paths, or
untracked-file contents.

Options:
  --repo <path>        Target Git repository (default: current directory)
  --base <ref>         Changeset base; otherwise infer the remote-default merge base
  --public-url <url>   Public HTTPS clone URL to include intentionally
  --help               Show this help

Example:
  support/collect-bug-report-info.sh --repo /path/to/target
EOF
}

fail() {
  printf 'collect-bug-report-info: %s\n' "$1" >&2
  exit 2
}

repo=.
base_ref=
public_url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo | --base | --public-url)
      [ "$#" -ge 2 ] || fail "$1 requires a value"
      case "$1" in
        --repo) repo=$2 ;;
        --base) base_ref=$2 ;;
        --public-url) public_url=$2 ;;
      esac
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

if [ -n "$public_url" ]; then
  case "$public_url" in
    https://*) ;;
    *) fail "--public-url must be an HTTPS URL that is safe to publish" ;;
  esac
  case "$public_url" in
    *[[:space:]]*) fail "--public-url must not contain whitespace" ;;
    *\?* | *\#*) fail "--public-url must not contain a query or fragment" ;;
  esac
  url_authority=${public_url#https://}
  url_authority=${url_authority%%/*}
  case "$url_authority" in
    '' | *@*) fail "--public-url must not contain credentials" ;;
  esac
fi

# Prevent ambient Git routing variables from redirecting reads to another
# repository. The helper never changes Git configuration or repository state.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY
unset GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR

repo_root=$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null) ||
  fail "--repo must identify a readable Git worktree"
head_commit=$(git -C "$repo_root" rev-parse --verify 'HEAD^{commit}' 2>/dev/null) ||
  fail "target repository has no HEAD commit"

if [ -n "$base_ref" ]; then
  base_commit=$(git -C "$repo_root" rev-parse --verify "${base_ref}^{commit}" 2>/dev/null) ||
    fail "--base does not resolve to a commit"
  base_method="explicit --base"
else
  remote_default=$(git -C "$repo_root" symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || true)
  if [ -n "$remote_default" ]; then
    base_commit=$(git -C "$repo_root" merge-base HEAD "$remote_default" 2>/dev/null) ||
      fail "unable to find a merge base with the remote default; pass --base"
    base_method="merge base with remote default"
  else
    base_commit=$head_commit
    base_method="HEAD fallback; pass --base to describe committed changes"
  fi
fi

status=$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all 2>/dev/null) ||
  fail "unable to read target working-tree status"
if [ -n "$status" ]; then
  worktree_state=dirty
else
  worktree_state=clean
fi

staged_count=$(printf '%s\n' "$status" | awk 'length($0) >= 2 && substr($0,1,1) != " " && substr($0,1,1) != "?" { count++ } END { print count + 0 }')
unstaged_count=$(printf '%s\n' "$status" | awk 'length($0) >= 2 && substr($0,2,1) != " " && substr($0,2,1) != "?" { count++ } END { print count + 0 }')
untracked_count=$(printf '%s\n' "$status" | awk 'substr($0,1,2) == "??" { count++ } END { print count + 0 }')

diff_summary=$(git -C "$repo_root" diff --shortstat --no-ext-diff --no-textconv "$base_commit" -- 2>/dev/null) ||
  fail "unable to summarize tracked changes"
[ -n "$diff_summary" ] || diff_summary="no tracked changes"

if command -v shasum >/dev/null 2>&1; then
  diff_digest=$(git -C "$repo_root" diff --binary --full-index --no-ext-diff --no-textconv "$base_commit" -- |
    shasum -a 256 | awk '{ print $1 }')
elif command -v sha256sum >/dev/null 2>&1; then
  diff_digest=$(git -C "$repo_root" diff --binary --full-index --no-ext-diff --no-textconv "$base_commit" -- |
    sha256sum | awk '{ print $1 }')
else
  diff_digest="unavailable (no shasum or sha256sum)"
fi

tool_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
tool_commit=$(git -C "$tool_root" rev-parse --verify 'HEAD^{commit}' 2>/dev/null || printf unavailable)
tool_status=$(git -C "$tool_root" status --porcelain=v1 --untracked-files=all 2>/dev/null || printf unknown)
if [ -z "$tool_status" ]; then
  tool_state=clean
else
  tool_state=dirty
fi

node_version=$(node --version 2>/dev/null || printf unavailable)
npm_version=$(npm --version 2>/dev/null || printf unavailable)
git_version=$(git --version 2>/dev/null || printf unavailable)
os_name=$(uname -s 2>/dev/null || printf unavailable)
os_arch=$(uname -m 2>/dev/null || printf unavailable)
generated_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
[ -n "$public_url" ] || public_url="not provided"

cat <<EOF
## Bug-report Git capture

- Capture format: 1
- Generated (UTC): $generated_at
- Independent Reviewer commit: $tool_commit
- Independent Reviewer checkout: $tool_state
- Target public URL: $public_url
- Target base commit: $base_commit
- Base selection: $base_method
- Target HEAD commit: $head_commit
- Target working tree: $worktree_state
- Staged entries: $staged_count
- Unstaged entries: $unstaged_count
- Untracked entries: $untracked_count
- Tracked change summary: $diff_summary
- Tracked diff SHA-256: $diff_digest
- OS/architecture: $os_name/$os_arch
- Node.js: $node_version
- npm: $npm_version
- Git: $git_version

Source contents included: no. Diff contents included: no. Changed paths included:
no. Untracked contents included or fingerprinted: no. Network requests or uploads:
none.

Review every line before posting. Repository URLs and commit IDs can still be
sensitive. A dirty working tree is not replayable from commit IDs alone; publish
a safe reproduction commit or attach a separately reviewed sanitized patch if
maintainers need the exact changes.
EOF
