// Media for runs: download what a message carries, transcribe voice notes, speak replies.
//
// Transcription uses whisper.cpp (`whisper-cli` and a ggml model file) and ffmpeg.
// Speech uses the macOS `say` command (Hebrew voice Carmit) and ffmpeg for Opus.
// Each piece is optional: a missing tool turns into a clear error, not a crash.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac',
  'application/pdf': '.pdf',
};
export const MEDIA_KINDS = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio', documentMessage: 'document', stickerMessage: 'image' };

// The media kind a message record carries, or ''.
export function mediaKind(rec) {
  const m = rec?.message || {};
  for (const [k, kind] of Object.entries(MEDIA_KINDS)) if (m[k]) return kind;
  for (const w of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2']) {
    const inner = m[w]?.message;
    if (inner) return mediaKind({ message: inner });
  }
  return '';
}

export function quotedMediaKind(rec) {
  const ci = rec?.contextInfo || rec?.message?.extendedTextMessage?.contextInfo || null;
  return ci?.quotedMessage ? mediaKind({ message: ci.quotedMessage }) : '';
}

function run(cmd, args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') return reject(new Error(`${cmd} is not installed`));
        return reject(new Error(`${path.basename(cmd)} failed: ${String(stderr || err.message).trim().split('\n').pop()}`));
      }
      resolve(String(stdout));
    });
  });
}

// Download a message's media into dir. Returns { file, mimetype, kind, size }.
export async function saveMedia(client, instance, messageId, dir) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(messageId))) throw new Error('bad message id');
  const data = await client.getMediaBase64(instance, messageId);
  if (!data?.base64) throw new Error('this message has no downloadable media');
  const mimetype = String(data.mimetype || '').split(';')[0];
  const ext = EXT[mimetype] || path.extname(String(data.fileName || '')) || '.bin';
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${messageId}${ext}`);
  fs.writeFileSync(file, Buffer.from(data.base64, 'base64'), { mode: 0o600 });
  const kind = mimetype.startsWith('image/') ? 'image' : mimetype.startsWith('audio/') ? 'audio'
    : mimetype.startsWith('video/') ? 'video' : 'document';
  return { file, mimetype, kind, size: fs.statSync(file).size };
}

// Speech to text. cfg.media: { whisperCli, whisperModel, ffmpeg, language }
export async function transcribe(file, media) {
  if (!media.whisperModel || !fs.existsSync(media.whisperModel)) {
    throw new Error('voice transcription is not set up: config.media.whisperModel must point at a whisper.cpp ggml model file');
  }
  const wav = `${file}.16k.wav`;
  await run(media.ffmpeg, ['-y', '-v', 'error', '-i', file, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
  try {
    const out = await run(media.whisperCli, ['-m', media.whisperModel, '-f', wav, '-l', media.language || 'auto', '-nt', '-np'], 300_000);
    return out.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  } finally {
    fs.rmSync(wav, { force: true });
  }
}

const HEBREW = /[֐-׿]/;

// Text to an Opus voice note. Returns the .ogg path.
export async function synthesize(text, dir, media) {
  const t = String(text || '').trim();
  if (!t) throw new Error('text is empty');
  if (t.length > 3000) throw new Error('text is too long for a voice note (3000 characters max)');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stem = path.join(dir, `voice-${Date.now()}`);
  const voice = HEBREW.test(t) ? media.voiceHebrew : media.voiceOther;
  // `say` reads the text from a file, so nothing in it is ever parsed as an option.
  fs.writeFileSync(`${stem}.txt`, t, { mode: 0o600 });
  await run(media.tts, [...(voice ? ['-v', voice] : []), '-f', `${stem}.txt`, '-o', `${stem}.aiff`]);
  await run(media.ffmpeg, ['-y', '-v', 'error', '-i', `${stem}.aiff`, '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-ar', '48000', `${stem}.ogg`]);
  fs.rmSync(`${stem}.txt`, { force: true });
  fs.rmSync(`${stem}.aiff`, { force: true });
  return `${stem}.ogg`;
}

const SEND_KIND = [
  [/\.(jpe?g|png|webp|gif)$/i, 'image'], [/\.(mp4|mov|m4v)$/i, 'video'], [/\.(ogg|opus|mp3|m4a|aac|wav)$/i, 'audio'],
];
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.pdf': 'application/pdf' };

export function sendKind(file) {
  for (const [re, kind] of SEND_KIND) if (re.test(file)) return kind;
  return 'document';
}

export function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// A file may be sent only from inside one of the allowed roots (after resolving links).
export function insideRoots(file, roots) {
  let real;
  try { real = fs.realpathSync(file); } catch { return false; }
  return roots.some(r => {
    let rr;
    try { rr = fs.realpathSync(r); } catch { return false; }
    return real === rr || real.startsWith(rr + path.sep);
  });
}
