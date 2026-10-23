# Build, install and deploy settings, sourced by build.sh, release.sh,
# deploy-server.sh and the e2e scripts.
# Set them in the environment or, per machine, in scripts/config.local.sh
# (untracked), e.g.  : "${BENTO_INSTALL_DIR:=/opt/homebrew/opt/bento}"
#
#   BENTO_SIGN_IDENTITY  SHA-1 or exact name of a persistent code-signing
#                        identity (it needn't be trusted). Builds
#                        signed with it keep Accessibility / Screen Recording
#                        grants across rebuilds; without it they are signed ad hoc.
#                        Grants are per Mac, so each machine can use its own.
#   BENTO_INSTALL_DIR    where --install puts Bento.app. Default: the Homebrew
#                        install (/opt/homebrew/opt/bento) if bento is installed
#                        with brew, so a local build replaces it in place (until
#                        the next brew upgrade); otherwise /Applications.
#                        Installed elsewhere, the app adds a Finder alias to
#                        itself in ~/Applications so Spotlight finds it.
#   BENTO_SYNC_DOMAIN    public name of your bento-sync server, for
#                        deploy-server.sh (e.g. sync.example.com).
CONFIG_LOCAL="$(dirname "${BASH_SOURCE[0]}")/config.local.sh"
# shellcheck source=/dev/null
# A failing command in it must not abort a caller running with set -e
# (bash 3.2 ignores `|| true` on a sourced file).
if [ -f "$CONFIG_LOCAL" ]; then
  case $- in *e*) set +e; . "$CONFIG_LOCAL"; set -e ;; *) . "$CONFIG_LOCAL" ;; esac
fi
BENTO_SIGN_IDENTITY="${BENTO_SIGN_IDENTITY:-}"
if [ -z "${BENTO_INSTALL_DIR:-}" ] && [ -L /opt/homebrew/opt/bento ]; then
  BENTO_INSTALL_DIR=/opt/homebrew/opt/bento
fi
BENTO_INSTALL_DIR="${BENTO_INSTALL_DIR:-/Applications}"
BENTO_INSTALL_DIR="${BENTO_INSTALL_DIR%/}"
INSTALLED_APP="$BENTO_INSTALL_DIR/Bento.app"
# The path its process runs from: Launch Services resolves links (a Homebrew
# install runs from Cellar/bento/<version>/Bento.app).
INSTALLED_APP_REAL="$( (cd "$INSTALLED_APP" 2>/dev/null && pwd -P) || echo "$INSTALLED_APP")"
