#!/bin/bash
# Install, update or remove the local voice helper (helper/voice-helper.py), the
# loopback bridge Dictation, Meetings and Gemini Live calls use to reach Vertex AI
# (and Azure, OpenRouter or a local gateway for some models). See helper/README.md.
#
#   scripts/voice-helper.sh install [--python PATH] [--credentials ADC.json]
#   scripts/voice-helper.sh update      copy the scripts again and restart
#   scripts/voice-helper.sh status
#   scripts/voice-helper.sh uninstall   remove the agent and its folder (not the runtime file)
#
# Needs ~/.config/bento/voice-runtime.json (helper/voice-runtime.example.json)
# and Google application default credentials for its project.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.charles.bento.voice-helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/Bento"
RUNTIME="${BENTO_VOICE_RUNTIME:-$HOME/.config/bento/voice-runtime.json}"
if [ -n "${BENTO_VOICE_HELPER_DIR:-}" ]; then PREFIX="$BENTO_VOICE_HELPER_DIR"
elif [ -f "$PLIST" ]; then PREFIX="$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$PLIST")"   # where install put it
elif [ -d /opt/homebrew ]; then PREFIX=/opt/homebrew/libexec/bento-voice   # managed Macs often allow only this prefix
else PREFIX="$HOME/Library/Application Support/Bento/VoiceHelper"; fi

die() { echo "error: $*" >&2; exit 1; }
say() { printf '\033[1m==> %s\033[0m\n' "$*"; }

runtime_value() {  # runtime_value <key>
  /usr/bin/python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print(v if v is not None else "")' "$RUNTIME" "$1"
}

copy_scripts() {
  mkdir -p "$PREFIX"
  cp "$ROOT/helper/voice-helper.py" "$ROOT/helper/azure_live.py" "$ROOT/helper/gemini_live_setup.json" \
     "$ROOT/helper/live_resume.json" "$ROOT/helper/requirements.txt" "$PREFIX/"
}

install_requirements() {
  local py="$PREFIX/venv/bin/python"
  # uv-made virtualenvs have no pip: use uv when it's there, else bootstrap pip.
  if ! "$py" -m pip --version >/dev/null 2>&1; then
    if command -v uv >/dev/null; then
      uv pip install -q --python "$py" -r "$PREFIX/requirements.txt"
      return
    fi
    "$py" -m ensurepip -q
  fi
  "$py" -m pip install -q --disable-pip-version-check -r "$PREFIX/requirements.txt"
}

restart() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  # bootout returns before launchd has let go; bootstrapping too soon fails with error 5.
  for _ in $(seq 1 20); do
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
    sleep 0.25
  done
  for _ in 1 2 3; do
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && return 0
    sleep 1
  done
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
}

health() {
  local base key
  base="$(runtime_value bifrost_base_url)"; key="$(runtime_value bifrost_key)"
  for _ in $(seq 1 20); do
    if curl -fsS -m 2 -H "x-goog-api-key: $key" "$base/health" >/dev/null 2>&1; then
      echo "helper is up at $base"; return 0
    fi
    sleep 0.5
  done
  echo "helper did not answer at $base; see $LOGS/voice-helper.err.log" >&2
  return 1
}

cmd="${1:-}"; shift || true
case "$cmd" in
  install)
    PY="" CREDS="${GOOGLE_APPLICATION_CREDENTIALS:-}"
    while [ $# -gt 0 ]; do
      case "$1" in
        --python) PY="$2"; shift 2 ;;
        --credentials) CREDS="$2"; shift 2 ;;
        *) die "unknown option $1" ;;
      esac
    done
    [ -f "$RUNTIME" ] || die "no runtime file at $RUNTIME (start from helper/voice-runtime.example.json)"
    [ "$(runtime_value transport)" = direct ] || die "$RUNTIME: transport must be \"direct\""
    PROJECT="$(runtime_value project)"; [ -n "$PROJECT" ] || die "$RUNTIME: project is missing"
    CREDS="${CREDS:-$HOME/.config/gcloud/application_default_credentials.json}"
    [ -f "$CREDS" ] || die "no credentials at $CREDS (gcloud auth application-default login, or --credentials)"
    if [ -z "$PY" ]; then
      for candidate in python3.13 python3.12 python3.11 python3; do
        if command -v "$candidate" >/dev/null && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 11))'; then
          PY="$(command -v "$candidate")"; break
        fi
      done
    fi
    [ -n "$PY" ] || die "needs Python 3.11 or newer (--python PATH)"
    say "helper in $PREFIX (Python: $PY)"
    copy_scripts
    if [ ! -x "$PREFIX/venv/bin/python" ]; then "$PY" -m venv "$PREFIX/venv"; fi
    install_requirements
    mkdir -p "$LOGS" "$(dirname "$PLIST")"
    chmod 700 "$LOGS"
    cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PREFIX/venv/bin/python</string>
    <string>$PREFIX/voice-helper.py</string>
    <string>--config</string>
    <string>$RUNTIME</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GOOGLE_APPLICATION_CREDENTIALS</key><string>$CREDS</string>
    <key>GOOGLE_CLOUD_PROJECT</key><string>$PROJECT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>WorkingDirectory</key><string>$PREFIX</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>$LOGS/voice-helper.log</string>
  <key>StandardErrorPath</key><string>$LOGS/voice-helper.err.log</string>
</dict>
</plist>
PLIST_END
    chmod 600 "$PLIST"
    restart
    health
    ;;
  update)
    [ -f "$PLIST" ] || die "not installed (scripts/voice-helper.sh install)"
    copy_scripts
    install_requirements
    restart
    health
    ;;
  status)
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state =|pid =|last exit code" || echo "not loaded"
    [ -f "$RUNTIME" ] && health || true
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    rm -rf "$PREFIX"
    echo "removed $LABEL and $PREFIX (kept $RUNTIME)"
    ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
