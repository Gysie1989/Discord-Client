/**
 * Discord Selfbot - Twitch Stream Relay  (hardened v2)
 *
 * Crash-resistant improvements:
 *  - Startup dependency checker (ffmpeg, streamlink, node version)
 *  - Config validator (catches missing .env before connecting)
 *  - Twitch token auto-refresh on 401
 *  - FFmpeg watchdog: if ffmpeg dies unexpectedly, logs cleanly
 *  - All async paths wrapped — no unhandled promise can kill the process
 *  - Stream lock flag prevents double-start race conditions
 *  - Timestamped structured logging to console + selfbot.log file
 *  - !restart command re-fetches stream URL and reconnects mid-session
 *  - Controlled via Discord commands from any device (PC or phone)
 */

'use strict';
require('dotenv').config();

const { Client }                          = require('discord.js-selfbot-v13');
const { streamLivestreamVideo, Streamer } = require('@dank074/discord-video-stream');
const axios                               = require('axios');
const { spawn, execSync }                 = require('child_process');
const fs                                  = require('fs');
const path                                = require('path');

// ══════════════════════════════════════════════════════════════════════════════
//  LOGGER
// ══════════════════════════════════════════════════════════════════════════════
const LOG_FILE  = path.join(__dirname, 'selfbot.log');
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function log(level, tag, msg) {
  const line = `[${new Date().toISOString()}] [${level.padEnd(5)}] [${tag}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}
const info  = (t, m) => log('INFO',  t, m);
const warn  = (t, m) => log('WARN',  t, m);
const error = (t, m) => log('ERROR', t, m);
const debug = (t, m) => log('DEBUG', t, m);

// ══════════════════════════════════════════════════════════════════════════════
//  CONFIG & VALIDATION
// ══════════════════════════════════════════════════════════════════════════════
const CONFIG = {
  token:              process.env.DISCORD_TOKEN,
  monitorChannelId:   process.env.MONITOR_CHANNEL_ID,
  voiceChannelId:     process.env.VOICE_CHANNEL_ID,
  guildId:            process.env.GUILD_ID,
  twitchClientId:     process.env.TWITCH_CLIENT_ID,
  twitchClientSecret: process.env.TWITCH_CLIENT_SECRET,
  streamWidth:        parseInt(process.env.STREAM_WIDTH)  || 1280,
  streamHeight:       parseInt(process.env.STREAM_HEIGHT) || 720,
  streamFps:          parseInt(process.env.STREAM_FPS)    || 30,
  checkIntervalMs:    30_000,
  streamlinkBin:      process.platform === 'win32' ? 'streamlink.exe' : 'streamlink',
  ffmpegBin:          process.platform === 'win32' ? 'ffmpeg.exe'     : 'ffmpeg',
};

function validateConfig() {
  const required = [
    'token', 'monitorChannelId', 'voiceChannelId',
    'guildId', 'twitchClientId', 'twitchClientSecret',
  ];
  const missing = required.filter(k => !CONFIG[k]);
  if (missing.length) {
    error('Config', `Missing required .env values: ${missing.join(', ')}`);
    error('Config', 'Copy .env.example to .env and fill in all fields.');
    process.exit(1);
  }
  info('Config', 'All required config values present');
}

// ══════════════════════════════════════════════════════════════════════════════
//  DEPENDENCY CHECKER
// ══════════════════════════════════════════════════════════════════════════════
function checkDependencies() {
  info('Deps', 'Checking system dependencies...');

  // Node version
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 18) {
    error('Deps', `Node.js >= 18 required. You have v${process.versions.node}`);
    process.exit(1);
  }
  info('Deps', `Node.js v${process.versions.node} OK`);

  // FFmpeg
  try {
    const v = execSync(`${CONFIG.ffmpegBin} -version 2>&1`).toString().split('\n')[0];
    info('Deps', `${v} OK`);
  } catch (_) {
    error('Deps', 'ffmpeg not found in PATH. Install from https://ffmpeg.org');
    process.exit(1);
  }

  // Streamlink
  try {
    const v = execSync(`${CONFIG.streamlinkBin} --version 2>&1`).toString().trim();
    info('Deps', `streamlink ${v} OK`);
  } catch (_) {
    error('Deps', 'streamlink not found in PATH. Run: pip install streamlink');
    process.exit(1);
  }

  info('Deps', 'All dependencies OK');
}

// ══════════════════════════════════════════════════════════════════════════════
//  TWITCH API
// ══════════════════════════════════════════════════════════════════════════════
let _twitchToken     = null;
let _twitchTokenTime = 0;
const TOKEN_TTL_MS   = 55 * 60 * 1000;

async function getTwitchToken(forceRefresh = false) {
  const expired = Date.now() - _twitchTokenTime > TOKEN_TTL_MS;
  if (_twitchToken && !expired && !forceRefresh) return _twitchToken;

  debug('Twitch', 'Fetching new app access token...');
  const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
    params: {
      client_id:     CONFIG.twitchClientId,
      client_secret: CONFIG.twitchClientSecret,
      grant_type:    'client_credentials',
    },
    timeout: 10_000,
  });
  _twitchToken     = res.data.access_token;
  _twitchTokenTime = Date.now();
  info('Twitch', 'Access token refreshed');
  return _twitchToken;
}

async function isTwitchLive(login, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const token = await getTwitchToken();
      const res   = await axios.get('https://api.twitch.tv/helix/streams', {
        headers: { 'Client-ID': CONFIG.twitchClientId, Authorization: `Bearer ${token}` },
        params:  { user_login: login },
        timeout: 10_000,
      });
      return res.data.data.length > 0;
    } catch (err) {
      if (err.response?.status === 401 && attempt < retries) {
        warn('Twitch', '401 on live check — refreshing token...');
        await getTwitchToken(true);
        continue;
      }
      warn('Twitch', `Live-check failed (attempt ${attempt + 1}): ${err.message}`);
      if (attempt === retries) return true; // assume live on persistent error
    }
  }
}

function extractTwitchLogin(url) {
  const match = url.match(/twitch\.tv\/([a-zA-Z0-9_]+)/i);
  return match ? match[1].toLowerCase() : null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  STREAMLINK
// ══════════════════════════════════════════════════════════════════════════════
function getStreamUrl(twitchUrl, quality = 'best') {
  return new Promise((resolve, reject) => {
    info('Streamlink', `Resolving ${twitchUrl} [${quality}]...`);
    const proc = spawn(CONFIG.streamlinkBin, ['--stream-url', twitchUrl, quality]);
    let out = '', errOut = '';
    proc.stdout.on('data', d => { out    += d.toString(); });
    proc.stderr.on('data', d => { errOut += d.toString(); });
    proc.on('error', err => reject(new Error(`spawn error: ${err.message}`)));
    proc.on('close', code => {
      if (code !== 0 || !out.trim()) {
        reject(new Error(`streamlink exited ${code}. ${errOut.trim().slice(0, 200)}`));
      } else {
        info('Streamlink', 'Stream URL resolved');
        resolve(out.trim());
      }
    });
    // 30s timeout
    const t = setTimeout(() => { proc.kill(); reject(new Error('streamlink timed out after 30s')); }, 30_000);
    proc.on('close', () => clearTimeout(t));
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  STREAM STATE
// ══════════════════════════════════════════════════════════════════════════════
let currentStream = null;
let _streamLock   = false;

const streamer = new Streamer(new Client());

// ══════════════════════════════════════════════════════════════════════════════
//  START STREAM
// ══════════════════════════════════════════════════════════════════════════════
async function startStream(twitchUrl, triggerChannelId) {
  if (_streamLock) {
    warn('Stream', 'Start requested while lock held — ignoring duplicate');
    return;
  }
  _streamLock = true;

  try {
    const login = extractTwitchLogin(twitchUrl);
    if (!login) {
      await sendMsg(triggerChannelId, 'Could not parse a Twitch username from that URL.');
      return;
    }

    info('Stream', `Start requested for: ${login}`);
    await sendMsg(triggerChannelId, `Checking if **${login}** is live...`);

    const live = await isTwitchLive(login);
    if (!live) {
      await sendMsg(triggerChannelId, `**${login}** is not live right now.`);
      return;
    }

    if (currentStream) {
      info('Stream', 'Stopping existing stream before starting new one...');
      await stopStream(true);
    }

    await sendMsg(triggerChannelId, `Resolving stream URL for **${login}**...`);

    let streamUrl;
    try {
      streamUrl = await getStreamUrl(`https://twitch.tv/${login}`);
    } catch (err) {
      error('Stream', `getStreamUrl failed: ${err.message}`);
      await sendMsg(triggerChannelId, `Could not get stream URL: ${err.message}`);
      return;
    }

    // Join voice channel
    try {
      await streamer.joinVoice(CONFIG.guildId, CONFIG.voiceChannelId);
      info('Stream', `Joined voice channel ${CONFIG.voiceChannelId}`);
    } catch (err) {
      error('Stream', `Failed to join voice: ${err.message}`);
      await sendMsg(triggerChannelId, `Could not join voice channel: ${err.message}`);
      return;
    }

    // Create Discord stream
    let udpConn;
    try {
      udpConn = await streamer.createStream();
      udpConn.mediaConnection.setSpeaking(true);
      udpConn.mediaConnection.setVideoStatus(true);
    } catch (err) {
      error('Stream', `createStream failed: ${err.message}`);
      await sendMsg(triggerChannelId, `Failed to create Discord stream: ${err.message}`);
      try { streamer.leaveVoice(); } catch (_) {}
      return;
    }

    // Spawn FFmpeg
    const ffmpeg = spawn(CONFIG.ffmpegBin, [
      '-re',
      '-i',       streamUrl,
      '-vf',      `scale=${CONFIG.streamWidth}:${CONFIG.streamHeight}`,
      '-c:v',     'libx264',
      '-preset',  'veryfast',
      '-tune',    'zerolatency',
      '-b:v',     '3000k',
      '-maxrate', '3000k',
      '-bufsize', '6000k',
      '-pix_fmt', 'yuv420p',
      '-r',       `${CONFIG.streamFps}`,
      '-g',       `${CONFIG.streamFps * 2}`,
      '-c:a',     'libopus',
      '-b:a',     '128k',
      '-ar',      '48000',
      '-ac',      '2',
      '-f',       'mpegts',
      'pipe:1',
    ]);

    ffmpeg.stderr.on('data', () => {}); // suppress noisy ffmpeg output
    ffmpeg.on('error', err => error('FFmpeg', `Process error: ${err.message}`));
    ffmpeg.on('close', (code, signal) => {
      info('FFmpeg', `Exited — code=${code} signal=${signal}`);
      if (currentStream?.ffmpegProcess === ffmpeg) {
        info('Stream', 'FFmpeg closed — cleaning up');
        _cleanup();
        sendMsg(CONFIG.monitorChannelId,
          `Stream for **${login}** ended unexpectedly (FFmpeg exited with code ${code}).`
        ).catch(() => {});
      }
    });

    streamLivestreamVideo(ffmpeg.stdout, udpConn);
    info('Stream', 'FFmpeg piped to Discord UDP');

    // Live-check polling
    const liveCheckTimer = setInterval(async () => {
      try {
        const stillLive = await isTwitchLive(login);
        if (!stillLive) {
          info('Stream', `${login} went offline — stopping`);
          await sendMsg(CONFIG.monitorChannelId, `**${login}** went offline. Stream stopped.`);
          await stopStream(true);
        }
      } catch (err) {
        warn('LiveCheck', `Interval error: ${err.message}`);
      }
    }, CONFIG.checkIntervalMs);

    currentStream = {
      twitchLogin:    login,
      ffmpegProcess:  ffmpeg,
      liveCheckTimer,
      startedAt:      new Date(),
    };

    info('Stream', `Now streaming ${login}`);
    await sendMsg(triggerChannelId,
      `Now streaming **${login}** in <#${CONFIG.voiceChannelId}>!\n` +
      `Commands: \`!stopstream\` | \`!streamstatus\` | \`!restart\``
    );

  } finally {
    _streamLock = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  STOP STREAM
// ══════════════════════════════════════════════════════════════════════════════
function _cleanup() {
  if (!currentStream) return;
  const { ffmpegProcess, liveCheckTimer } = currentStream;
  clearInterval(liveCheckTimer);
  try { ffmpegProcess.kill('SIGKILL'); } catch (_) {}
  try { streamer.stopStream();         } catch (_) {}
  try { streamer.leaveVoice();         } catch (_) {}
  currentStream = null;
}

async function stopStream(silent = false) {
  if (!currentStream) return;
  const { twitchLogin } = currentStream;
  info('Stream', `Stopping: ${twitchLogin}`);
  _cleanup();
  if (!silent) {
    await sendMsg(CONFIG.monitorChannelId, `Stream stopped.`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════════════════════════════════════════
async function sendMsg(channelId, content) {
  try {
    const ch = await streamer.client.channels.fetch(channelId);
    if (ch?.isText()) await ch.send(content);
  } catch (err) {
    warn('sendMsg', `Could not send to ${channelId}: ${err.message}`);
  }
}

function formatUptime(startedAt) {
  const ms   = Date.now() - startedAt.getTime();
  const secs = Math.floor(ms / 1000) % 60;
  const mins = Math.floor(ms / 60_000) % 60;
  const hrs  = Math.floor(ms / 3_600_000);
  return `${hrs}h ${mins}m ${secs}s`;
}

// ══════════════════════════════════════════════════════════════════════════════
//  DISCORD EVENTS
// ══════════════════════════════════════════════════════════════════════════════
streamer.client.on('ready', () => {
  info('Discord', `Logged in as ${streamer.client.user.tag}`);
  info('Discord', `Monitoring channel : ${CONFIG.monitorChannelId}`);
  info('Discord', `Voice channel      : ${CONFIG.voiceChannelId}`);
  info('Discord', 'Ready. Commands: !stream <url> | !stopstream | !streamstatus | !restart');
});

streamer.client.on('error', err => error('Discord', `Client error: ${err.message}`));

streamer.client.on('messageCreate', async (msg) => {
  const isSelf    = msg.author.id === streamer.client.user?.id;
  const inMonitor = msg.channelId === CONFIG.monitorChannelId;
  const content   = msg.content.trim();

  // ── !stream <url> ────────────────────────────────────────────────────────
  if (isSelf && content.startsWith('!stream ')) {
    const url = content.slice(8).trim();
    if (!url) {
      await msg.channel.send('Usage: `!stream https://twitch.tv/username`');
      return;
    }
    startStream(url, msg.channelId).catch(err => error('Cmd', `!stream: ${err.message}`));
    return;
  }

  // ── !stopstream ──────────────────────────────────────────────────────────
  if (isSelf && content === '!stopstream') {
    if (!currentStream) {
      await msg.channel.send('No stream is currently running.');
    } else {
      await stopStream();
    }
    return;
  }

  // ── !streamstatus ─────────────────────────────────────────────────────────
  if (isSelf && content === '!streamstatus') {
    if (!currentStream) {
      await msg.channel.send('No stream running.');
    } else {
      const uptime = formatUptime(currentStream.startedAt);
      await msg.channel.send(
        `Streaming **${currentStream.twitchLogin}**\n` +
        `Uptime: ${uptime} | Quality: ${CONFIG.streamWidth}x${CONFIG.streamHeight} @ ${CONFIG.streamFps}fps`
      );
    }
    return;
  }

  // ── !restart ─────────────────────────────────────────────────────────────
  if (isSelf && content === '!restart') {
    if (!currentStream) {
      await msg.channel.send('No stream to restart.');
      return;
    }
    const login = currentStream.twitchLogin;
    await msg.channel.send(`Restarting stream for **${login}**...`);
    await stopStream(true);
    startStream(`https://twitch.tv/${login}`, msg.channelId)
      .catch(err => error('Cmd', `!restart: ${err.message}`));
    return;
  }

  // ── Auto-detect Twitch links ──────────────────────────────────────────────
  if (!isSelf && inMonitor) {
    const twitchRegex = /https?:\/\/(www\.)?twitch\.tv\/([a-zA-Z0-9_]+)/gi;
    const matches = [...msg.content.matchAll(twitchRegex)];
    if (matches.length > 0) {
      const url = matches[0][0];
      info('AutoDetect', `Twitch link detected: ${url} from ${msg.author.tag}`);
      startStream(url, CONFIG.monitorChannelId)
        .catch(err => error('AutoDetect', err.message));
    }
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  PROCESS SAFETY NET — nothing here will crash the process
// ══════════════════════════════════════════════════════════════════════════════
process.on('unhandledRejection', reason => {
  error('Process', `Unhandled rejection: ${reason?.message || reason}`);
  // intentionally NOT exiting
});

process.on('uncaughtException', err => {
  error('Process', `Uncaught exception: ${err.message}`);
  error('Process', err.stack || '(no stack)');
  // intentionally NOT exiting
});

process.on('SIGINT',  async () => { info('Process', 'SIGINT — shutting down...'); await stopStream(true).catch(() => {}); process.exit(0); });
process.on('SIGTERM', async () => { info('Process', 'SIGTERM — shutting down...'); await stopStream(true).catch(() => {}); process.exit(0); });

// ══════════════════════════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════════════════════════
info('Boot', '=== Discord Stream Selfbot v2 (hardened) ===');
validateConfig();
checkDependencies();
info('Boot', 'Logging in to Discord...');
streamer.client.login(CONFIG.token);
