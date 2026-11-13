import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeConfig } from '../src/config.mjs';
import { EvolutionClient } from '../src/evolution.mjs';
import { managerEnvelope, managerControlEnvelope, runManagerConversationSync } from '../src/manager.mjs';
import { managerEntry, readManagerHistory, syncManagerHistory } from '../src/manager-history.mjs';
import { AccountStore } from '../src/store.mjs';
import { AccountWatcher } from '../src/watcher.mjs';
import { FakeClient, OWNER, msg, tmpDir } from './helpers.mjs';

const BUSINESS = '972500000002@s.whatsapp.net';
const PEER_LID = '222222222222222@lid';
const BUSINESS_LID = '333333333333333@lid';
const STRANGER = '972500000099@s.whatsapp.net';
const NOW = 1_800_000_000_000;
const incoming = (id, text = 'please help', extra = {}) => msg({ id, chat: OWNER, text, fromMe: false, ts: NOW / 1000 - 1, ...extra });

class DirectClient extends FakeClient {
  async ownerJid(instance) { return instance === 'biz' ? BUSINESS : OWNER; }
  async peerJids(_instance, actorId) { return actorId === OWNER ? [PEER_LID] : [BUSINESS_LID]; }
  rows(where) {
    return this.messages.filter(r => (!where.key?.remoteJid || r.key.remoteJid === where.key.remoteJid
      || (where.key?.remoteJidAlt && r.key.remoteJidAlt === where.key.remoteJidAlt))
      && (where.key?.fromMe !== true || r.key.fromMe)); // Evolution ignores fromMe:false.
  }
  async findMessages(_instance, where = {}, limit = 50, page = 1) {
    return this.rows(where).map((r, i) => ({ r, i })).sort((a, b) => b.r.messageTimestamp - a.r.messageTimestamp || b.i - a.i)
      .slice((page - 1) * limit, page * limit).map(({ r }) => r);
  }
  async findMessagePage(instance, where, limit, page) {
    const total = this.rows(where).length;
    return { records: await this.findMessages(instance, where, limit, page), total, pages: Math.ceil(total / limit), currentPage: page };
  }
}

async function fixture({ client = new DirectClient(), stateDir = tmpDir(), executor, sync, account = 'business' } = {}) {
  const cfg = normalizeConfig({ stateDir, accounts: [{ name: 'business', instance: 'biz' }, { name: 'personal', instance: 'own' }],
    manager: { enabled: true, deliveries: true, command: process.execPath,
      directPeers: [{ account: 'business', ownerId: BUSINESS, actorId: OWNER, enabledSince: new Date(NOW - 86400000).toISOString() }] } }, { EVOLUTION_API_KEY: 'test' });
  const store = new AccountStore(stateDir, account);
  const jobs = [], batches = [], logs = [];
  const w = new AccountWatcher({ cfg, account: cfg.accounts.find(a => a.name === account), client, store, now: () => NOW,
    log: (level, data) => logs.push({ level, ...data }),
    managerSync: sync || (async (_cfg, batch) => { batches.push(batch); return { ok: true }; }),
    managerCommands: { deliveries: async () => ({ ok: true, deliveries: [] }), ack: async () => ({ ok: true }), health: async () => ({ ok: true, unknownDeliveries: 0 }) },
    runJob: async (_cfg, job) => { jobs.push(job); return executor ? executor(job) : { ok: true, result: 'accepted', conversationId: managerEnvelope(cfg, job).conversationId, taskIds: ['task1'] }; },
  });
  await w.init();
  return { w, cfg, client, store, jobs, batches, logs };
}
async function accept(f, rec) { f.client.messages.push(rec); await f.w.handle(rec); await f.w.drain(); }

test('direct peers are explicit, canonical, unique and bound to a configured business owner', () => {
  const base = { accounts: [{ name: 'business', instance: 'biz' }], manager: { enabled: true, command: '/bin/test' } };
  const env = { EVOLUTION_API_KEY: 'test' };
  assert.deepEqual(normalizeConfig(base, env).manager.directPeers, []);
  for (const peer of [{ account: 'missing', ownerId: BUSINESS, actorId: OWNER },
    { account: 'business', ownerId: OWNER, actorId: OWNER }, { account: 'business', ownerId: BUSINESS, actorId: PEER_LID },
    { account: 'business', ownerId: BUSINESS, actorId: OWNER, extra: true }]) {
    assert.throws(() => normalizeConfig({ ...base, manager: { ...base.manager, directPeers: [peer] } }, env));
  }
});

