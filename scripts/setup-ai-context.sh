#!/bin/sh
set -eu
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
source_root=${AI_CENTRAL_HOME:-"$project_root/../ai-central"}
case "$source_root" in */templates) source_root=${source_root%/templates} ;; esac
source_root=$(CDPATH= cd -- "$source_root" && pwd -P)
case "$#:$*" in 0:) ;; 1:--dry-run) ;; *) echo "Usage: $0 [--dry-run]" >&2; exit 2 ;; esac
"$source_root/scripts/setup-ai-context.sh" "$project_root" --yes --mode link \
  --profiles base --bundles core,orchestration,documentation,delivery,engineering,planning "$@"
if [ "$#" -ne 0 ]; then exit 0; fi
exclude_file=$(git -C "$project_root" rev-parse --path-format=absolute --git-path info/exclude)
mkdir -p "$(dirname -- "$exclude_file")"
touch "$exclude_file"
for link in "$project_root"/.agents/skills/*; do
  [ -L "$link" ] || continue
  target=$(readlink "$link")
  case "$target" in "$source_root"/*) ;; *) continue ;; esac
  name=${link##*/}
  for relative in ".agents/skills/$name" ".codex/skills/$name"; do
    [ -L "$project_root/$relative" ] || continue
    if git -C "$project_root" ls-files --error-unmatch -- "$relative" >/dev/null 2>&1; then
      echo "Preserving tracked path: $relative" >&2
      continue
    fi
    pattern="/$relative"
    if ! grep -Fqx -- "$pattern" "$exclude_file"; then
      printf '\n%s\n' "$pattern" >> "$exclude_file"
    fi
  done
done
python3 -B "$project_root/scripts/check-ai-context.py"
