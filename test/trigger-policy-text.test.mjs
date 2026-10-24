import assert from 'node:assert/strict';
import test from 'node:test';
import { chatAllowed, nameTokens, phoneNumbersIn } from '../src/policy.mjs';
import { messageText, quotedId, quotedText, userPart } from '../src/text.mjs';
import { approvalAnswer, buildTriggerRegex, defuseTrigger, parseTrigger } from '../src/trigger.mjs';

const re = buildTriggerRegex(['claude']);

test('trigger matches @claude at the start, any case, with a separator', () => {
  assert.deepEqual(parseTrigger('@claude summarize today', re), { name: 'claude', request: 'summarize today' });
  assert.deepEqual(parseTrigger('@Claude, תסכם לי את היום', re), { name: 'Claude', request: 'תסכם לי את היום' });
  assert.deepEqual(parseTrigger('‏@CLAUDE: do it', re), { name: 'CLAUDE', request: 'do it' });
  assert.deepEqual(parseTrigger('@claude', re), { name: 'claude', request: '' });
  assert.equal(parseTrigger('@claude\nline two', re).request, 'line two');
});

test('trigger ignores mentions that are not at the start or are other words', () => {
  assert.equal(parseTrigger('hi @claude do it', re), null);
  assert.equal(parseTrigger('@claudette do it', re), null);
  assert.equal(parseTrigger('claude do it', re), null);
  assert.equal(parseTrigger('', re), null);
  assert.equal(parseTrigger(undefined, re), null);
});

test('custom trigger names, with or without @, and escaped', () => {
  const r = buildTriggerRegex(['@jarvis', 'קלוד', 'c.3']);
  assert.equal(parseTrigger('@jarvis go', r).request, 'go');
  assert.equal(parseTrigger('@קלוד תעשה', r).request, 'תעשה');
  assert.equal(parseTrigger('@cx3 go', r), null);
  assert.throws(() => buildTriggerRegex([]));
});

test('approval answers', () => {
  assert.equal(approvalAnswer('כן'), 'yes');
  assert.equal(approvalAnswer(' Yes! '), 'yes');
  assert.equal(approvalAnswer('שלח'), 'yes');
  assert.equal(approvalAnswer('לא'), 'no');
  assert.equal(approvalAnswer('cancel'), 'no');
  assert.equal(approvalAnswer('כן אבל תשנה'), null);
});

const ctx = {
  currentChat: ['120363000000000001@g.us'],
  ownerChat: ['972500000001@s.whatsapp.net'],
  triggerText: 'תעתיק את זה ותשלח ליוסי ולקבוצת המשפחה',
};

test('policy allows the current chat and the owner chat, including the owner LID alias', () => {
  assert.equal(chatAllowed({ jid: '120363000000000001@g.us' }, ctx).allowed, true);
  assert.equal(chatAllowed({ jid: '972500000001@s.whatsapp.net' }, ctx).allowed, true);
  assert.equal(chatAllowed({ jid: '999@lid', alt: '972500000001@s.whatsapp.net' }, ctx).allowed, true);
});

test('policy allows chats the owner named, with Hebrew prefixes', () => {
  assert.equal(chatAllowed({ jid: '972511111111@s.whatsapp.net', name: 'יוסי כהן' }, ctx).allowed, true);
  assert.equal(chatAllowed({ jid: '120363000000000002@g.us', name: 'המשפחה 👨‍👩‍👧' }, ctx).allowed, true);
});

test('policy refuses chats the owner did not name (prompt injection guard)', () => {
  assert.equal(chatAllowed({ jid: '972522222222@s.whatsapp.net', name: 'Attacker' }, ctx).allowed, false);
  // "של" appears in the request but is a stopword, so it cannot unlock a group called "חברים של דני".
  const c2 = { ...ctx, triggerText: 'תסכם את השיחה של היום' };
  assert.equal(chatAllowed({ jid: '120363000000000003@g.us', name: 'חברים של דני' }, c2).allowed, false);
  assert.equal(chatAllowed({ jid: '' }, ctx).allowed, false);
});

test('policy matches whole words only, and never on common request words', () => {
  const c = { ...ctx, triggerText: '@claude תסכם לי את ההודעות של היום ותשלח לי' };
  // A contact that named itself after a word the owner types cannot be unlocked by it.
  assert.equal(chatAllowed({ jid: '972533333333@s.whatsapp.net', name: 'היום' }, c).allowed, false);
  assert.equal(chatAllowed({ jid: '972533333333@s.whatsapp.net', name: 'Today Summary' }, { ...c, triggerText: 'summarize today' }).allowed, false);
  // Substrings are not names.
  const c2 = { ...ctx, triggerText: 'תשלח ליוסיפון' };
  assert.equal(chatAllowed({ jid: '972511111111@s.whatsapp.net', name: 'יוסי' }, c2).allowed, false);
  assert.equal(chatAllowed({ jid: '972511111111@s.whatsapp.net', name: 'משה' }, { ...ctx, triggerText: 'תשלח למשה' }).allowed, true);
  assert.equal(chatAllowed({ jid: '972511111111@s.whatsapp.net', name: 'Dana Levi' }, { ...ctx, triggerText: 'send it to dana' }).allowed, true);
});

test('defuseTrigger only touches a leading @', () => {
  assert.equal(parseTrigger(defuseTrigger('@claude x'), re), null);
  assert.equal(defuseTrigger('hi @claude'), 'hi @claude');
  assert.equal(parseTrigger(defuseTrigger('‏ @Claude x'), re), null);
});

test('policy allows a phone number written in the request', () => {
  const c = { ...ctx, triggerText: 'send this to 050-123 4567 please' };
  assert.equal(chatAllowed({ jid: '972501234567@s.whatsapp.net', name: '' }, c).allowed, true);
  assert.equal(chatAllowed({ jid: '972501234568@s.whatsapp.net', name: '' }, c).allowed, false);
  assert.deepEqual(phoneNumbersIn('call +972 50 123 4567 or 24 hours'), ['501234567']);
});

test('name tokens drop short words and stopwords', () => {
  assert.deepEqual(nameTokens('Team of AI builders'), ['builders']);
});

test('message text, quoted text and ids from Evolution records', () => {
  assert.equal(messageText({ message: { conversation: 'hi' } }), 'hi');
  assert.equal(messageText({ message: { extendedTextMessage: { text: 'yo' } } }), 'yo');
  assert.equal(messageText({ message: { ephemeralMessage: { message: { conversation: 'eph' } } } }), 'eph');
  assert.equal(messageText({ message: { imageMessage: { caption: 'pic' } } }), 'pic');
  assert.equal(messageText({ message: { audioMessage: {} } }), '[audio]');
  assert.equal(messageText({ message: { protocolMessage: { type: 'REVOKE' } } }), '');
  const rec = { contextInfo: { stanzaId: 'Q1', quotedMessage: { conversation: 'original' } } };
  assert.equal(quotedText(rec), 'original');
  assert.equal(quotedId(rec), 'Q1');
  assert.equal(quotedText({}), '');
  assert.equal(userPart('972500000001:12@s.whatsapp.net'), '972500000001');
});
