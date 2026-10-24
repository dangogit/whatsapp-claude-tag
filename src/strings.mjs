// The few messages the tool itself writes. Claude writes everything else in the request's language.

const STRINGS = {
  en: {
    failed: '⚠️ @{name} could not finish: {error}',
    approvedSent: '✅ Sent to {target}.',
    approvalDropped: '🗑️ Dropped, nothing was sent to {target}.',
    approvalFailed: '⚠️ Sending to {target} failed: {error}',
    sentReceipt: '📤 Sent to {target}.',
    draft: '📝 Draft for {target}:\n\n{text}\n\nReply to this message with "yes" to send it or "no" to drop it.',
    approvalExpired: '⌛ That draft for {target} is over a day old, so it was not sent. Ask again if you still want it.',
    interrupted: '⚠️ A run was interrupted before it finished and was not retried: "{request}". Check what was sent and ask again if needed.',
    you: 'you',
  },
  he: {
    failed: '⚠️ @{name} לא הצליח לסיים: {error}',
    approvedSent: '✅ נשלח ל{target}.',
    approvalDropped: '🗑️ בוטל, לא נשלח כלום ל{target}.',
    approvalFailed: '⚠️ השליחה ל{target} נכשלה: {error}',
    sentReceipt: '📤 נשלח ל{target}.',
    draft: '📝 טיוטה ל{target}:\n\n{text}\n\nתגיב להודעה הזו ב"כן" כדי לשלוח או ב"לא" כדי לבטל.',
    approvalExpired: '⌛ הטיוטה ל{target} בת יותר מיום, אז היא לא נשלחה. תבקש שוב אם עדיין צריך.',
    interrupted: '⚠️ ריצה נקטעה לפני שהסתיימה ולא הורצה שוב: "{request}". תבדוק מה נשלח ותבקש שוב אם צריך.',
    you: 'עצמך',
  },
};

export function t(language, key, vars = {}) {
  const table = STRINGS[language] || STRINGS.en;
  return (table[key] || STRINGS.en[key]).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

export const LANGUAGES = Object.keys(STRINGS);
