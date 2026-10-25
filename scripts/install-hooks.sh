#!/usr/bin/env bash
# Installs small dispatcher hooks into the repository's shared hooks directory.
# Run once per clone (the `prepare` script does it on install). Worktrees need no
# install of their own: they all share that one directory, and the dispatcher
# looks for the calling worktree's .githooks at run time.
set -euo pipefail

# e.g. the built copy in ~/acobot-stable, which has no .git: nothing to install.
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

hooks="$(git rev-parse --path-format=absolute --git-common-dir)/hooks"
mkdir -p "$hooks"

for name in pre-commit pre-push; do
  cat >"$hooks/$name" <<'DISPATCH'
#!/bin/sh
# Managed by scripts/install-hooks.sh. Edit .githooks/<hook> instead.
# Every worktree uses the main checkout's hooks directory, so this one file
# serves all of them, including ones made later.
hook=$(basename "$0")
top=$(git rev-parse --show-toplevel) || exit 0
main=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")

# The calling worktree's own copy first, then the main checkout's, so worktrees
# on branches that predate .githooks/ are checked instead of silently passing.
for dir in "$top/.githooks" "$main/.githooks"; do
  if [ -x "$dir/$hook" ]; then
    exec "$dir/$hook" "$@"
  fi
done
exit 0
DISPATCH
  chmod +x "$hooks/$name"
done

echo "git hooks installed in $hooks (shared by all worktrees)"
