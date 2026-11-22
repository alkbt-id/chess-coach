#!/bin/zsh
# Download Lichess's "standard" move sounds for local use (they are non-free, so the repo does not ship them).
# Without them the app works silently.
set -euo pipefail
DIR=${0:A:h:h}/coach/web/vendor/sound
BASE=https://raw.githubusercontent.com/lichess-org/lila/master/public/sound/standard
for s in Move Capture GenericNotify LowTime; do
  curl -fsSL -o "$DIR/$s.mp3" "$BASE/$s.mp3"
  echo "$DIR/$s.mp3"
done
