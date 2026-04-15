# Discord Stream Selfbot 🎮📺

A stable Discord selfbot that relays Twitch livestreams into a voice channel.
Supports auto-detection of Twitch links, manual commands, and auto-stop when the stream ends.

---

## Features

| Feature | Details |
|---|---|
| 🔗 Auto-detect | Watches a text channel for Twitch links — starts streaming instantly |
| 🎙️ Voice stream | Joins a voice channel and relays the Twitch live at up to 1080p/60fps |
| ▶️ Manual start | `!stream https://twitch.tv/username` |
| ⏹️ Manual stop | `!stopstream` |
| 📴 Auto-stop | Polls Twitch API every 30s — stops automatically when streamer goes offline |
| 💥 Crash-resistant | Unhandled rejections caught; ffmpeg errors handled gracefully |

---

## Requirements

Install these **before** running the bot:

### 1. Node.js ≥ 18
```
https://nodejs.org
```

### 2. FFmpeg
- **Windows**: Download from https://ffmpeg.org/download.html → add to PATH
- **Linux**: `sudo apt install ffmpeg`
- **Mac**: `brew install ffmpeg`

### 3. Streamlink
- **Windows**: `pip install streamlink` or download installer from https://streamlink.github.io
- **Linux**: `sudo pip install streamlink`
- **Mac**: `brew install streamlink`

Verify both are working:
```bash
ffmpeg -version
streamlink --version
```

---

## Setup

### Step 1 — Install dependencies
```bash
cd discord-stream-selfbot
npm install
```

### Step 2 — Create your .env file
```bash
cp .env.example .env
```
Then open `.env` and fill in your values:

#### Discord Token
1. Open Discord in your browser (discord.com/app)
2. Press F12 → Console tab
3. Paste: `(webpackChunkdiscord_app.push([[''],{},e=>{m=[];for(let c in e.c)m.push(e.c[c])}]),m).find(m=>m?.exports?.default?.getToken!==void 0).exports.default.getToken()`
4. Copy the token shown

#### Channel/Guild IDs
1. Discord Settings → Advanced → Enable Developer Mode
2. Right-click any channel → "Copy Channel ID"
3. Right-click the server name → "Copy Server ID"

#### Twitch API credentials
1. Go to https://dev.twitch.tv/console
2. Click "Register Your Application"
3. Set OAuth Redirect URL to `http://localhost`
4. Copy Client ID and generate a Client Secret

### Step 3 — Run the bot
```bash
npm start
```

---

## Commands

All commands are sent **by you** in any channel the selfbot can see:

| Command | Description |
|---|---|
| `!stream https://twitch.tv/username` | Start streaming a Twitch channel |
| `!stopstream` | Stop the current stream |
| `!streamstatus` | Show what's currently streaming |

---

## How auto-detection works

The bot monitors the channel defined in `MONITOR_CHANNEL_ID`.
When **anyone** posts a message containing a `twitch.tv/` URL, the bot:
1. Checks if the stream is live via Twitch API
2. Joins the voice channel
3. Starts relaying the stream

---

## Troubleshooting

**"streamlink failed to get stream URL"**
→ Make sure streamlink is installed and in your PATH: `streamlink --version`

**Bot joins voice but no audio/video**
→ Check FFmpeg is installed: `ffmpeg -version`
→ Try lowering quality in `.env` (e.g. 720p/30fps)

**"Could not extract Twitch username"**
→ Make sure the URL format is `https://twitch.tv/username` (no trailing slash stuff)

**Bot crashes on startup**
→ Double check your `.env` — especially `DISCORD_TOKEN`, `GUILD_ID`, and both channel IDs

---

## ⚠️ Disclaimer

Selfbots violate Discord's Terms of Service. Use at your own risk on your own account.
This is intended for personal/private use only.
