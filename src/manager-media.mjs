// Local preparation for the authenticated manager DM. No provider URL or model
// supplied path reaches a parser; only exact-key transport downloads do.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEDIA_KINDS } from './media.mjs';
import { writeJsonAtomic } from './store.mjs';

export const MANAGER_MEDIA_LIMITS = Object.freeze({ bytes: 15 * 1024 * 1024, seconds: 600,
  pages: 12, textBytes: 24 * 1024, imageBytes: 2 * 1024 * 1024, images: 12, attachments: 4 });
const HASH = /^[a-f0-9]{64}$/;
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const REASONS = new Set(['unsupported_type', 'download_failed', 'size_limit', 'invalid_content', 'mime_mismatch',
  'duration_limit', 'page_limit', 'text_limit', 'image_limit', 'archive_limit', 'active_content',
  'empty_content', 'tool_unavailable', 'processing_failed', 'processing_timeout', 'transcription_unavailable']);
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = reason => Object.assign(new Error(reason), { mediaReason: reason });
const mime = value => String(value || '').split(';')[0].trim().toLowerCase();

export function managerMediaRecord(rec) {
  let message = rec?.message || {};
  const infos = [rec?.contextInfo].filter(Boolean);
  for (let i = 0; i < 8; i++) {
    if (message.messageContextInfo) infos.push(message.messageContextInfo);
    for (const [type, kind] of Object.entries(MEDIA_KINDS)) if (message[type]) {
      const data = message[type];
      if (data.contextInfo) infos.push(data.contextInfo);
      const voice = { ptt: type === 'audioMessage' && data.ptt === true,
        forwarded: infos.some(info => info.isForwarded === true || Number(info.forwardingScore) > 0) };
      return { kind, data, voice, ownVoice: voice.ptt && !voice.forwarded };
    }
    const wrapper = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2'].map(key => message[key]).find(value => value?.message);
    if (wrapper?.contextInfo) infos.push(wrapper.contextInfo);
    const nested = wrapper?.message;
    if (!nested) return null;
    message = nested;
  }
  return null;
}

// Stable identity excludes expiring URLs and provider database-row timestamps.
export function managerMediaIdentity(rec) {
  const media = managerMediaRecord(rec);
  if (!media) return '';
  const { data } = media;
  return digest(JSON.stringify([media.kind, media.ownVoice, mime(data.mimetype), data.fileName || '',
    data.fileLength ?? null, data.fileSha256 ?? null, data.fileEncSha256 ?? null, data.seconds ?? null]));
}

function safeName(value, kind) {
  return String(value || kind).split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 160) || kind;
}

