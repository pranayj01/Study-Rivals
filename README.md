# Study Rivals

A two-player, local-first study PWA with a shared live room, focus sessions, daily targets, XP, levels, streaks, weekly bounties, a champion board, and Discord integration.

## Quick start

1. Copy `.env.example` to `.env` and change the two player names, passcodes, and `JWT_SECRET`.
2. Add your Discord invite URL. Bot token and channel ID are optional.
3. Run `npm install`, then `npm run build`.
4. Run `npm start`.
5. On a phone connected to the same Wi-Fi, open `http://YOUR-COMPUTER-IP:3001` and choose **Add to Home screen**.

For active development, run `npm run dev`. Vite runs the UI on port 5173 and proxies the API and live connection to port 3001.

## Discord bot setup

Create a bot in the Discord Developer Portal, invite it to your study server with **View Channels** and **Send Messages** permissions, then put its token in `DISCORD_BOT_TOKEN` and the target text-channel ID in `DISCORD_CHANNEL_ID`. Completed focus sessions and claimed bounties will be announced automatically.

## Deploy on LineageOS with Termux and Cloudflare Tunnel

The production setup binds Study Rivals only to `127.0.0.1:3001`. Cloudflare Tunnel is the sole public entry point, and both the app and tunnel are kept alive by Termux Services.

### 1. Copy the project to the phone

From the PC, with the phone reachable over SSH:

```bash
scp -r "D:/Study Rivals" PHONE_USER@PHONE_IP:~/Study-Rivals
```

Do not copy the PC's `node_modules`; if it was included, remove that directory on the phone before installation because native modules must be built for Android.

### 2. Install and build in Termux

```bash
cd ~/Study-Rivals
chmod +x deploy/termux/*.sh deploy/termux/run-*
./deploy/termux/install.sh "$HOME/Study-Rivals"
```

The installer performs a full `pkg upgrade` first. Termux is a rolling-release environment and does not support partial upgrades; skipping this can leave Node linked against a newer C++ runtime than the one installed on the phone.

If `better-sqlite3` needs to compile, the installer already supplies Python, Make, Clang, and pkg-config.

Study Rivals is tested with Termux's `nodejs-lts` package. Avoid the rolling `nodejs` package (currently Node 26). Check with `node -v`; if necessary, switch before installing dependencies:

```bash
pkg uninstall nodejs
pkg install nodejs-lts
rm -rf node_modules
npm ci
```

TypeScript is pinned to the portable 5.9 compiler because the newer native compiler package does not publish an Android ARM64 executable.

### 3. Configure production secrets

```bash
cp .env.example .env
nano .env
```

Set `APP_ORIGIN` to the exact public HTTPS URL, generate a long random `JWT_SECRET`, and replace both default player passcodes. Keep `.env` private:

```bash
chmod 600 .env
```

### 4. Configure Cloudflare

In Cloudflare Zero Trust, create or reuse a remotely-managed tunnel. Add a **Published application** route whose public hostname is your chosen domain and whose service URL is `http://localhost:3001`. Then copy the tunnel token from **Add a replica** into:

```bash
cp deploy/termux/env.example deploy/termux/env
nano deploy/termux/env
chmod 600 deploy/termux/env
```

The token is intentionally excluded from Git and is passed to `cloudflared` through its environment rather than the process command line.

### 5. Enable persistent services

Restart Termux once after installing `termux-services`, then run:

```bash
sv-enable study-rivals
sv-enable study-rivals-tunnel
sv status study-rivals study-rivals-tunnel
```

Logs are available at `$PREFIX/var/log/sv/study-rivals/current` and `$PREFIX/var/log/sv/study-rivals-tunnel/current`. Disable Android battery optimization for Termux, and use `termux-wake-lock` after installing the Termux:API package if LineageOS suspends the process.

### 6. Verify

```bash
curl http://127.0.0.1:3001/api/health
curl https://YOUR_PUBLIC_HOSTNAME/api/health
```

Both should return `{"status":"ok",...}`. Socket.IO uses the same hostname and is carried through the tunnel automatically.

### Updating

Copy or pull the updated source, then:

```bash
cd ~/Study-Rivals
npm ci
npm run check
npm run build
sv restart study-rivals
```

### Backups

Run `./deploy/termux/backup.sh` to make a safe SQLite backup. The script retains 14 days of backups in `backups/`.

SQLite data is stored in `data/study-rivals.db`. Back up that file to preserve progress.

## Commands

- `npm run dev` — run web and API development servers
- `npm run check` — TypeScript validation
- `npm run build` — production PWA build
- `npm start` — serve the API, Socket.IO, and production web app
