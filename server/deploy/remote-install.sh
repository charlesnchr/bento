#!/usr/bin/env bash
# Runs as root on the server (invoked by scripts/deploy-server.sh with the
# staging directory as $1). Idempotent: safe to re-run on every deploy.
set -euo pipefail

STAGE=${1:?staging dir}
DOMAIN=bento.radian.dk
PORT=8787
SITE=/etc/nginx/sites-available/$DOMAIN
ENABLED=/etc/nginx/sites-enabled/$DOMAIN
CERT=/etc/letsencrypt/live/$DOMAIN/fullchain.pem

say() { printf '==> %s\n' "$*"; }

# 1. Port must be free or already ours.
if ss -Hltnp "sport = :$PORT" | grep -q . && ! ss -Hltnp "sport = :$PORT" | grep -q '"bento-sync"'; then
    echo "port $PORT is in use by another process:" >&2
    ss -Hltnp "sport = :$PORT" >&2
    exit 1
fi

# 2. System user, directories, token.
if ! id -u bento-sync >/dev/null 2>&1; then
    say "creating system user bento-sync"
    useradd --system --user-group --no-create-home --home-dir /nonexistent \
        --shell /usr/sbin/nologin bento-sync
fi
install -d -m 0755 -o root -g root /opt/bento-sync
install -d -m 0700 -o root -g root /etc/bento-sync
if [ ! -s /etc/bento-sync/token ]; then
    say "generating /etc/bento-sync/token"
    (umask 077 && openssl rand -hex 32 > /etc/bento-sync/token)
fi
chown root:root /etc/bento-sync/token
chmod 0600 /etc/bento-sync/token

# 3. Binary (atomic replace) and systemd units.
install -m 0755 "$STAGE/bento-sync" /opt/bento-sync/bento-sync.new
say "installing $(/opt/bento-sync/bento-sync.new --version)"
mv -f /opt/bento-sync/bento-sync.new /opt/bento-sync/bento-sync
for u in bento-sync.service bento-sync-backup.service bento-sync-backup.timer; do
    install -m 0644 "$STAGE/$u" "/etc/systemd/system/$u"
done
systemctl daemon-reload
systemctl enable --quiet bento-sync.service bento-sync-backup.timer
systemctl restart bento-sync.service
systemctl start bento-sync-backup.timer
ok=""
for _ in $(seq 1 50); do
    if curl -fsS "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 0.2
done
if [ -z "$ok" ]; then
    echo "bento-sync did not become healthy" >&2
    journalctl -u bento-sync.service -n 30 --no-pager >&2
    exit 1
fi
say "service healthy: $(curl -fsS "http://127.0.0.1:$PORT/v1/health")"

# 4. nginx site (+ certificate on first run).
reload_nginx() { nginx -t 2>&1 | tail -n 2 && systemctl reload nginx; }
PREV=""
if [ -e "$SITE" ]; then PREV="$STAGE/site.prev"; cp -a "$SITE" "$PREV"; fi
restore_site() {
    echo "nginx config test failed; restoring previous site config" >&2
    if [ -n "$PREV" ]; then cp -a "$PREV" "$SITE"; else rm -f "$SITE" "$ENABLED"; fi
    nginx -t >&2 || true
    exit 1
}
if [ ! -e "$CERT" ]; then
    say "no certificate yet: bootstrapping HTTP-only site and running certbot"
    install -m 0644 "$STAGE/nginx-bootstrap.conf" "$SITE"
    ln -sfn "$SITE" "$ENABLED"
    reload_nginx || restore_site
    certbot certonly --nginx -d "$DOMAIN" --non-interactive --agree-tos \
        --keep-until-expiring --deploy-hook "systemctl reload nginx"
fi
install -m 0644 "$STAGE/nginx-bento.radian.dk.conf" "$SITE"
ln -sfn "$SITE" "$ENABLED"
reload_nginx || restore_site

ok=""
for _ in $(seq 1 25); do
    if curl -fsS --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/v1/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 0.2
done
[ -n "$ok" ] || { echo "https://$DOMAIN/v1/health failed through nginx" >&2; exit 1; }
say "https://$DOMAIN/v1/health OK through nginx"
systemctl --no-pager --lines=0 status bento-sync.service | sed -n '1,5p'