test('authorized incoming ordinary text uses business identity and replies in the same DM, including progress', async () => {
  const f = await fixture();
  await accept(f, incoming('DIRECT', '@manager keep this raw request'));
  assert.equal(f.jobs.length, 1);
  const job = f.jobs[0], scope = job.managerScope;
  assert.equal(job.trigger.request, '@manager keep this raw request');
  assert.equal(job.authenticatedOwnerChat, BUSINESS);
  assert.equal(scope.actorId, OWNER);
  assert.equal(f.client.sent[0].instance, 'biz');
  assert.equal(f.client.sent[0].number, OWNER);
  assert.deepEqual(f.batches[0].entries.map(e => e.id), ['DIRECT']);
  assert.equal(f.batches[0].complete, true);
  assert.equal(f.batches[0].throughId, 'DIRECT');
  const delivery = { id: 'a'.repeat(64), token: '12345678-1234-4123-8123-123456789abc', body: 'progress',
    conversationId: managerEnvelope(f.cfg, job).conversationId, taskIds: ['task1'], sourceMessageId: job.id };
  f.w.managerCommands.deliveries = async (_cfg, envelope) => ({ ok: true, deliveries: envelope.actorId === OWNER ? [delivery] : [] });
  await f.w.poll();
  assert.deepEqual(f.client.sent.map(s => [s.instance, s.number]), [['biz', OWNER], ['biz', OWNER]]);
  assert.equal(f.w.managerDeliveryStore.journal(delivery.id).state, 'acked');
  const thread = f.store.getThread(f.client.sent[1].key.id);
  assert.deepEqual(thread.managerScope, scope);
});

test('strangers, groups, conflicting sender fields, forged quote identity and outgoing echoes never dispatch', async () => {
  const f = await fixture();
  for (const rec of [incoming('STRANGER', 'do work', { chat: STRANGER, pushName: OWNER, quoted: OWNER }),
    incoming('GROUP', 'do work', { chat: '120363000000000001@g.us', alt: OWNER }),
    incoming('WRONGALT', 'do work', { chat: STRANGER, alt: OWNER }),
    incoming('GROUPPART', 'do work', { participant: OWNER }),
    incoming('CONFLICT', 'do work', { chat: OWNER, alt: STRANGER }),
    incoming('ECHO', 'do work', { fromMe: true }), incoming('UNKNOWNLID', 'do work', { chat: '999999@lid' })]) await accept(f, rec);
  assert.equal(f.jobs.length, 0);
  assert.equal(f.client.sent.length, 0);
});

test('provider alternate identity and trusted mapping support LID-only requests without trusting owner.json', async () => {
  const f = await fixture();
  f.store.saveOwnerJids(['999999@lid']);
  await accept(f, incoming('CACHE', 'work', { chat: '999999@lid' }));
  assert.equal(f.jobs.length, 0);
  await accept(f, incoming('ALT', 'work', { chat: PEER_LID, alt: OWNER }));
  assert.equal(f.jobs.length, 1);
  await accept(f, incoming('LIDONLY', 'continue', { chat: PEER_LID }));
  assert.equal(f.jobs.length, 2);
  assert.equal(f.jobs[0].managerScope.actorId, f.jobs[1].managerScope.actorId);
});

test('personal outgoing dedicated business DM never dispatches Claude or manager twice', async () => {
  const f = await fixture({ account: 'personal' });
  for (const text of ['@claude do work', '@manager do work']) {
    await f.w.handle(incoming('OUT1', text, { chat: BUSINESS, fromMe: true }));
    await f.w.handle(incoming('OUT2', text, { chat: BUSINESS_LID, fromMe: true }));
  }
  await f.w.drain();
  assert.equal(f.jobs.length, 0);
});

