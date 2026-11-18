# Homebrew cask for Fremkit. The published copy lives in the tap fdussert/homebrew-fremkit as
# Casks/fremkit.rb; scripts/release.sh fills `version` and `sha256` here and prints the commands
# that copy it there. Install: brew install --cask fdussert/fremkit/fremkit
cask "fremkit" do
  version "0.5.1"
  sha256 "d956a8533cbbc288a3fbc45e629b1965f744e91c778e70ddc14205e0bbc4c1c6"

  url "https://github.com/fdussert/fremkit/releases/download/v#{version}/Fremkit-#{version}.dmg"
  name "Fremkit"
  desc "Widget dashboard for the Corsair Xeneon Edge touch display"
  homepage "https://fremkit.app"

  livecheck do
    url :url
    strategy :github_latest
  end

  # Sparkle updates the app in place; brew must not fight it.
  auto_updates true
  depends_on arch: :arm64
  depends_on macos: :ventura

  app "Fremkit.app"

  uninstall quit: "dev.fremkit.helper"

  zap trash: [
    "~/Library/Application Support/Fremkit",
    "~/Library/Caches/dev.fremkit.helper",
    "~/Library/HTTPStorages/dev.fremkit.helper",
    "~/Library/Logs/Fremkit",
    "~/Library/Preferences/dev.fremkit.helper.plist",
    "~/Library/WebKit/dev.fremkit.helper",
  ]
end
