#!/usr/bin/env bash
# Sổ Săn Deal: put a new version of the code live (settings, database and pictures are kept).
#
#   sudo bash update.sh so-san-deal.tgz
#
# The previous version is kept in /opt/so-san-deal.prev; if the new one doesn't start, it is
# put back automatically.
set -euo pipefail

APP_DIR=/opt/so-san-deal
SERVICE=so-san-deal

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run with sudo: sudo bash $0 $*"
APP_TGZ="${1:-}"
[ -n "$APP_TGZ" ] && [ -f "$APP_TGZ" ] || die "give the app archive: sudo bash $0 so-san-deal.tgz"
[ -d "$APP_DIR" ] || die "not installed yet: run setup.sh first"
APP_TGZ=$(realpath "$APP_TGZ")

say "Unpacking and installing"
NEW="$APP_DIR.new"
rm -rf "$NEW"; mkdir -p "$NEW"
tar -xzf "$APP_TGZ" -C "$NEW"
[ -f "$NEW/package.json" ] && [ -f "$NEW/src/server.js" ] || die "$APP_TGZ is not a Sổ Săn Deal archive"
(cd "$NEW" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R root:root "$NEW"

say "Switching to the new version"
rm -rf "$APP_DIR.prev"
mv "$APP_DIR" "$APP_DIR.prev"
mv "$NEW" "$APP_DIR"
systemctl restart $SERVICE
for i in $(seq 1 30); do curl -fsS http://127.0.0.1:3000/api/lists >/dev/null 2>&1 && break; sleep 1; done
if ! curl -fsS http://127.0.0.1:3000/api/lists >/dev/null; then
  journalctl -u $SERVICE -n 30 --no-pager
  say "The new version did not start: putting the previous one back"
  rm -rf "$APP_DIR.failed"; mv "$APP_DIR" "$APP_DIR.failed"; mv "$APP_DIR.prev" "$APP_DIR"
  systemctl restart $SERVICE
  die "update failed (the old version is running again; the failed one is in $APP_DIR.failed)"
fi
say "Updated and running"