test('queued scope stays captured and owner/config changes refuse dispatch and outbound', async () => {
  for (const mutation of ['owner', 'config', 'instance']) {
    const f = await fixture();
    let release;
    f.w.queue = new Promise(resolve => { release = resolve; });
    const rec = incoming('QUEUED'); f.client.messages.push(rec);
    await f.w.handle(rec);
    assert.ok(fs.existsSync(path.join(f.store.jobDir(rec.key.id), 'job.json')));
    if (mutation === 'owner') f.client.ownerJid = async () => STRANGER;
    if (mutation === 'config') f.cfg.manager.directPeers[0].actorId = STRANGER;
    if (mutation === 'instance') f.cfg.accounts[0].instance = 'replacement';
    release(); await f.w.drain();
    assert.equal(f.jobs.length, 0, mutation);
    assert.equal(f.client.sent.length, 0, mutation);
  }
  let f;
  f = await fixture({ executor: async () => { f.client.ownerJid = async () => STRANGER; return { ok: true, result: 'private result', conversationId: 'conversation', taskIds: [] }; } });
  await accept(f, incoming('DRIFT'));
  assert.equal(f.client.sent.length, 0);
});

test('full paginated history and quoted followups are imported before the current request, never as commands', async () => {
  const f = await fixture();
  for (let i = 0; i < 235; i++) f.client.messages.push(incoming(`OLD${i}`, i % 2 ? '@manager old command' : 'old response',
    { fromMe: i % 2 === 0, ts: NOW / 1000 - 240 + i }));
  await accept(f, incoming('CURRENT', 'continue this', { quotedStanza: 'OLD233' }));
  assert.equal(f.jobs.length, 1);
  const entries = f.batches.flatMap(b => b.entries);
  assert.equal(entries.length, 236);
  assert.deepEqual(entries.at(-1), { id: 'CURRENT', role: 'user', body: 'continue this', at: new Date((NOW / 1000 - 1) * 1000).toISOString(), quotedId: 'OLD233' });
  assert.deepEqual(f.batches.map(b => b.complete), [false, false, true]);
});

test('same-second provider order excludes later queued messages without lexical ID guessing', async () => {
  const f = await fixture();
  const current = incoming('ZZZ', 'first request');
  f.client.messages = [incoming('OLDER', 'older'), current, incoming('AAA', 'later request')];
  await f.w.handle(current); await f.w.drain();
  assert.deepEqual(f.batches.flatMap(b => b.entries).map(e => e.id), ['OLDER', 'ZZZ']);
});

test('malformed, partial, cross-chat, conflicting and absent current history fail closed and leave a visible durable pending request', async () => {
  for (const kind of ['shape', 'partial', 'cross-chat', 'conflict', 'missing']) {
    const f = await fixture();
    const rec = incoming('CURRENT');
    f.client.messages.push(rec);
    const normal = f.client.findMessagePage.bind(f.client);
    f.client.findMessagePage = async (...args) => {
      const result = await normal(...args);
      if (args[1].key.remoteJid !== OWNER) return result;
      if (kind === 'shape') return { records: [] };
      if (kind === 'partial') return { ...result, total: 2 };
      if (kind === 'cross-chat') return { ...result, records: [incoming('CURRENT', 'please help', { chat: STRANGER })] };
      if (kind === 'conflict') return { records: [rec, { ...rec, message: { conversation: 'changed' } }], total: 2, pages: 1, currentPage: 1 };
      return { records: [], total: 0, pages: 0, currentPage: 1 };
    };
    await f.w.handle(rec); await f.w.drain();
    assert.equal(f.jobs.length, 0, kind);
    assert.equal(f.batches.length, 0, kind);
    assert.equal(f.client.sent[0].number, OWNER, kind);
    assert.match(f.client.sent[0].text, /history/);
    assert.equal(fs.existsSync(path.join(f.store.jobDir('CURRENT'), 'done')), false);
  }
});

test('history failure retries the saved request after restart and duplicate ingress does not dispatch twice', async () => {
  const f = await fixture({ sync: async () => ({ ok: false }) });
  const rec = incoming('RESTART');
  await accept(f, rec);
  const restarted = await fixture({ stateDir: f.cfg.stateDir, client: f.client });
  await restarted.w.reportInterrupted(); await restarted.w.drain();
  assert.equal(restarted.jobs.length, 1);
  assert.equal(f.client.sent.length, 2);
  await restarted.w.handle(rec); await restarted.w.drain();
  assert.equal(restarted.jobs.length, 1);
});

