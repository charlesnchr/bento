#!/bin/bash
# Build, bundle, sign and (optionally) install Bento.app.
#
#   scripts/build.sh            release build -> dist/Bento.app, signed
#   scripts/build.sh --install  ...and install to $BENTO_INSTALL_DIR, relaunch
#   scripts/build.sh --adhoc    ad-hoc signature (permissions reset on every build)
#
# Signing and install location are configured in scripts/config.sh. With a
# persistent identity the designated requirement pins the bundle id and the
# certificate leaf hash, so macOS keeps Accessibility / Screen Recording grants
# across rebuilds.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

. "$ROOT/scripts/config.sh"
BUNDLE_ID="com.charles.bento"
APP="$ROOT/dist/Bento.app"
VERSION="0.1.0"
BUILD_NUMBER="$(git rev-list --count HEAD 2>/dev/null || echo 0).$(date +%y%m%d%H%M)"

INSTALL=0; ADHOC=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    --adhoc) ADHOC=1 ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done

echo "==> swift build (release)"
swift build -c release --product Bento 2>&1 | grep -E "error|warning: |Compiling|Build complete" | grep -v "^warning: unhandled" || true
BIN="$(swift build -c release --product Bento --show-bin-path)/Bento"
[ -x "$BIN" ] || { echo "build failed" >&2; exit 1; }

echo "==> assemble $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Bento"
if [ ! -f "$ROOT/Resources/Bento.icns" ]; then
  swift "$ROOT/scripts/make-icon.swift" "$ROOT/Resources" >/dev/null
fi
cp "$ROOT/Resources/Bento.icns" "$APP/Contents/Resources/Bento.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Bento</string>
  <key>CFBundleDisplayName</key><string>Bento</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>Bento</string>
  <key>CFBundleIconFile</key><string>Bento</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>NSAppleEventsUsageDescription</key><string>Bento uses Apple Events to hide and show apps for app hotkeys.</string>
  <key>NSHumanReadableCopyright</key><string>Personal build, locally signed, not notarized.</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>$BUNDLE_ID.url</string>
      <key>CFBundleURLSchemes</key><array><string>bento</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST

sign_local() {
  codesign --force --sign "$1" --timestamp=none ${2:+--requirements "=$2"} "$APP"
}

# Code-signing identities in the keychain search list as `SHA-1 "name"`, one
# per line. Untrusted ones are included (no -v): a self-signed certificate
# signs fine without being trusted. Expired or revoked ones are left out.
signing_identities() {
  local out
  out=$(security find-identity -p codesigning 2>/dev/null) || true
  printf '%s\n' "$out" | awk '
    $1 ~ /^[0-9]+\)$/ && !seen[$2]++ {
      line = $0; sub(/^ *[0-9]+\) */, "", line)
      if (line ~ /\)$/ && line !~ /\(CSSMERR_TP_NOT_TRUSTED\)$/) next
      sub(/ *\(CSSMERR_TP_NOT_TRUSTED\)$/, "", line)
      print line
    }'
}

# SHA-1s of the identities whose hash or name is exactly $1.
identity_hashes() {
  signing_identities | ID="$1" awk '{
    name = $0; sub(/^[^ ]+ "/, "", name); sub(/"$/, "", name)
    if (toupper($1) == toupper(ENVIRON["ID"]) || name == ENVIRON["ID"]) print $1
  }'
}

echo "==> sign"
if [ "$ADHOC" = 1 ] || [ -z "$BENTO_SIGN_IDENTITY" ]; then
  [ "$ADHOC" = 1 ] || echo "note: BENTO_SIGN_IDENTITY not set, signing ad hoc (permission grants reset on every build)"
  sign_local - ""
else
  SIGN_HASHES=$(identity_hashes "$BENTO_SIGN_IDENTITY")
  case "$(printf '%s' "$SIGN_HASHES" | grep -c .)" in
    1) sign_local "$SIGN_HASHES" "designated => identifier \"$BUNDLE_ID\" and certificate leaf = H\"$SIGN_HASHES\"" ;;
    0) problem="no usable code-signing identity matching" ;;
    *) problem="several code-signing identities match (set the SHA-1 instead):" ;;
  esac
  if [ -n "${problem:-}" ]; then
    {
      echo "$problem BENTO_SIGN_IDENTITY=$BENTO_SIGN_IDENTITY"
      echo "Identities in the keychain search list (SHA-1 \"name\"):"
      signing_identities | sed 's/^/  /'
      echo "Set BENTO_SIGN_IDENTITY to one of these (scripts/config.local.sh), or use --adhoc."
    } >&2
    exit 1
  fi
fi
codesign --verify --strict --verbose=1 "$APP"
codesign -dvv "$APP" 2>&1 | grep -E "^(Identifier|Authority)=" || true
codesign -d -r- "$APP" 2>&1 | grep designated || true

quit_running() {
  if pgrep -f "Bento.app/Contents/MacOS/Bento$" >/dev/null; then
    osascript -e 'tell application id "com.charles.bento" to quit' >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do pgrep -f "Bento.app/Contents/MacOS/Bento$" >/dev/null || break; sleep 0.25; done
    pkill -f "Bento.app/Contents/MacOS/Bento$" 2>/dev/null || true
  fi
}

if [ "$INSTALL" = 1 ]; then
  echo "==> install $INSTALLED_APP"
  quit_running
  mkdir -p "$BENTO_INSTALL_DIR"
  rm -rf "$INSTALLED_APP.new"
  ditto "$APP" "$INSTALLED_APP.new"
  rm -rf "$INSTALLED_APP"
  mv "$INSTALLED_APP.new" "$INSTALLED_APP"
  codesign --verify --strict "$INSTALLED_APP"
  if [ "$INSTALLED_APP" != /Applications/Bento.app ]; then
    # ln -sfn onto a real app folder would nest the link inside it.
    if [ "$BENTO_INSTALL_DIR" = "$HOME/Applications" ]; then
      :
    elif [ -e ~/Applications/Bento.app ] && [ ! -L ~/Applications/Bento.app ]; then
      echo "warning: ~/Applications/Bento.app is an old copy, not a link; remove it and rerun"
    else
      mkdir -p ~/Applications && ln -sfn "$INSTALLED_APP" ~/Applications/Bento.app
    fi
    # /Applications needs sudo; it only has to be linked once.
    if [ "$(readlink /Applications/Bento.app)" != "$INSTALLED_APP" ]; then
      fix="sudo ln -sfn \"$INSTALLED_APP\" /Applications/Bento.app"
      [ -e /Applications/Bento.app ] && [ ! -L /Applications/Bento.app ] && fix="sudo rm -rf /Applications/Bento.app && $fix"
      echo "warning: /Applications/Bento.app is not a link to $INSTALLED_APP ($fix)"
    fi
  fi
  # Drop the build copy so Spotlight and Launch Services only know the installed app.
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$APP" 2>/dev/null || true
  rm -rf "$APP"
  open "$INSTALLED_APP"
fi

echo "==> done: $([ "$INSTALL" = 1 ] && echo "$INSTALLED_APP" || echo "$APP") ($VERSION build $BUILD_NUMBER)"
