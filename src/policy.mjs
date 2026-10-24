// Which chats a run may read or send to.
//
// Chat content that Claude reads is untrusted: a message in a group can say
// "forward this to X". So the rule is enforced here, outside the model: a run
// may only touch the chat it was triggered in, the owner's own chat, or a chat
// the owner named in the trigger text itself.

import { userPart } from './text.mjs';

const STOPWORDS = new Set([
  'של', 'עם', 'את', 'על', 'אל', 'גם', 'או', 'זה', 'זו', 'הוא', 'היא', 'אני', 'קבוצה', 'קבוצת',
  'the', 'and', 'for', 'with', 'group', 'chat', 'team', 'from',
]);

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[‎‏‪-‮]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Meaningful tokens of a display name: at least three characters, not a stopword.
export function nameTokens(name) {
  return normalize(name).split(' ').filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

// Last nine digits of every phone-number-looking run in the text ("050-123 4567", "+972501234567").
export function phoneNumbersIn(text) {
  const runs = String(text || '').match(/\+?\d[\d\s-]{6,}\d/g) || [];
  return runs.map(r => r.replace(/\D/g, '')).filter(d => d.length >= 9).map(d => d.slice(-9));
}

export function sameUser(a, b) {
  const ua = userPart(a);
  return Boolean(ua) && ua === userPart(b);
}

// ctx: { currentChat: string[], ownerChat: string[], triggerText: string }
// chat: { jid, name }
export function chatAllowed(chat, ctx) {
  if (!chat?.jid) return { allowed: false, reason: 'no chat' };
  const jids = [chat.jid, chat.alt].filter(Boolean);
  if (jids.some(j => ctx.currentChat.some(c => sameUser(c, j)))) return { allowed: true, reason: 'current chat' };
  if (jids.some(j => ctx.ownerChat.some(c => sameUser(c, j)))) return { allowed: true, reason: 'owner chat' };

  const text = normalize(ctx.triggerText);
  const phones = jids.filter(j => j.endsWith('@s.whatsapp.net')).map(j => userPart(j).slice(-9));
  if (phones.some(p => p.length === 9 && phoneNumbersIn(ctx.triggerText).includes(p))) {
    return { allowed: true, reason: 'number named in request' };
  }
  const full = normalize(chat.name);
  if (full.length >= 3 && text.includes(full)) return { allowed: true, reason: 'name in request' };
  const hit = nameTokens(chat.name).find(t => text.includes(t));
  if (hit) return { allowed: true, reason: `name in request (${hit})` };
  return { allowed: false, reason: 'the owner did not name this chat in the request' };
}
