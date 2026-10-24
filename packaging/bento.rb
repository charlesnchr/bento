# Homebrew formula for Bento. scripts/release.sh fills in the version and
# checksum and publishes it as Formula/bento.rb in charlesnchr/homebrew-tap.
#
# A formula rather than a cask so the app lives in the Homebrew prefix
# (/opt/homebrew/opt/bento/Bento.app) and installs without admin rights or a
# quarantine flag. The archive is the release build, signed with the same
# certificate every time, so updates keep the Accessibility and Screen
# Recording grants.
class Bento < Formula
  desc "Menu-bar app for screenshots, window management, clipboard, notes and todos"
  homepage "https://github.com/charlesnchr/bento"
  url "https://github.com/charlesnchr/bento/releases/download/v@VERSION@/Bento-@VERSION@.zip", using: :nounzip
  version "@VERSION@"
  sha256 "@SHA256@"
  license "MIT"

  depends_on arch: :arm64
  depends_on macos: :sonoma

  def install
    # ditto unpacks the bundle exactly as it was signed.
    system "/usr/bin/ditto", "-x", "-k", "Bento-#{version}.zip", prefix
  end

  def caveats
    <<~EOS
      Start Bento with:
        open #{opt_prefix}/Bento.app
      and grant Accessibility and Screen Recording when it asks. It adds a
      Finder alias in ~/Applications; Spotlight may omit it from app results.
      To open Settings directly after first launch: open 'bento://settings'
      Updates: Bento checks daily and installs them from its menu bar menu.
      After a brew upgrade in a terminal, restart Bento from that menu.
      Permission grants carry over.
    EOS
  end

  test do
    system "/usr/bin/codesign", "--verify", "--strict", prefix/"Bento.app"
    assert_equal version.to_s,
      shell_output("/usr/bin/defaults read #{prefix}/Bento.app/Contents/Info CFBundleShortVersionString").strip
  end
end