test('unknown immediate send outcomes are reserved and never blindly resent on restart', async () => {
  const f = await fixture();
  let attempts = 0;
  f.client.sendText = async () => { attempts++; throw new Error('response lost'); };
  await accept(f, incoming('UNKNOWN'));
  assert.equal(attempts, 1);
  const restarted = await fixture({ stateDir: f.cfg.stateDir, client: f.client });
  await restarted.w.reportInterrupted(); await restarted.w.drain();
  assert.equal(attempts, 1);
  assert.equal(restarted.jobs.length, 0, 'durable successful adapter response is reused');
});

test('bodyless media is context metadata with an explicit same-DM explanation, captions are requests', async () => {
  const f = await fixture();
  const media = incoming('AUDIO'); media.message = { audioMessage: { ptt: true } };
  await accept(f, media);
  assert.equal(f.jobs.length, 0);
  assert.match(f.batches[0].entries[0].body, /content not read/);
  assert.match(f.client.sent[0].text, /cannot read/);
  const caption = incoming('CAPTION'); caption.message = { imageMessage: { caption: 'explain this caption' } };
  await accept(f, caption);
  assert.equal(f.jobs[0].trigger.request, 'explain this caption');
});

test('strict Evolution page reader rejects unknown shape and truncation; peer mapping uses provider key fields', async () => {
  const c = new EvolutionClient({ url: 'http://localhost', apiKey: 'test' });
  for (const response of [[], { messages: [] }, { messages: { total: 1, pages: 1, currentPage: 1, records: [] } }]) {
    c.request = async () => response;
    await assert.rejects(c.findMessagePage('biz', {}, 100, 1), /pagination/);
  }
  let query;
  c.request = async (_method, _url, body) => { query = body; return { messages: { total: 1, pages: 1, currentPage: 1,
    records: [incoming('PROOF', '', { chat: PEER_LID, alt: OWNER })] } }; };
  assert.deepEqual(await c.peerJids('biz', OWNER), [PEER_LID]);
  assert.equal(query.where.key.remoteJidAlt, OWNER);
  c.request = async () => ({ messages: { total: 1, pages: 1, currentPage: 1, records: [incoming('FORGED', OWNER, { chat: PEER_LID, pushName: OWNER })] } });
  await assert.rejects(c.peerJids('biz', OWNER), /unverified/);
});

test('conversation sync uses fixed command and exact bounded protocol', async () => {
  const f = await fixture();
  const scope = f.w.directScope();
  const envelope = { ...managerControlEnvelope(f.cfg, scope, 'conversation1'), entries: [managerEntry(incoming('CURRENT'))], throughId: 'CURRENT', complete: true };
  f.cfg.manager.args = ['-e', `let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const e=JSON.parse(s);process.stdout.write(JSON.stringify({ok:true,conversationId:e.conversationId,stored:e.entries.length,complete:e.complete,throughId:e.throughId}));});`];
  assert.equal((await runManagerConversationSync(f.cfg, envelope)).ok, true);
  assert.equal((await runManagerConversationSync(f.cfg, { ...envelope, entries: Array(101).fill(envelope.entries[0]) })).ok, false);
  const calls = [];
  const entries = Array.from({ length: 10 }, (_, i) => ({ ...envelope.entries[0], id: `ROW${i}`, body: 'א'.repeat(16000) }));
  await syncManagerHistory(f.cfg, scope, 'conversation1', 'ROW9', entries, async (_cfg, e) => { calls.push(e); return { ok: true }; });
  assert.ok(calls.every(e => Buffer.byteLength(JSON.stringify(e)) <= 65536));
  assert.equal(calls.at(-1).complete, true);
});