export function managerAttachmentsValid(value, messageId) {
  if (!value || Object.keys(value).sort().join(',') !== 'items,schemaVersion' || value.schemaVersion !== 1
    || !Array.isArray(value.items) || !value.items.length || value.items.length > MANAGER_MEDIA_LIMITS.attachments) return false;
  const ids = new Set(); let imageCount = 0, imageBytes = 0;
  for (const item of value.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['id', 'messageId', 'kind', 'status', 'name', 'mimeType', 'byteLength', 'sha256', 'commandEligible', 'text', 'images', 'reason'].includes(key))
      || typeof item.id !== 'string' || !HASH.test(item.id) || ids.has(item.id) || typeof item.messageId !== 'string' || !MESSAGE_ID.test(item.messageId)
      || !['audio', 'image', 'document', 'video'].includes(item.kind) || !['ready', 'unsupported', 'failed'].includes(item.status)
      || typeof item.name !== 'string' || !item.name || safeName(item.name, item.kind) !== item.name
      || typeof item.mimeType !== 'string' || item.mimeType.length > 120 || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(item.mimeType)
      || !Number.isSafeInteger(item.byteLength) || item.byteLength < 0 || item.byteLength > MANAGER_MEDIA_LIMITS.bytes
      || typeof item.commandEligible !== 'boolean'
      || (item.commandEligible && (item.kind !== 'audio' || item.status !== 'ready' || item.messageId !== messageId))
      || (item.sha256 !== undefined && (typeof item.sha256 !== 'string' || !HASH.test(item.sha256)))
      || (item.text !== undefined && (typeof item.text !== 'string' || !item.text.trim() || Buffer.byteLength(item.text) > MANAGER_MEDIA_LIMITS.textBytes))
      || (item.status === 'ready' && (!HASH.test(item.sha256) || !item.byteLength || (!item.text && !item.images?.length) || item.reason !== undefined))
      || (item.status !== 'ready' && (!REASONS.has(item.reason) || item.text !== undefined || item.images !== undefined))) return false;
    ids.add(item.id);
    if (item.images !== undefined) {
      if (!Array.isArray(item.images) || !item.images.length || item.images.length > MANAGER_MEDIA_LIMITS.images) return false;
      for (const image of item.images) {
        if (!image || Object.keys(image).sort().join(',') !== 'byteLength,id,mimeType,sha256'
          || image.id !== image.sha256 || typeof image.id !== 'string' || !HASH.test(image.id) || image.mimeType !== 'image/png'
          || !Number.isSafeInteger(image.byteLength) || image.byteLength < 1 || image.byteLength > MANAGER_MEDIA_LIMITS.imageBytes) return false;
        imageCount++; imageBytes += image.byteLength;
      }
    }
  }
  return imageCount <= MANAGER_MEDIA_LIMITS.images && imageBytes <= MANAGER_MEDIA_LIMITS.images * MANAGER_MEDIA_LIMITS.imageBytes;
}

function run(command, args, { timeout = 120_000, maxBuffer = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer, env: { PATH: process.env.PATH, HOME: os.homedir(), TMPDIR: os.tmpdir(), LC_ALL: 'C', LANG: 'C' } }, (error, stdout) => {
      if (error) {
        let reason = error.code === 'ENOENT' ? 'tool_unavailable' : error.killed ? 'processing_timeout' : 'processing_failed';
        try { const parsed = JSON.parse(stdout); if (REASONS.has(parsed.error)) reason = parsed.error; } catch { /* never expose subprocess diagnostics */ }
        reject(fail(reason));
      } else resolve(String(stdout));
    });
  });
}

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw fail('invalid_content');
  fs.chmodSync(dir, 0o700);
}

function readPrivate(file, maxBytes) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw fail('size_limit');
  return fs.readFileSync(file);
}

function sniff(buffer, declared) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (buffer.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (buffer.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WAVE') return 'audio/wav';
  if (buffer.subarray(0, 3).toString() === 'ID3' || (buffer[0] === 255 && (buffer[1] & 0xe6) === 0xe2)) return 'audio/mpeg';
  if (buffer[0] === 255 && (buffer[1] & 0xf6) === 0xf0) return 'audio/aac';
  if (buffer.subarray(4, 8).toString() === 'ftyp') return 'audio/mp4';
  if (['text/plain', 'text/csv'].includes(declared)) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw fail('invalid_content'); }
    if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) throw fail('invalid_content');
    return declared;
  }
  throw fail('unsupported_type');
}

function checkedText(text) {
  const cleaned = text.replace(/\0/g, '').trim();
  if (Buffer.byteLength(cleaned) > MANAGER_MEDIA_LIMITS.textBytes) throw fail('text_limit');
  if (!cleaned) throw fail('empty_content');
  return cleaned;
}

