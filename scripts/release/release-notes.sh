#!/usr/bin/env bash
# Prints the release notes for a tag: the CHANGELOG.md section of its version. A release candidate (0.5.0-rc.3) gets the
# section of the release it leads to (0.5.0). Used by release.yml.
#   scripts/public/release-notes.sh v0.5.0 [CHANGELOG.md]
set -euo pipefail
tag="${1:?usage: release-notes.sh <tag> [changelog]}"
file="${2:-CHANGELOG.md}"
version="${tag#v}"
base="${version%%-*}"
section="$(awk -v v="$base" '
  $0 == "## " v { on = 1; next }
  /^## / { if (on) exit }
  on { print }
' "$file" | sed '/./,$!d' | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')"
if [ -z "$section" ]; then
  echo "See [CHANGELOG.md](https://github.com/provelox/provelox/blob/main/CHANGELOG.md)."
else
  [ "$version" != "$base" ] && printf 'Release candidate of %s. Not for production.\n\n' "$base"
  printf '%s\n' "$section"
fi
printf '\n---\n\nImage: `ghcr.io/provelox/provelox:%s`\n' "$version"
