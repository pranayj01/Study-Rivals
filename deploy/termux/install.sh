#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
PROJECT_DIR="${1:-$HOME/study-rivals}"
if [[ ! -f "$PROJECT_DIR/package.json" ]]; then
  echo "Study Rivals was not found at: $PROJECT_DIR" >&2
  echo "Copy the project there first, or pass its path as the first argument." >&2
  exit 1
fi
pkg update
pkg upgrade -y
pkg install -y nodejs-lts python make clang pkg-config termux-services sqlite
if [[ "$(node -p 'process.versions.node.split(`.`)[0]')" -gt 24 ]]; then
  echo "Node $(node -v) is newer than the tested Termux LTS runtime. Install nodejs-lts before continuing." >&2
  exit 1
fi
cd "$PROJECT_DIR"
npm ci
npm run check
npm run build
SERVICE_DIR="$PREFIX/var/service"
mkdir -p "$SERVICE_DIR/study-rivals/log" "$SERVICE_DIR/study-rivals-tunnel/log" "$PROJECT_DIR/backups"
cp "$PROJECT_DIR/deploy/termux/run-app" "$SERVICE_DIR/study-rivals/run"
cp "$PROJECT_DIR/deploy/termux/run-tunnel" "$SERVICE_DIR/study-rivals-tunnel/run"
cp "$PROJECT_DIR/deploy/termux/log-run" "$SERVICE_DIR/study-rivals/log/run"
cp "$PROJECT_DIR/deploy/termux/log-run" "$SERVICE_DIR/study-rivals-tunnel/log/run"
chmod 700 "$SERVICE_DIR/study-rivals/run" "$SERVICE_DIR/study-rivals-tunnel/run"
chmod 755 "$SERVICE_DIR/study-rivals/log/run" "$SERVICE_DIR/study-rivals-tunnel/log/run"
echo "Build complete. Configure .env and deploy/termux/env, restart Termux, then enable both services."