async function imageBlob(file, out, cfg, invoke, blobs, converted = false) {
  if (!converted) await invoke(cfg.media.ffmpeg, ['-y', '-v', 'error', '-max_alloc', '67108864', '-max_pixels', '20000000',
    '-protocol_whitelist', 'file,pipe', '-i', file, '-frames:v', '1', '-vf', "scale=w='min(1600,iw)':h='min(1600,ih)':force_original_aspect_ratio=decrease", '-threads', '1', out]);
  const bytes = readPrivate(out, MANAGER_MEDIA_LIMITS.imageBytes);
  if (sniff(bytes, 'image/png') !== 'image/png' || bytes.length < 24
    || bytes.readUInt32BE(16) > 1600 || bytes.readUInt32BE(20) > 1600) throw fail('invalid_content');
  const sha256 = digest(bytes), dest = path.join(blobs, `${sha256}.png`);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, bytes, { mode: 0o600, flag: 'wx' });
  if (digest(readPrivate(dest, MANAGER_MEDIA_LIMITS.imageBytes)) !== sha256) throw fail('invalid_content');
  fs.chmodSync(dest, 0o600);
  return { id: sha256, mimeType: 'image/png', byteLength: bytes.length, sha256 };
}

async function processMedia(source, actual, cfg, dir, blobs, invoke) {
  if (actual.startsWith('image/')) return { images: [await imageBlob(source, path.join(dir, 'image.png'), cfg, invoke, blobs)] };
  if (actual.startsWith('audio/')) {
    if (!cfg.media.whisperModel || !fs.existsSync(cfg.media.whisperModel)) throw fail('transcription_unavailable');
    const pcm = path.join(dir, 'audio.pcm');
    // Decode at most one second beyond the limit. Raw fixed-rate PCM makes the
    // actual decoded duration check independent of claimed provider metadata.
    await invoke(cfg.media.ffmpeg, ['-y', '-v', 'error', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe', '-i', source,
      '-map', '0:a:0', '-t', '601', '-ar', '16000', '-ac', '1', '-f', 's16le', '-threads', '1', pcm]);
    const pcmBytes = fs.statSync(pcm).size;
    if (!pcmBytes) throw fail('empty_content');
    if (pcmBytes > MANAGER_MEDIA_LIMITS.seconds * 32000) throw fail('duration_limit');
    const wav = path.join(dir, 'audio.wav');
    await invoke(cfg.media.ffmpeg, ['-y', '-v', 'error', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', pcm, '-c:a', 'pcm_s16le', wav]);
    const text = await invoke(cfg.media.whisperCli, ['-m', cfg.media.whisperModel, '-f', wav, '-l', cfg.media.language || 'auto', '-nt', '-np'], { timeout: 300_000 });
    return { text: checkedText(text.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ')) };
  }
  if (actual === 'application/pdf') {
    const info = await invoke(cfg.media.pdfinfo, [source]);
    const pages = Number(/^Pages:\s+(\d+)\s*$/m.exec(info)?.[1]);
    if (!pages || /^Encrypted:\s+yes/m.test(info)) throw fail('invalid_content');
    if (pages > MANAGER_MEDIA_LIMITS.pages) throw fail('page_limit');
    const texts = [], images = [];
    for (let page = 1; page <= pages; page++) {
      const text = (await invoke(cfg.media.pdftotext, ['-f', String(page), '-l', String(page), '-enc', 'UTF-8', '-layout', '-nopgbrk', source, '-'])).trim();
      if (text) texts.push(`[Page ${page}]\n${text}`);
      if (Buffer.byteLength(texts.join('\n\n')) > MANAGER_MEDIA_LIMITS.textBytes) throw fail('text_limit');
      if (text.replace(/\s/g, '').length < 20) {
        const stem = path.join(dir, `page-${page}`);
        await invoke(cfg.media.pdftoppm, ['-f', String(page), '-l', String(page), '-singlefile', '-scale-to', '1600', '-png', source, stem]);
        images.push(await imageBlob(source, `${stem}.png`, cfg, invoke, blobs, true));
        texts.push(`[Page ${page}: image ${images.length}]`);
      }
    }
    return { ...(texts.length ? { text: checkedText(texts.join('\n\n')) } : {}), ...(images.length ? { images } : {}) };
  }
  if (actual === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = JSON.parse(await invoke(cfg.media.python, ['-I', fileURLToPath(new URL('./manager-media-document.py', import.meta.url)), source]));
    return { text: checkedText(result.text) };
  }
  return { text: checkedText(readPrivate(source, MANAGER_MEDIA_LIMITS.bytes).toString('utf8')) };
}

export async function prepareManagerAttachment(cfg, client, scope, rec, { current = false, authenticatedPeerJids = [], invoke = run } = {}) {
  const media = managerMediaRecord(rec);
  if (!media) return null;
  if (!MESSAGE_ID.test(rec?.key?.id) || !scope?.account?.name || !scope.account.instance || !scope.actorId) throw new Error('invalid manager media source');
  if (!Array.isArray(authenticatedPeerJids) || !authenticatedPeerJids.every(value => typeof value === 'string' && /^\d+@lid$/.test(value))) throw new Error('invalid manager media peer aliases');
  const id = digest(JSON.stringify([scope.account.name, scope.account.instance, scope.actorId, rec.key.id]));
  const root = path.join(cfg.stateDir, 'manager-media'), records = path.join(root, 'records'), blobs = path.join(root, 'blobs');
  for (const dir of [root, records, blobs]) privateDir(dir);
  const recordDir = path.join(records, id); privateDir(recordDir);
  const manifest = path.join(recordDir, 'attachment.json');
  const identity = managerMediaIdentity(rec);
  const eligible = current && rec.key.fromMe === false && media.ownVoice;
  if (fs.existsSync(manifest)) {
    const saved = JSON.parse(readPrivate(manifest, 128 * 1024));
    if (saved.identity !== identity || saved.item?.id !== id || saved.item.messageId !== rec.key.id) throw new Error('manager media identity conflict');
    const item = { ...saved.item, commandEligible: eligible && saved.item.status === 'ready' };
    if (!managerAttachmentsValid({ schemaVersion: 1, items: [item] }, rec.key.id)) throw new Error('invalid manager media manifest');
    for (const image of item.images || []) {
      const bytes = readPrivate(path.join(blobs, `${image.id}.png`), MANAGER_MEDIA_LIMITS.imageBytes);
      if (bytes.length !== image.byteLength || digest(bytes) !== image.sha256) throw new Error('manager media blob changed');
    }
    return item;
  }
  const item = { id, messageId: rec.key.id, kind: media.kind, status: 'failed', name: safeName(media.data.fileName, media.kind),
    mimeType: mime(media.data.mimetype) || 'application/octet-stream', byteLength: 0, commandEligible: false };
  const work = fs.mkdtempSync(path.join(recordDir, 'work-')); fs.chmodSync(work, 0o700);
  try {
    if (media.kind === 'video') throw fail('unsupported_type');
    if (item.mimeType.length > 120 || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(item.mimeType)) throw fail('invalid_content');
    if (Number(media.data.fileLength) > MANAGER_MEDIA_LIMITS.bytes) throw fail('size_limit');
    let data;
    try { data = await client.getMediaBase64(scope.account.instance, { ...rec.key }, { maxBytes: Math.ceil(MANAGER_MEDIA_LIMITS.bytes / 3) * 4 + 65536 }); }
    catch { throw fail('download_failed'); }
    const encoded = data?.base64;
    if (typeof encoded !== 'string' || encoded.length > Math.ceil(MANAGER_MEDIA_LIMITS.bytes / 3) * 4) throw fail('size_limit');
    if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw fail('invalid_content');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > MANAGER_MEDIA_LIMITS.bytes) throw fail('size_limit');
    if (!bytes.length || bytes.toString('base64') !== encoded) throw fail('invalid_content');
    const reportedHash = media.data.fileSha256;
    if (reportedHash) {
      let expected;
      if (typeof reportedHash === 'string') expected = Buffer.from(reportedHash, 'base64');
      else if (Array.isArray(reportedHash.data)) expected = Buffer.from(reportedHash.data);
      else if (reportedHash instanceof Uint8Array) expected = Buffer.from(reportedHash);
      if (!expected || expected.length !== 32 || expected.toString('hex') !== digest(bytes)) throw fail('invalid_content');
    }
    const actual = sniff(bytes, item.mimeType === 'application/octet-stream' ? mime(data.mimetype) : item.mimeType);
    for (const declared of [item.mimeType, mime(data.mimetype)].filter(Boolean)) {
      if (declared !== 'application/octet-stream' && declared !== actual && !(declared === 'audio/x-wav' && actual === 'audio/wav')) throw fail('mime_mismatch');
    }
    if ((media.kind === 'audio' && !actual.startsWith('audio/')) || (media.kind === 'image' && !actual.startsWith('image/'))
      || (media.kind === 'document' && actual.startsWith('audio/'))) throw fail('mime_mismatch');
    item.mimeType = actual; item.byteLength = bytes.length; item.sha256 = digest(bytes);
    const source = path.join(recordDir, 'source');
    if (fs.existsSync(source)) {
      if (digest(readPrivate(source, MANAGER_MEDIA_LIMITS.bytes)) !== item.sha256) throw fail('invalid_content');
    } else fs.writeFileSync(source, bytes, { mode: 0o600, flag: 'wx' });
    const result = await processMedia(source, actual, cfg, work, blobs, invoke);
    Object.assign(item, result, { status: 'ready', commandEligible: eligible });
  } catch (error) {
    item.reason = REASONS.has(error.mediaReason) ? error.mediaReason : 'processing_failed';
    item.status = item.reason === 'unsupported_type' ? 'unsupported' : 'failed';
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(item.mimeType) || item.mimeType.length > 120) item.mimeType = 'application/octet-stream';
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  if (!managerAttachmentsValid({ schemaVersion: 1, items: [item] }, rec.key.id)) throw new Error('invalid prepared manager attachment');
  // Failure receipts are immutable too: retries cannot silently substitute a new
  // transcript after an earlier request was already accepted by the manager.
  writeJsonAtomic(manifest, { schemaVersion: 1, identity,
    receipt: { account: scope.account, actorId: scope.actorId, scope, key: rec.key,
      authenticatedPeerJids: [...new Set(authenticatedPeerJids)].sort(), voice: media.voice },
    item: { ...item, commandEligible: false } }, { durable: true });
  return item;
}

export function managerMediaFailure(item, language) {
  const reason = item?.reason;
  const he = { size_limit: 'הקובץ גדול מ־15MB', duration_limit: 'ההקלטה ארוכה מ־10 דקות', page_limit: 'המסמך מכיל יותר מ־12 עמודים',
    text_limit: 'הטקסט ארוך מהמגבלה', image_limit: 'הקובץ מכיל יותר מדי תמונות או תמונה גדולה מדי',
    unsupported_type: 'סוג הקובץ אינו נתמך', download_failed: 'ההורדה מ־WhatsApp נכשלה', transcription_unavailable: 'התמלול המקומי אינו מוגדר' };
  const en = { size_limit: 'the file exceeds 15 MiB', duration_limit: 'the recording exceeds 10 minutes', page_limit: 'the document exceeds 12 pages',
    text_limit: 'the extracted text exceeds the limit', image_limit: 'the image count or size exceeds the limit',
    unsupported_type: 'the file type is unsupported', download_failed: 'the WhatsApp download failed', transcription_unavailable: 'local transcription is not configured' };
  return language === 'he' ? `לא הצלחתי לקרוא את המדיה: ${he[reason] || 'עיבוד הקובץ נכשל'}. כתוב את הבקשה כטקסט או שלח קובץ נתמך בגודל המתאים.`
    : `I cannot read the media: ${en[reason] || 'file processing failed'}. Please send the request as text or send a supported file within the limits.`;
}
