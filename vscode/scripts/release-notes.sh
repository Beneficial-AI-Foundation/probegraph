#!/usr/bin/env bash
# Print the "## [<version>]" section of CHANGELOG.md, without its heading.
# Exits 1 when there is no such section, so a release cannot ship without notes.
set -euo pipefail

version="${1:?usage: release-notes.sh <version>}"
changelog="$(dirname "$0")/../CHANGELOG.md"

notes="$(awk -v v="$version" '
  /^## \[/ { in_section = index($0, "[" v "]") > 0; next }
  in_section { print }
' "$changelog")"

if [ -z "$(printf '%s' "$notes" | tr -d '[:space:]')" ]; then
  echo "No '## [$version]' section in $changelog" >&2
  exit 1
fi

printf '%s\n' "$notes"
