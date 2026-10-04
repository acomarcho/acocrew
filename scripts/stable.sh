#!/usr/bin/env bash
# Runs the copy of acocrew that people actually use, apart from this checkout.
# It copies this checkout to ~/acocrew-stable, builds it there, and (re)starts it as the systemd user service
# `acocrew-stable`. Editing or building this checkout afterwards does not touch the running copy.
# systemd starts it again when it crashes and when the machine boots. Automations count on that: a run is
# skipped when the server is off at its time.
# It runs with ACOCREW_HTTPS=1: people reach it through an https address, so the login cookie is for https only.
# Run it again to update. That restarts the server, so anything Claude is doing in a thread is cut short.
#
#   Is it up:    systemctl --user status acocrew-stable
#   Its output:  journalctl --user -u acocrew-stable -f
#
# ACOCREW_NAME, PORT and ACOCREW_DB give a second copy its own name, port and data (to try this script out).
set -euo pipefail

src="$(cd "$(dirname "$0")/.." && pwd)"
name="${ACOCREW_NAME:-acocrew-stable}"
dest="$HOME/$name"
port="${PORT:-5280}"

rsync -a --delete --exclude node_modules --exclude .git --exclude dist --exclude logbooks "$src/" "$dest/"
cd "$dest"
pnpm install --frozen-lockfile
pnpm build

# A service does not get what a shell sets up. Claude needs the same tools on its PATH as the shell that ran
# this script, and the same folder for temporary files. Anything else it should have (tokens, for example) goes
# in ~/.acocrew/env, one NAME=value per line.
# node is named by where it really is: the folder a version manager puts on the PATH can be gone after a reboot.
# pnpm puts this checkout's own tools on the PATH of the scripts it runs. Those are left out, or Claude would
# find them first in every repository.
node="$(realpath "$(command -v node)")"
path="$(tr ':' '\n' <<<"$PATH" | grep -v /node_modules/ | paste -sd:)"
unit="$HOME/.config/systemd/user/$name.service"
mkdir -p "$(dirname "$unit")"
cat >"$unit" <<EOF
[Unit]
Description=acocrew ($name)

[Service]
WorkingDirectory=$dest
Environment="PATH=$(dirname "$node"):$path"
Environment=PORT=$port ACOCREW_HTTPS=1
${TMPDIR:+Environment="TMPDIR=$TMPDIR"}
${ACOCREW_DB:+Environment="ACOCREW_DB=$ACOCREW_DB"}
EnvironmentFile=-$HOME/.acocrew/env
ExecStart=$node apps/server/src/main.ts
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --quiet "$name"
# Lets the service start at boot, before anyone has logged in.
loginctl enable-linger "$USER"
echo "acocrew runs on http://127.0.0.1:$port (systemd user service: $name)"
# The restart comes last. When this script is run by Claude in a thread of the copy being restarted, the
# restart ends the script too. systemd carries on with the restart by itself.
systemctl --user restart "$name"
# Before it was a service, it ran in a tmux session of the same name, which still holds the port. The service
# keeps trying until the port is free. The `=` is for that exact name only.
tmux kill-session -t "=$name" 2>/dev/null || true
