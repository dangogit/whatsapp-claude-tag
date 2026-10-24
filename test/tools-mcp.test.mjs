import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { normalizeConfig } from '../src/config.mjs';
import { createMcpHandler, serveStdio } from '../src/mcp.mjs';
import { AccountStore, readActions } from '../src/store.mjs';
import { createTools } from '../src/tools.mjs';
import { FakeClient, OWNER, msg, tmpDir } from './helpers.mjs';

const GROUP = '120363000000000001@g.us';
const NOW = 1_800_000_000_000;

function setup({ request = 'תסכם את היום', messages = [], chat } = {}) {
  const dir = tmpDir();
  const store = new AccountStore(dir, 'personal');
  const jobDir = store.jobDir('T1');
  const client = new FakeClient({
    messages,
    groups: [{ id: GROUP, subject: 'Builders' }, { id: '120363000000000009@g.us', subject: 'משפחה' }],
    contacts: [
      { remoteJid: '972511111111@s.whatsapp.net', pushName: 'יוסי כהן' },
      { remoteJid: '972522222222@s.whatsapp.net', pushName: 'Mallory' },
      { remoteJid: '5555@lid', pushName: 'Dana' },
    ],
  });
  const job = {
    id: 'T1',
    account: { name: 'personal', instance: 'inst' },
    chat: chat || { jid: GROUP, alt: '', name: 'Builders', isGroup: true, isOwnerChat: false, sendTo: GROUP },
    ownerChat: OWNER,
    ownerJids: [OWNER],
    trigger: { key: { id: 'TRIG', remoteJid: GROUP, fromMe: true }, request, quoted: '' },
    replyPrefix: '',
    timezone: 'Asia/Jerusalem',
  };
  const names = new Map([[GROUP, 'Builders'], ['120363000000000009@g.us', 'משפחה'],
    ['972511111111@s.whatsapp.net', 'יוסי כהן'], ['972522222222@s.whatsapp.net', 'Mallory'], ['5555@lid', 'Dana']]);
  const tools = Object.fromEntries(createTools({
    client, store, job, jobDir, getNames: async () => names, now: () => NOW,
  }).map(t => [t.name, t.handler]));
  return { client, store, jobDir, job, tools };
}

test('send_message to current answers in the tagged chat and records the send', async () => {
  const { client, store, jobDir, tools } = setup();
  const out = await tools.send_message({ chat: 'current', text: 'סיכום', reply_to_trigger: true });
  assert.match(out, /sent to Builders/);
  assert.equal(client.sent[0].number, GROUP);
  assert.equal(client.sent[0].quotedId, 'TRIG');
  assert.ok(store.sentIds().has('SENT1'));
  assert.deepEqual(readActions(jobDir).map(a => a.type), ['send']);
});

test('send_message to owner goes to the owner chat', async () => {
  const { client, tools } = setup();
  await tools.send_message({ chat: 'owner', text: 'פרטי' });
  assert.equal(client.sent[0].number, OWNER);
});

test('send_message refuses a chat the owner did not name, and receipts a third-chat send', async () => {
  const { client, store, tools } = setup({ request: 'תסכם ותשלח ליוסי' });
  await assert.rejects(tools.send_message({ chat: '972522222222@s.whatsapp.net', text: 'x' }), /refused: Mallory/);
  await tools.send_message({ chat: '972511111111@s.whatsapp.net', text: 'ok' });
  assert.equal(client.sent.length, 2);
  assert.equal(client.sent[0].number, '972511111111@s.whatsapp.net');
  assert.equal(client.sent[1].number, OWNER);
  assert.match(client.sent[1].text, /יוסי כהן/);
  assert.ok(store.sentIds().has('SENT2'));
});

test('outgoing text that starts with @ cannot re-trigger', async () => {
  const { client, tools } = setup();
  await tools.send_message({ chat: 'current', text: '@claude do it again' });
  assert.equal(client.sent[0].text, '@⁠claude do it again');
  assert.equal(client.sent.length, 1); // the current chat gets no receipt
});

test('find_chat marks which candidates are allowed', async () => {
  const { tools } = setup({ request: 'send it to yossi' });
  const none = await tools.find_chat({ query: 'nobody' });
  assert.match(none, /No chat matches/);
  const hits = JSON.parse(await tools.find_chat({ query: 'יוסי' }));
  assert.equal(hits[0].jid, '972511111111@s.whatsapp.net');
  assert.equal(hits[0].allowed, false); // "yossi" in Latin letters does not name "יוסי כהן"
});

