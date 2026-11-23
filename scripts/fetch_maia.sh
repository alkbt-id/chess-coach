#!/bin/zsh
# Download the Maia net (CSSLab, GPL-3.0) that rates how hard each puzzle is (coach/maia.py).
# It runs on lc0: brew install lc0. Without them puzzles have no difficulty and come in any order.
set -euo pipefail
DIR="${COACH_HOME:-$HOME/Library/Application Support/ChessCoach}/maia"
mkdir -p "$DIR"
curl -fsSL -o "$DIR/maia-1300.pb.gz" https://raw.githubusercontent.com/CSSLab/maia-chess/master/maia_weights/maia-1300.pb.gz
echo "$DIR/maia-1300.pb.gz"
