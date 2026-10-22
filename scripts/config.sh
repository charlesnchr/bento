# Build and install settings, sourced by build.sh and the e2e scripts.
# Set them in the environment or, per machine, in scripts/config.local.sh
# (untracked), e.g.  : "${BENTO_INSTALL_DIR:=/opt/homebrew/opt/bento}"
#
#   BENTO_SIGN_IDENTITY  SHA-1 of a persistent code-signing identity. Builds
#                        signed with it keep Accessibility / Screen Recording
#                        grants across rebuilds; without it they are signed ad hoc.
#                        Grants are per Mac, so each machine can use its own.
#   BENTO_INSTALL_DIR    where --install puts Bento.app (default /Applications).
#                        Any other directory is linked from ~/Applications.
CONFIG_LOCAL="$(dirname "${BASH_SOURCE[0]}")/config.local.sh"
# shellcheck source=/dev/null
if [ -f "$CONFIG_LOCAL" ]; then . "$CONFIG_LOCAL" || true; fi
BENTO_SIGN_IDENTITY="${BENTO_SIGN_IDENTITY:-}"
BENTO_INSTALL_DIR="${BENTO_INSTALL_DIR:-/Applications}"
BENTO_INSTALL_DIR="${BENTO_INSTALL_DIR%/}"
INSTALLED_APP="$BENTO_INSTALL_DIR/Bento.app"
