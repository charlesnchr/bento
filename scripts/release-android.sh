#!/bin/bash
# Publish an Android release: build and sign the APK, tag it android-vX.Y.Z and
# upload it to a GitHub release. Installed apps find it with their daily update
# check (Settings → Updates). The Mac's releases (vX.Y.Z) stay "Latest".
#
#   scripts/release-android.sh 0.1.0            release main as android-v0.1.0
#   scripts/release-android.sh 0.1.0 --dry-run  build and sign into dist/ only
#
# Needs a clean main matching origin, gh logged in with push access, the Android
# SDK (ANDROID_HOME, or ~/android-toolchain/env.sh) and the release keystore
# described by ~/.config/bento/android-signing.properties (or
# $BENTO_ANDROID_SIGNING): every release is signed with the same key, or phones
# can't update over the previous version.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REPO=charlesnchr/bento

die() { echo "error: $*" >&2; exit 1; }
say() { printf '\033[1m==> %s\033[0m\n' "$*"; }

VERSION="${1:-}"; DRY=0
case "${2:-}" in --dry-run) DRY=1 ;; "") ;; *) die "unknown option $2" ;; esac
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: scripts/release-android.sh X.Y.Z [--dry-run]" >&2; exit 2; }
TAG="android-v$VERSION"
SIGNING="${BENTO_ANDROID_SIGNING:-$HOME/.config/bento/android-signing.properties}"
APK="$ROOT/dist/Bento-$VERSION.apk"

[ -f "$SIGNING" ] || die "no signing config at $SIGNING"
# Run Gradle inside the scoped toolchain when there is one (see android/README.md).
RUN=()
[ -z "${ANDROID_HOME:-}" ] && [ -x "$HOME/android-toolchain/env.sh" ] && RUN=("$HOME/android-toolchain/env.sh")
GRADLE=(./gradlew)
command -v gradle >/dev/null 2>&1 && GRADLE=(gradle)
[ ${#RUN[@]} -gt 0 ] && ${RUN[@]+"${RUN[@]}"} sh -c 'command -v gradle' >/dev/null 2>&1 && GRADLE=(gradle)

if [ "$DRY" = 0 ]; then
  [ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "not on main"
  [ -z "$(git status --porcelain)" ] || die "uncommitted changes"
  git fetch -q origin main --tags
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main doesn't match origin/main"
  ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "$TAG already exists"
  latest="$(git tag --list 'android-v[0-9]*' | sed 's/^android-v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"
  if [ -n "$latest" ]; then
    newest="$(printf '%s\n%s\n' "$latest" "$VERSION" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"
    [ "$newest" = "$VERSION" ] && [ "$latest" != "$VERSION" ] || die "$VERSION is not newer than $latest"
  fi
fi

say "test and build $VERSION"
(cd android && BENTO_ANDROID_SIGNING="$SIGNING" ${RUN[@]+"${RUN[@]}"} "${GRADLE[@]}" --console=plain -q \
  :core:test :app:testReleaseUnitTest :app:assembleRelease -PbentoVersion="$VERSION")
OUT="android/app/build/outputs/apk/release/app-release.apk"
[ -f "$OUT" ] || die "no release APK (is the keystore configured?)"
mkdir -p dist
cp "$OUT" "$APK"
${RUN[@]+"${RUN[@]}"} apksigner verify --print-certs "$APK" | grep -q "Signer #1 certificate SHA-256" || die "$APK isn't signed"
SHA="$(sha256sum "$APK" | cut -d' ' -f1)"

if [ "$DRY" = 1 ]; then
  say "dry run done: $APK (sha256 $SHA)"
  exit 0
fi

say "tag and release $TAG"
git tag -a "$TAG" -m "Bento for Android $VERSION"
git push -q origin "$TAG"
prev="$(git tag --list 'android-v[0-9]*' | grep -vx "$TAG" | sort -V | tail -1 || true)"
gh release create "$TAG" "$APK" --repo "$REPO" --verify-tag --latest=false \
  --title "Bento for Android $VERSION" --generate-notes ${prev:+--notes-start-tag "$prev"}

say "done: Bento for Android $VERSION (phones offer it under Settings → Updates)"
