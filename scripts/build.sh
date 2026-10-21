#!/bin/bash
# Build, bundle, sign and (optionally) install Bento.app.
#
#   scripts/build.sh                 release build -> dist/Bento.app, signed
#   scripts/build.sh --install       ...and install to /Applications, relaunch
#   scripts/build.sh --install-gskm4 ...and install on gskm4 (/opt/homebrew/opt)
#   scripts/build.sh --adhoc         ad-hoc signature (permissions reset on every build)
#
# Signing uses the same persistent self-signed identity as Jot
# ("Jot Local Development"). Its private key lives only in gskm4's login
# keychain, so when it is not in a local keychain the bundle is signed over SSH
# on gskm4 and copied back. The designated requirement pins the bundle id and
# the certificate leaf hash, so macOS keeps Accessibility / Screen Recording
# grants across rebuilds.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

IDENTITY="04F231DA34F7555198B3E7FC23BDB049C27C16D3"   # Jot Local Development (SHA-1)
SIGN_HOST="${BENTO_SIGN_HOST:-gskm4}"
BUNDLE_ID="com.charles.bento"
APP="$ROOT/dist/Bento.app"
VERSION="0.1.0"
BUILD_NUMBER="$(git rev-list --count HEAD 2>/dev/null || echo 0).$(date +%y%m%d%H%M)"
REQUIREMENT="designated => identifier \"$BUNDLE_ID\" and certificate leaf = H\"$IDENTITY\""

INSTALL=0; INSTALL_GSKM4=0; ADHOC=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    --install-gskm4) INSTALL_GSKM4=1 ;;
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
  codesign --force --sign "$1" --timestamp=none ${2:+--requirements "=$REQUIREMENT"} "$APP"
}

echo "==> sign"
if [ "$ADHOC" = 1 ]; then
  sign_local - ""
elif security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
  sign_local "$IDENTITY" req
else
  # Sign on the host that holds the Jot identity's private key.
  REMOTE_DIR=".t3/scratch/bento-sign"
  ssh -o ConnectTimeout=10 "$SIGN_HOST" "mkdir -p $REMOTE_DIR && rm -rf $REMOTE_DIR/Bento.app"
  rsync -a "$APP" "$SIGN_HOST:$REMOTE_DIR/"
  ssh "$SIGN_HOST" "codesign --force --sign $IDENTITY --keychain \$HOME/Library/Keychains/login.keychain-db --timestamp=none --requirements '=$REQUIREMENT' $REMOTE_DIR/Bento.app"
  rm -rf "$APP"
  rsync -a "$SIGN_HOST:$REMOTE_DIR/Bento.app" "$ROOT/dist/"
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
  echo "==> install /Applications/Bento.app"
  quit_running
  rm -rf /Applications/Bento.app.new
  ditto "$APP" /Applications/Bento.app.new
  rm -rf /Applications/Bento.app
  mv /Applications/Bento.app.new /Applications/Bento.app
  codesign --verify --strict /Applications/Bento.app
  open /Applications/Bento.app
fi

if [ "$INSTALL_GSKM4" = 1 ]; then
  echo "==> install on gskm4: /opt/homebrew/opt/Bento.app"
  rsync -a --delete "$APP/" "gskm4:/opt/homebrew/opt/Bento.app.new/"
  ssh gskm4 'set -e
    WAS_RUNNING=0; pkill -f "Bento.app/Contents/MacOS/Bento$" 2>/dev/null && WAS_RUNNING=1 && sleep 1 || true
    rm -rf /opt/homebrew/opt/Bento.app
    mv /opt/homebrew/opt/Bento.app.new /opt/homebrew/opt/Bento.app
    codesign --verify --strict /opt/homebrew/opt/Bento.app
    mkdir -p ~/Applications && ln -sfn /opt/homebrew/opt/Bento.app ~/Applications/Bento.app
    if [ "$WAS_RUNNING" = 1 ]; then open /opt/homebrew/opt/Bento.app; else echo "installed, not launched (quit Rectangle Pro / Shottr / Raycast hotkeys first, then open ~/Applications/Bento.app)"; fi'
fi

echo "==> done: $APP ($VERSION build $BUILD_NUMBER)"