test('read_chat returns the window oldest first, names senders, skips the trigger', async () => {
  const ts = NOW / 1000;
  const messages = [
    msg({ chat: GROUP, text: 'old', ts: ts - 30 * 3600, fromMe: false }),
    msg({ chat: GROUP, text: 'first', ts: ts - 3600, fromMe: false, participant: '5555@lid', pushName: '5555' }),
    msg({ chat: GROUP, text: 'second', ts: ts - 60, fromMe: true }),
    msg({ id: 'TRIG', chat: GROUP, text: '@claude summarize', ts: ts - 10 }),
  ];
  const { tools } = setup({ messages });
  const out = await tools.read_chat({ chat: 'current' });
  const lines = out.split('\n');
  assert.match(lines[0], /Builders \(2 messages, last 24h\)/);
  assert.match(lines[1], /Dana: first$/);
  assert.match(lines[2], /me: second$/);
  assert.equal(out.includes('@claude'), false);
});

test('request_approval posts a draft to the owner and stores it as pending', async () => {
  const { client, store, tools } = setup({ request: 'תכתוב ליוסי שאני מאחר, תאשר איתי' });
  await tools.request_approval({ chat: '972511111111@s.whatsapp.net', text: 'אני מאחר' });
  assert.equal(client.sent[0].number, OWNER);
  assert.match(client.sent[0].text, /יוסי כהן/);
  const pending = store.getPending('SENT1');
  assert.equal(pending.target.sendTo, '972511111111@s.whatsapp.net');
  assert.equal(pending.text, 'אני מאחר');
});

test('delete_trigger_message deletes once', async () => {
  const { client, tools } = setup();
  assert.equal(await tools.delete_trigger_message({}), 'deleted for everyone');
  assert.equal(await tools.delete_trigger_message({}), 'already deleted');
  assert.equal(client.deleted.length, 1);
  assert.equal(client.deleted[0].key.id, 'TRIG');
});

test('mcp handler: initialize, list, call, errors, notifications', async () => {
  const handle = createMcpHandler({
    name: 'x', version: '1',
    tools: [
      { name: 'ok', description: 'd', inputSchema: { type: 'object' }, handler: async a => `hi ${a.n}` },
      { name: 'bad', description: 'd', inputSchema: { type: 'object' }, handler: async () => { throw new Error('nope'); } },
    ],
  });
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map(t => t.name), ['ok', 'bad']);
  assert.equal(list.result.tools[0].handler, undefined);
  const call = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ok', arguments: { n: 5 } } });
  assert.equal(call.result.content[0].text, 'hi 5');
  const bad = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bad' } });
  assert.equal(bad.result.isError, true);
  const unknown = await handle({ jsonrpc: '2.0', id: 5, method: 'nope' });
  assert.equal(unknown.error.code, -32601);
});

test('mcp stdio transport answers line by line', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const handle = createMcpHandler({ name: 'x', version: '1', tools: [] });
  serveStdio(handle, { input, output });
  const reply = new Promise(resolve => output.once('data', d => resolve(JSON.parse(String(d)))));
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })}\n`);
  assert.deepEqual(await reply, { jsonrpc: '2.0', id: 7, result: {} });
});

test('config: validates, reads the key from env or an env file, hides the key', () => {
  const dir = tmpDir();
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'OTHER=1\nEVOLUTION_API_KEY="secret-from-file"\n');
  const base = { accounts: [{ name: 'personal', instance: 'p' }], stateDir: dir };
  assert.throws(() => normalizeConfig({ ...base }, {}), /no Evolution API key/);
  const fromEnv = normalizeConfig(base, { EVOLUTION_API_KEY: 'k' });
  assert.equal(fromEnv.evolution.apiKey, 'k');
  assert.equal(JSON.stringify(fromEnv).includes('"k"'), false);
  const fromFile = normalizeConfig({ ...base, evolution: { envFile } }, {});
  assert.equal(fromFile.evolution.apiKey, 'secret-from-file');
  assert.deepEqual(fromFile.triggers, ['claude']);
  assert.throws(() => normalizeConfig({ accounts: [] }, { EVOLUTION_API_KEY: 'k' }), /at least one/);
  assert.throws(() => normalizeConfig({ ...base, language: 'xx' }, { EVOLUTION_API_KEY: 'k' }), /language/);
  assert.throws(() => normalizeConfig({ ...base, pollMs: 10 }, { EVOLUTION_API_KEY: 'k' }), /pollMs/);
});
