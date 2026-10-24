// Which chats a run may read or send to.
//
// Chat content that Claude reads is untrusted: a message in a group can say
// "forward this to X". So the rule is enforced here, outside the model: a run
// may only touch the chat it was triggered in, the owner's own chat, or a chat
// the owner named in the trigger text itself.

import { userPart } from './text.mjs';

// Display names are chosen by other people (pushName, group subject), so a contact
// could name itself after a word the owner is likely to type. Words that commonly
// appear in requests never count as naming a chat.
const STOPWORDS = new Set([
  'של', 'עם', 'את', 'על', 'אל', 'גם', 'או', 'זה', 'זו', 'הוא', 'היא', 'אני', 'אתה', 'קבוצה', 'קבוצת',
  'היום', 'אתמול', 'מחר', 'עכשיו', 'כאן', 'פה', 'כל', 'הכל', 'סיכום', 'תסכם', 'סכם', 'הודעה', 'הודעות',
  'שיחה', 'שיחות', 'תשלח', 'שלח', 'תעתיק', 'תכתוב', 'תמחק', 'אליי', 'אלי', 'לי', 'בפרטי', 'פרטי',
  'בבקשה', 'בקשה', 'תודה', 'שעה', 'שעות', 'דקות', 'יום', 'ימים', 'שבוע', 'חודש', 'אחרונות', 'אחרונים',
  'אחרון', 'אחרונה', 'מה', 'מי', 'איך', 'למה', 'לפני', 'אחרי', 'רק', 'עוד', 'טוב', 'אותו', 'אותה',
  'אותם', 'תאשר', 'אישור', 'תענה', 'תגיד', 'תכין', 'תבדוק', 'תמצא', 'קצר', 'בקצרה', 'נקודות',
  'the', 'and', 'for', 'with', 'group', 'chat', 'team', 'from', 'today', 'yesterday', 'tomorrow',
  'summary', 'summarize', 'message', 'messages', 'send', 'copy', 'write', 'delete', 'here', 'this',
  'that', 'all', 'private', 'privately', 'please', 'reply', 'claude', 'hour', 'hours', 'minute',
  'minutes', 'day', 'days', 'week', 'month', 'last', 'first', 'what', 'who', 'how', 'why', 'before',
  'after', 'only', 'thanks', 'approve', 'ask', 'tell', 'short', 'points', 'bullet', 'bullets',
]);

// Hebrew attaches one or two letters (ו ה ל ב מ ש כ) to the front of a name: "ליוסי", "ולדנה".
const HEBREW_PREFIX = /^[והלבמשכ]{1,2}/u;

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
  // Stopwords are dropped on the request side too: "היום" minus its prefix is "יום",
  // and a contact called "יום" must not be unlocked by the word "today".
  const words = text.split(' ').filter(w => w && !STOPWORDS.has(w));
  const full = normalize(chat.name);
  if (full.includes(' ') && nameTokens(chat.name).length && ` ${text} `.includes(` ${full} `)) {
    return { allowed: true, reason: 'name in request' };
  }
  const hit = nameTokens(chat.name).find(t => words.some(w => wordNames(w, t)));
  if (hit) return { allowed: true, reason: `name in request (${hit})` };
  return { allowed: false, reason: 'the owner did not name this chat in the request' };
}

// Whole-word match, allowing a Hebrew prefix: "ליוסי" names "יוסי", "יוסיפון" does not.
function wordNames(word, token) {
  if (word === token) return true;
  const m = HEBREW_PREFIX.exec(word);
  if (!m) return false;
  for (let n = m[0].length; n >= 1; n -= 1) {
    if (word.slice(n) === token) return true;
  }
  return false;
}
