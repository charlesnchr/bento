#!/bin/bash
# Publish a release: build and sign Bento.app, tag it, upload it to a GitHub
# release and point the Homebrew formula in charlesnchr/homebrew-tap at it.
# Installed copies find it with their daily update check (or `brew upgrade`).
#
#   scripts/release.sh 0.2.0            release main as v0.2.0
#   scripts/release.sh 0.2.0 --dry-run  build, sign, archive and render the
#                                       formula into dist/ only
#
# Needs a clean main matching origin, gh logged in with push access to both
# repos, and BENTO_SIGN_IDENTITY (scripts/config.sh): every release is signed
# with the same certificate, so updates keep the permission grants.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
. "$ROOT/scripts/config.sh"

REPO=charlesnchr/bento
TAP=charlesnchr/homebrew-tap

die() { echo "error: $*" >&2; exit 1; }
say() { printf '\033[1m==> %s\033[0m\n' "$*"; }

VERSION="${1:-}"; DRY=0
case "${2:-}" in --dry-run) DRY=1 ;; "") ;; *) die "unknown option $2" ;; esac
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: scripts/release.sh X.Y.Z [--dry-run]" >&2; exit 2; }
TAG="v$VERSION"
APP="$ROOT/dist/Bento.app"
ZIP="$ROOT/dist/Bento-$VERSION.zip"

[ -n "$BENTO_SIGN_IDENTITY" ] || die "BENTO_SIGN_IDENTITY is not set; releases need the persistent identity"
if [ "$DRY" = 0 ]; then
  [ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "not on main"
  [ -z "$(git status --porcelain)" ] || die "uncommitted changes"
  git fetch -q origin main --tags
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main doesn't match origin/main"
  ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "$TAG already exists"
  latest="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || true)"
  latest="${latest#v}"
  if [ -n "$latest" ]; then
    newest="$(printf '%s\n%s\n' "$latest" "$VERSION" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"
    [ "$newest" = "$VERSION" ] && [ "$latest" != "$VERSION" ] || die "$VERSION is not newer than $latest"
  fi
  [ "$(gh repo view "$REPO" --json visibility -q .visibility)" = PUBLIC ] \
    || die "$REPO is private, so Homebrew can't download its release assets"
fi

say "build $VERSION"
BENTO_VERSION="$VERSION" "$ROOT/scripts/build.sh"
codesign -d -r- "$APP" 2>&1 | grep -q "certificate leaf" || die "Bento.app isn't signed with the persistent identity"

say "archive"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
SHA="$(shasum -a 256 "$ZIP" | cut -d' ' -f1)"
FORMULA="$(sed -e "s/@VERSION@/$VERSION/g" -e "s/@SHA256@/$SHA/g" "$ROOT/packaging/bento.rb")"

if [ "$DRY" = 1 ]; then
  printf '%s\n' "$FORMULA" > "$ROOT/dist/bento.rb"
  say "dry run done: $ZIP (sha256 $SHA), formula in dist/bento.rb"
  exit 0
fi

say "tag and release $TAG"
git tag -a "$TAG" -m "Bento $VERSION"
git push -q origin "$TAG"
gh release create "$TAG" "$ZIP" --repo "$REPO" --verify-tag --title "Bento $VERSION" --generate-notes

say "formula -> $TAP"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
gh repo clone "$TAP" "$TMP/tap" -- -q --depth 1
mkdir -p "$TMP/tap/Formula"
printf '%s\n' "$FORMULA" > "$TMP/tap/Formula/bento.rb"
git -C "$TMP/tap" add Formula/bento.rb
git -C "$TMP/tap" commit -q -m "bento $VERSION"
git -C "$TMP/tap" push -q origin HEAD

say "done: Bento $VERSION (brew upgrade bento, or Install from Bento's menu)"
