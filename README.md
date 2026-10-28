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

## Android hosting notes

The easiest route is Termux with Node.js installed. Copy this project to the phone, run the same install/build/start commands, and keep Termux awake while the server is needed. Both players can then use the phone's LAN IP on port 3001.

SQLite data is stored in `data/study-rivals.db`. Back up that file to preserve progress.

## Commands

- `npm run dev` — run web and API development servers
- `npm run check` — TypeScript validation
- `npm run build` — production PWA build
- `npm start` — serve the API, Socket.IO, and production web app
