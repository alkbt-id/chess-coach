#!/bin/zsh
# Build «Шахматный тренер.app» into ~/Applications.
set -euo pipefail
HERE=${0:A:h}
ROOT=${HERE:h}
BUILD="$HERE/build"
APP="$HOME/Applications/Шахматный тренер.app"
mkdir -p "$BUILD" "$HOME/Applications"

swiftc -O -o "$BUILD/ChessCoach" "$HERE/main.swift" -framework Cocoa -framework WebKit

if [[ ! -f "$BUILD/AppIcon.icns" ]]; then
  swift "$HERE/make_icon.swift" "$BUILD/AppIcon.iconset" "$ROOT/coach/web/vendor/pieces.merida.css"
  iconutil -c icns "$BUILD/AppIcon.iconset" -o "$BUILD/AppIcon.icns"
fi

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/ChessCoach" "$APP/Contents/MacOS/ChessCoach"
cp "$BUILD/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Шахматный тренер</string>
  <key>CFBundleDisplayName</key><string>Шахматный тренер</string>
  <key>CFBundleIdentifier</key><string>local.alkbt.chess-coach</string>
  <key>CFBundleExecutable</key><string>ChessCoach</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleDevelopmentRegion</key><string>ru</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>CFBundleURLTypes</key>
  <array><dict>
    <key>CFBundleURLName</key><string>local.alkbt.chess-coach</string>
    <key>CFBundleURLSchemes</key><array><string>chess-coach</string></array>
  </dict></array>
</dict>
</plist>
PLIST
# where the window finds the server (mac/main.swift reads it)
/usr/libexec/PlistBuddy -c "Add :ChessCoachRoot string $ROOT" "$APP/Contents/Info.plist"
codesign --force -s - "$APP" >/dev/null 2>&1
touch "$APP"
# Register chess-coach:// right away, not on the next launch from Finder.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" || true
echo "built: $APP"
