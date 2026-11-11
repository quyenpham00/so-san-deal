#!/usr/bin/env bash
# Sổ Săn Deal: one-command setup on a fresh Ubuntu server (Oracle Cloud Always Free, or any VPS).
#
#   sudo bash setup.sh so-san-deal.tgz [--domain your.domain] [--data so-san-deal-data.tgz]
#
# Installs Node.js 22, the app (/opt/so-san-deal), its data folder (/var/lib/so-san-deal),
# a systemd service (starts on boot, restarts on crash), Caddy in front (automatic HTTPS when a
# domain is given), firewall rules for ports 80/443, and a daily database backup.
# Safe to run again: keeps the existing settings and admin password.
#
# For a quick test inside a container without systemd: SKIP_SYSTEM=1 sudo bash setup.sh app.tgz
set -euo pipefail

APP_DIR=/opt/so-san-deal
DATA_DIR=/var/lib/so-san-deal
ENV_FILE=/etc/so-san-deal/env
SERVICE=so-san-deal
RUN_USER=sosan
NODE_MIN=22.13

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

APP_TGZ="" DOMAIN="" DATA_TGZ=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --data) DATA_TGZ="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) [ -z "$APP_TGZ" ] && APP_TGZ="$1" || die "unexpected argument: $1"; shift ;;
  esac
done
[ "$(id -u)" = 0 ] || die "run with sudo: sudo bash $0 $*"
[ -n "$APP_TGZ" ] && [ -f "$APP_TGZ" ] || die "give the app archive: sudo bash $0 so-san-deal.tgz [--domain x] [--data y]"
[ -z "$DATA_TGZ" ] || [ -f "$DATA_TGZ" ] || die "data archive not found: $DATA_TGZ"
if [ -n "$DOMAIN" ] && ! [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then die "not a domain name: $DOMAIN"; fi
command -v apt-get >/dev/null || die "this script is for Ubuntu / Debian"
APP_TGZ=$(realpath "$APP_TGZ"); [ -z "$DATA_TGZ" ] || DATA_TGZ=$(realpath "$DATA_TGZ")
export DEBIAN_FRONTEND=noninteractive

say "System packages"
apt-get update -y -q
apt-get install -y -q curl ca-certificates gnupg sqlite3 openssl tar gzip >/dev/null

say "Node.js 22"
node_ok() { command -v node >/dev/null && node -e "const [a,b]=process.versions.node.split('.').map(Number),[x,y]='$NODE_MIN'.split('.').map(Number);process.exit(a>x||(a===x&&b>=y)?0:1)"; }
if ! node_ok; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -q nodejs >/dev/null
fi
node_ok || die "Node.js $NODE_MIN or newer is needed, found $(node -v 2>/dev/null || echo none)"
echo "node $(node -v), npm $(npm -v)"

say "User and folders"
id "$RUN_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$RUN_USER"
mkdir -p "$DATA_DIR/images" "$DATA_DIR/backups" "$(dirname "$ENV_FILE")"

say "App code"
NEW="$APP_DIR.new"
rm -rf "$NEW"; mkdir -p "$NEW"
tar -xzf "$APP_TGZ" -C "$NEW"
[ -f "$NEW/package.json" ] && [ -f "$NEW/src/server.js" ] || die "$APP_TGZ is not a Sổ Săn Deal archive (made with: npm run deploy:pack)"
(cd "$NEW" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
# sharp ships a prebuilt image library per platform: make sure this machine's one works
(cd "$NEW" && node -e "import('sharp').then(s=>s.default({create:{width:2,height:2,channels:3,background:'#fff'}}).webp().toBuffer()).then(()=>console.log('sharp ok'))") \
  || die "the image library (sharp) does not work on this machine"
if [ -d "$APP_DIR" ]; then rm -rf "$APP_DIR.prev"; mv "$APP_DIR" "$APP_DIR.prev"; fi
mv "$NEW" "$APP_DIR"
chown -R root:root "$APP_DIR"

say "Settings ($ENV_FILE)"
NEW_PASSWORD=""
if [ ! -f "$ENV_FILE" ]; then
  NEW_PASSWORD=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20)
  cat > "$ENV_FILE" <<EOF
# Sổ Săn Deal settings. After editing: sudo systemctl restart $SERVICE
PORT=3000
HOST=127.0.0.1
ADMIN_PASSWORD=$NEW_PASSWORD
SESSION_SECRET=$(openssl rand -hex 32)
DB_PATH=$DATA_DIR/so-san-deal.db
IMAGES_DIR=$DATA_DIR/images
COOKIE_SECURE=$([ -n "$DOMAIN" ] && echo 1 || echo 0)
MAX_UPLOAD_MB=40
CONFIRM_VOTES=2
# Caddy runs on this machine, so client IPs come from it
TRUST_PROXY=loopback
EOF
  echo "created, with a new admin password"
else
  # keep the existing password and secret; only follow the HTTPS choice
  if [ -n "$DOMAIN" ]; then sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=1/' "$ENV_FILE"; fi
  echo "kept the existing settings"
fi
chmod 600 "$ENV_FILE"; chown root:root "$ENV_FILE"

if [ -n "$DATA_TGZ" ]; then
  say "Data (database + pictures)"
  [ "${SKIP_SYSTEM:-0}" = 1 ] || systemctl stop "$SERVICE" 2>/dev/null || true
  if [ -f "$DATA_DIR/so-san-deal.db" ]; then
    KEEP="$DATA_DIR/backups/before-import-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$KEEP"; mv "$DATA_DIR"/so-san-deal.db* "$KEEP"/; [ -d "$DATA_DIR/images" ] && mv "$DATA_DIR/images" "$KEEP/images"
    echo "the previous database and pictures were moved to $KEEP"
  fi
  tar -xzf "$DATA_TGZ" -C "$DATA_DIR"
  mkdir -p "$DATA_DIR/images"
fi
chown -R "$RUN_USER:$RUN_USER" "$DATA_DIR"

if [ "${SKIP_SYSTEM:-0}" = 1 ]; then
  say "Smoke test (SKIP_SYSTEM=1: no service, proxy or firewall)"
  set -a; . "$ENV_FILE"; set +a
  # the whole background job is detached from this script's output, so the script can end
  (cd "$APP_DIR" && exec runuser -u "$RUN_USER" -- node src/server.js) </dev/null >/tmp/so-san-deal.log 2>&1 &
  for i in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/api/lists" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS "http://127.0.0.1:$PORT/api/lists" >/dev/null || { cat /tmp/so-san-deal.log; die "the app did not answer"; }
  echo "app answers on http://127.0.0.1:$PORT"
  [ -z "$NEW_PASSWORD" ] || echo "admin password: $NEW_PASSWORD"
  exit 0
fi

say "Service ($SERVICE)"
cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Sổ Săn Deal
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) src/server.js
Restart=always
RestartSec=3
# hardening: the app may only write its data folder
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DATA_DIR
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now $SERVICE >/dev/null
systemctl restart $SERVICE
for i in $(seq 1 30); do curl -fsS http://127.0.0.1:3000/api/lists >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:3000/api/lists >/dev/null || { journalctl -u $SERVICE -n 40 --no-pager; die "the app did not start (log above)"; }
echo "running"

