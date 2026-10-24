// The few messages the tool itself writes. Claude writes everything else in the request's language.

const STRINGS = {
  en: {
    failed: '⚠️ @{name} could not finish: {error}',
    approvedSent: '✅ Sent to {target}.',
    approvalDropped: '🗑️ Dropped, nothing was sent to {target}.',
    approvalFailed: '⚠️ Sending to {target} failed: {error}',
  },
  he: {
    failed: '⚠️ @{name} לא הצליח לסיים: {error}',
    approvedSent: '✅ נשלח ל{target}.',
    approvalDropped: '🗑️ בוטל, לא נשלח כלום ל{target}.',
    approvalFailed: '⚠️ השליחה ל{target} נכשלה: {error}',
  },
};

export function t(language, key, vars = {}) {
  const table = STRINGS[language] || STRINGS.en;
  return (table[key] || STRINGS.en[key]).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

export const LANGUAGES = Object.keys(STRINGS);