test('activation excludes old commands while retaining them as context, and downtime older than ten minutes is caught up', async () => {
  const f = await fixture();
  f.cfg.manager.directPeers[0].enabledSince = new Date(NOW - 3600000).toISOString();
  f.client.messages = [incoming('PRE', '@manager old command', { ts: NOW / 1000 - 3601 }),
    incoming('BOUNDARY', '@manager exact boundary', { ts: NOW / 1000 - 3600 }),
    incoming('DOWNTIME', 'request while offline', { ts: NOW / 1000 - 1800 })];
  await f.w.poll(); await f.w.drain();
  assert.deepEqual(f.jobs.map(j => j.id), ['DOWNTIME']);
  assert.deepEqual(f.batches.flatMap(b => b.entries).map(e => e.id), ['PRE', 'BOUNDARY', 'DOWNTIME']);
  const restarted = await fixture({ stateDir: f.cfg.stateDir, client: f.client });
  restarted.cfg.manager.directPeers[0].enabledSince = f.cfg.manager.directPeers[0].enabledSince;
  await restarted.w.poll(); await restarted.w.drain();
  assert.equal(restarted.jobs.length, 0);
});

test('multi-page accepted burst is persisted in oldest-first order and provider echoes are ignored', async () => {
  const f = await fixture();
  f.client.messages = Array.from({ length: 42 }, (_, i) => incoming(`BURST${i}`, `request${i}`, { ts: NOW / 1000 - 100 + i }));
  f.client.messages.push(incoming('OUTGOING', 'accepted', { fromMe: true }));
  await f.w.poll(); await f.w.drain();
  assert.equal(f.jobs.length, 42);
  assert.deepEqual(f.jobs.map(j => j.id), Array.from({ length: 42 }, (_, i) => `BURST${i}`));
  await f.w.poll(); await f.w.drain();
  assert.equal(f.jobs.length, 42);
});

test('direct delivery ack recovery retains original business owner and actor route', async () => {
  const f = await fixture();
  await accept(f, incoming('SOURCE'));
  const scope = f.w.directScope();
  const delivery = { id: 'b'.repeat(64), token: '12345678-1234-4123-8123-123456789abc', body: 'done',
    conversationId: managerEnvelope(f.cfg, f.jobs[0]).conversationId, taskIds: ['task1'], sourceMessageId: 'SOURCE' };
  const reserved = f.w.managerDeliveryStore.reserve(scope, delivery);
  f.w.managerDeliveryStore.sent(reserved, 'ALREADY_SENT');
  const restarted = await fixture({ stateDir: f.cfg.stateDir, client: f.client });
  const acks = [];
  restarted.w.managerCommands.ack = async (_cfg, envelope) => { acks.push(envelope); return { ok: true }; };
  await restarted.w.poll(); await restarted.w.drain();
  assert.equal(f.client.sent.length, 1);
  assert.equal(acks.length, 1);
  assert.equal(acks[0].actorId, OWNER);
  assert.equal(restarted.w.managerDeliveryStore.journal(delivery.id).state, 'acked');
  assert.deepEqual(restarted.store.getThread('ALREADY_SENT').managerScope, scope);
});

test('reaction and protocol events stay context-only and never become new requests', async () => {
  const f = await fixture();
  for (const [id, message] of [['REACTION', { reactionMessage: { text: '👍' } }], ['PROTOCOL', { protocolMessage: { type: 3 } }]]) {
    const rec = incoming(id, ''); rec.message = message;
    await accept(f, rec);
  }
  assert.equal(f.jobs.length, 0);
  assert.equal(f.client.sent.length, 0);
  await accept(f, incoming('TEXTAFTER', 'please help', { ts: NOW / 1000 }));
  assert.equal(f.jobs.length, 1);
  assert.equal(f.batches[0].entries.length, 3);
  assert.match(f.batches[0].entries[0].body, /protocol or reaction/);
});

test('identical provider records from phone and LID queries deduplicate, conflicting IDs refuse', async () => {
  const f = await fixture();
  const rec = incoming('ALIAS', 'request', { chat: PEER_LID, alt: OWNER });
  f.client.messages.push(rec);
  const entries = await readManagerHistory(f.client, 'biz', f.w.directScope(), [PEER_LID], rec);
  assert.equal(entries.length, 1);
  const original = f.client.findMessagePage.bind(f.client);
  f.client.findMessagePage = async (...args) => {
    const page = await original(...args);
    if (args[1].key.remoteJid === PEER_LID) page.records = [{ ...rec, message: { conversation: 'conflicting request' } }];
    return page;
  };
  await assert.rejects(readManagerHistory(f.client, 'biz', f.w.directScope(), [PEER_LID], rec), /conflicting/);
});