say "Caddy (web server in front, HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y -q && apt-get install -y -q caddy >/dev/null
fi
SITE=${DOMAIN:-:80}
cat > /etc/caddy/Caddyfile <<EOF
# Sổ Săn Deal. With a domain name, Caddy gets and renews the HTTPS certificate by itself.
$SITE {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
}
EOF
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "Firewall (ports 80 and 443)"
# Oracle's Ubuntu images block everything but SSH in iptables; the cloud "security list" is separate.
if command -v iptables >/dev/null && iptables -S INPUT 2>/dev/null | grep -q -- '-j REJECT'; then
  for port in 80 443; do
    if ! iptables -C INPUT -p tcp --dport $port -m state --state NEW -j ACCEPT 2>/dev/null; then
      pos=$(iptables -L INPUT --line-numbers -n | awk '$2=="REJECT"{print $1; exit}')
      iptables -I INPUT "${pos:-1}" -p tcp --dport $port -m state --state NEW -j ACCEPT
    fi
  done
  if command -v netfilter-persistent >/dev/null; then netfilter-persistent save >/dev/null 2>&1 || true
  else apt-get install -y -q iptables-persistent >/dev/null && netfilter-persistent save >/dev/null 2>&1 || true; fi
  echo "opened 80 and 443 in iptables"
elif command -v ufw >/dev/null && ufw status | grep -q active; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; echo "opened 80 and 443 in ufw"
else
  echo "no local firewall rules needed"
fi

say "Daily database backup (keeps 14 days)"
cat > /etc/cron.daily/so-san-deal-backup <<EOF
#!/bin/sh
# consistent copy of the live database, then drop copies older than 14 days
sqlite3 $DATA_DIR/so-san-deal.db ".backup '$DATA_DIR/backups/db-\$(date +%F).db'" && chown $RUN_USER:$RUN_USER $DATA_DIR/backups/db-*.db
find $DATA_DIR/backups -name 'db-*.db' -mtime +14 -delete
EOF
chmod 755 /etc/cron.daily/so-san-deal-backup

IP=$(curl -fsS -4 --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
say "Done"
if [ -n "$DOMAIN" ]; then
  echo "Site:   https://$DOMAIN   (first visit may take ~30 s while Caddy gets the certificate)"
  echo "Admin:  https://$DOMAIN/admin"
  echo "(the domain must point to this server's IP: $IP)"
else
  echo "Site:   http://$IP"
  echo "Admin:  http://$IP/admin"
  echo "Without a domain there is no HTTPS: the admin password travels unencrypted. Add one later with:"
  echo "        sudo bash setup.sh <app.tgz> --domain your.domain"
fi
if [ -n "$NEW_PASSWORD" ]; then
  echo
  echo "Admin password: $NEW_PASSWORD"
  echo "(save it now; it is also in $ENV_FILE, readable with: sudo cat $ENV_FILE)"
fi
echo
echo "Logs:     sudo journalctl -u $SERVICE -f"
echo "Restart:  sudo systemctl restart $SERVICE"
echo "Update:   sudo bash update.sh so-san-deal.tgz"
