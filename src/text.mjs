// Helpers for reading Evolution API message records and WhatsApp JIDs.

export function userPart(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

export function isGroupJid(jid) {
  return String(jid || '').endsWith('@g.us');
}

function textOf(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.conversation === 'string') return message.conversation;
  for (const k of ['extendedTextMessage', 'imageMessage', 'videoMessage', 'documentMessage']) {
    const v = message[k];
    if (v && typeof v === 'object') {
      if (typeof v.text === 'string') return v.text;
      if (typeof v.caption === 'string') return v.caption;
    }
  }
  for (const k of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'editedMessage']) {
    const inner = message[k]?.message;
    if (inner) return textOf(inner);
  }
  return '';
}

const MEDIA_LABELS = {
  imageMessage: '[image]',
  videoMessage: '[video]',
  audioMessage: '[audio]',
  documentMessage: '[document]',
  stickerMessage: '[sticker]',
};

// Text of a record, or a [media] label when it has no text.
export function messageText(rec) {
  const message = rec?.message || {};
  const text = textOf(message);
  if (text) return text;
  for (const [k, label] of Object.entries(MEDIA_LABELS)) {
    if (message[k]) return label;
  }
  return '';
}

// Evolution flattens contextInfo onto the record; older payloads keep it on the message.
function contextInfo(rec) {
  if (rec?.contextInfo) return rec.contextInfo;
  let message = rec?.message || {};
  for (let depth = 0; depth < 8; depth++) {
    for (const key of ['extendedTextMessage', 'imageMessage', 'audioMessage', 'documentMessage', 'videoMessage']) {
      if (message[key]?.contextInfo) return message[key].contextInfo;
    }
    message = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2'].map(key => message[key]?.message).find(Boolean);
    if (!message) break;
  }
  return null;
}

export function quotedText(rec) {
  const quoted = contextInfo(rec)?.quotedMessage;
  if (!quoted) return '';
  return textOf(quoted) || Object.entries(MEDIA_LABELS).find(([k]) => quoted[k])?.[1] || '';
}

export function quotedId(rec) {
  return contextInfo(rec)?.stanzaId || '';
}

export function timestampOf(rec) {
  const ts = Number(rec?.messageTimestamp);
  return Number.isFinite(ts) ? ts : 0;
}
