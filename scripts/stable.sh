#!/usr/bin/env bash
# Runs the copy of acocrew that people actually use, apart from this checkout.
# It copies this checkout to ~/acocrew-stable, builds it there, and (re)starts it in the tmux session
# `acocrew-stable`. Editing or building this checkout afterwards does not touch the running copy.
# It runs with ACOCREW_HTTPS=1: people reach it through an https address, so the login cookie is for https only.
# Run it again to update. That restarts the server, so anything Claude is doing in a thread is cut short.
set -euo pipefail

src="$(cd "$(dirname "$0")/.." && pwd)"
dest="$HOME/acocrew-stable"

rsync -a --delete --exclude node_modules --exclude .git --exclude dist --exclude logbooks "$src/" "$dest/"
cd "$dest"
pnpm install --frozen-lockfile
pnpm build

tmux kill-session -t acocrew-stable 2>/dev/null || true
tmux new-session -d -s acocrew-stable -c "$dest" "PORT=${PORT:-5280} ACOCREW_HTTPS=1 node apps/server/src/main.ts"
echo "acocrew is running on http://127.0.0.1:${PORT:-5280} (tmux session: acocrew-stable)"
