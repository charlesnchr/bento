#!/usr/bin/env bash
# Build bento-sync as a static aarch64 musl binary and (re)deploy it to the
# Hetzner box. Idempotent: run it again after any change in server/.
#
#   scripts/deploy-server.sh                      # test, build, deploy
#   scripts/deploy-server.sh --skip-tests         # build + deploy
#   scripts/deploy-server.sh --token-to local --token-to macbook
#                                                 # also copy the token to clients
#   scripts/deploy-server.sh --only-token --token-to local
#
# Env (or scripts/config.local.sh): BENTO_SYNC_DOMAIN, the server's public
# name (required, e.g. sync.example.com); BENTO_DEPLOY_HOST (default: hetzner,
# an ssh alias for root@server).
# Build: cargo-zigbuild (brew install zig && cargo install cargo-zigbuild),
#        falling back to Docker (rust:alpine, linux/arm64) if zigbuild is missing.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT/scripts/config.sh"
HOST=${BENTO_DEPLOY_HOST:-hetzner}
DOMAIN=${BENTO_SYNC_DOMAIN:-}
TARGET=aarch64-unknown-linux-musl
SRV=$ROOT/server
BIN=$SRV/target/$TARGET/release/bento-sync
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"

skip_tests=0 skip_build=0 only_token=0
token_dests=()
while [ $# -gt 0 ]; do
    case $1 in
        --skip-tests) skip_tests=1 ;;
        --skip-build) skip_build=1 ;;
        --only-token) only_token=1 ;;
        --token-to) token_dests+=("${2:?--token-to needs local or an ssh host}"); shift ;;
        -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
[[ $DOMAIN =~ ^[A-Za-z0-9.-]+$ ]] || { echo "set BENTO_SYNC_DOMAIN (e.g. in scripts/config.local.sh)" >&2; exit 2; }

build() {
    if [ $skip_tests = 0 ]; then
        say "cargo test"
        cargo test --quiet --manifest-path "$SRV/Cargo.toml"
    fi
    if command -v cargo-zigbuild >/dev/null && command -v zig >/dev/null; then
        say "building $TARGET with cargo-zigbuild"
        rustup target add "$TARGET" >/dev/null 2>&1 || true
        cargo zigbuild --release --target "$TARGET" --manifest-path "$SRV/Cargo.toml"
    elif docker info >/dev/null 2>&1; then
        say "building $TARGET in Docker (rust:alpine)"
        docker run --rm --platform linux/arm64 -v "$SRV":/src -w /src \
            -e CARGO_HOME=/src/target/.cargo-home rust:alpine \
            sh -c "apk add --no-cache musl-dev >/dev/null && cargo build --release --target $TARGET"
    else
        echo "need cargo-zigbuild+zig or a running Docker daemon to build" >&2
        exit 1
    fi
    file "$BIN" | grep -q 'ARM aarch64.*statically linked' || { file "$BIN"; echo "unexpected binary type" >&2; exit 1; }
    say "binary: $(du -h "$BIN" | cut -f1) $BIN"
}

STAGE=""
cleanup() { [ -z "$STAGE" ] || ssh "$HOST" "rm -rf '$STAGE'" || true; }
trap cleanup EXIT

deploy() {
    STAGE=$(ssh "$HOST" 'mktemp -d /tmp/bento-sync-deploy.XXXXXX')
    local stage=$STAGE
    say "uploading to $HOST:$stage"
    scp -q "$BIN" "$SRV"/deploy/bento-sync.service "$SRV"/deploy/bento-sync-backup.service \
        "$SRV"/deploy/bento-sync-backup.timer "$SRV"/deploy/nginx-bootstrap.conf \
        "$SRV"/deploy/nginx-site.conf "$SRV"/deploy/remote-install.sh "$HOST:$stage/"
    say "installing on $HOST"
    ssh "$HOST" "bash $stage/remote-install.sh $stage $DOMAIN"
}

# Copy the server token to ~/.config/bento/sync-token (0600, token only, no
# newline) on this Mac ("local") or another machine via ssh. Never printed.
install_token() {
    local dest=$1
    local put='umask 077; mkdir -p "$HOME/.config/bento" && cat > "$HOME/.config/bento/sync-token.tmp" && chmod 600 "$HOME/.config/bento/sync-token.tmp" && mv -f "$HOME/.config/bento/sync-token.tmp" "$HOME/.config/bento/sync-token"'
    if [ "$dest" = local ]; then
        ssh "$HOST" 'cat /etc/bento-sync/token' | tr -d '\n' | sh -c "$put"
    else
        ssh "$HOST" 'cat /etc/bento-sync/token' | tr -d '\n' | ssh "$dest" "sh -c '$put'"
    fi
    say "token installed on $dest:~/.config/bento/sync-token"
}

if [ $only_token = 0 ]; then
    [ $skip_build = 1 ] || build
    deploy
fi
for d in "${token_dests[@]+"${token_dests[@]}"}"; do install_token "$d"; done
say "done: https://$DOMAIN/v1/health -> $(curl -fsS "https://$DOMAIN/v1/health" || echo unreachable)"
