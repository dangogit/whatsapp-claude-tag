// Detects "@claude <request>" at the start of a message.

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerRegex(names) {
  const list = (names || []).map(n => String(n).trim().replace(/^@/, '')).filter(Boolean);
  if (!list.length) throw new Error('at least one trigger name is required');
  // WhatsApp may put invisible direction marks before the @ in RTL chats.
  const alt = list.map(escapeRegex).join('|');
  return new RegExp(`^[\\s\\u200e\\u200f\\u202a-\\u202e]*@(${alt})(?=$|[\\s,:;.!?\\-])[\\s,:;\\-]*([\\s\\S]*)$`, 'iu');
}

// Returns { name, request } or null. request may be empty ("@claude" alone).
export function parseTrigger(text, regex) {
  if (typeof text !== 'string' || !text) return null;
  const m = regex.exec(text);
  if (!m) return null;
  return { name: m[1], request: m[2].trim() };
}

const YES = new Set(['כן', 'שלח', 'תשלח', 'מאשר', 'אישור', 'yes', 'y', 'ok', 'send', '👍', '✅']);
const NO = new Set(['לא', 'בטל', 'אל תשלח', 'no', 'n', 'cancel', '❌', '👎']);

// Classifies a reply to an approval draft: 'yes', 'no' or null.
export function approvalAnswer(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!]+$/, '');
  if (YES.has(t)) return 'yes';
  if (NO.has(t)) return 'no';
  return null;
}
