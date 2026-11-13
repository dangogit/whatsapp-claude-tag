import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeConfig } from '../src/config.mjs';
import { managerDeliveryHealth, pollManagerDeliveries } from '../src/manager-deliveries.mjs';
import { ManagerDeliveryStore } from '../src/manager-delivery-store.mjs';
import { managerEnvelope } from '../src/manager.mjs';
import { runJob } from '../src/runner.mjs';
import { AccountStore } from '../src/store.mjs';
import { AccountWatcher } from '../src/watcher.mjs';
import { FakeClient, OWNER, msg, tmpDir } from './helpers.mjs';

const NOW = 1_800_000_000_000;
const TOKEN = '12345678-1234-4123-8123-123456789abc';
const delivery = (extra = {}) => ({ id: 'a'.repeat(64), token: TOKEN, body: '@manager progress',
  conversationId: 'conversation-1', taskIds: ['task-1'], sourceMessageId: 'REQUEST1', ...extra });
const record = (id, text, extra = {}) => msg({ id, chat: OWNER, text, ts: NOW / 1000 - 1, ...extra });

async function fixture({ stateDir = tmpDir(), enabled = true, deliveries = true, client = new FakeClient(), responses = [] } = {}) {
  const cfg = normalizeConfig({ stateDir, accounts: [{ name: 'personal', instance: 'inst' }],
    manager: { enabled, deliveries, command: process.execPath } }, { EVOLUTION_API_KEY: 'k' });
  const store = new AccountStore(cfg.stateDir, 'personal');
  const calls = [], logs = [], jobs = [];
  let now = NOW;
  const commands = {
    deliveries: async (_cfg, envelope) => { calls.push(['deliveries', envelope]); return { ok: true, deliveries: responses.splice(0) }; },
    ack: async (_cfg, envelope) => { calls.push(['ack', envelope]); return { ok: true }; },
    health: async (_cfg, envelope) => { calls.push(['health', envelope]); return { ok: true, unknownDeliveries: 0 }; },
  };
  const w = new AccountWatcher({ cfg, account: cfg.accounts[0], client, store, now: () => now, managerCommands: commands,
    log: (level, fields) => logs.push({ level, ...fields }),
    runJob: async (_cfg, job) => { jobs.push(job); return { ok: true, result: 'accepted', conversationId: 'conversation-1', taskIds: ['task-1'] }; } });
  await w.init();
  return { w, cfg, store, client, calls, logs, jobs, commands, responses,
    advance: () => { now += 30_000; } };
}

async function register(f) {
  await f.w.handle(record('REQUEST1', '@manager start'));
  await f.w.drain();
  f.client.sent.length = 0;
  return f.w.managerScope();
}

test('delivery polling is opt-in, throttled at 30 seconds and runs when WhatsApp is idle', async () => {
  for (const [enabled, deliveries] of [[false, false], [true, false], [false, true]]) {
    const f = await fixture({ enabled, deliveries });
    await f.w.poll();
    assert.equal(f.calls.length, 0);
  }
  const f = await fixture();
  await f.w.poll();
  assert.equal(f.calls.length, 0, 'no conversation has been registered');
  await register(f);
  f.advance();
  await f.w.poll();
  assert.ok(f.calls.some(([command]) => command === 'deliveries'));
  const count = f.calls.length;
  await f.w.poll();
  assert.equal(f.calls.length, count);
  f.advance();
  await f.w.poll();
  assert.ok(f.calls.length > count);
});

test('delivery records provider proof, acknowledges once and links swipe-reply continuation', async () => {
  const f = await fixture({ responses: [delivery()] });
  const scope = await register(f);
  await f.w.poll();
  assert.equal(f.client.sent.length, 1);
  assert.equal(f.client.sent[0].number, OWNER);
  assert.equal(f.client.sent[0].text, '@\u2060manager progress');
  const id = f.client.sent[0].key.id;
  const journal = f.w.managerDeliveryStore.journal(delivery().id);
  assert.equal(journal.state, 'acked');
  assert.equal(journal.providerMessageId, id);
  assert.equal(f.store.sentIds().has(id), true);
  assert.deepEqual(f.store.getThread(id).managerScope, scope);
  const ack = f.calls.find(([command]) => command === 'ack')[1];
  assert.deepEqual(ack, { schemaVersion: 1, source: 'whatsapp', account: 'personal', actorId: OWNER,
    conversationId: 'conversation-1', id: delivery().id, token: TOKEN, providerMessageId: id });
  await f.w.handle(record('FOLLOW', 'continue', { quotedStanza: id, quoted: 'untrusted quotation' }));
  await f.w.drain();
  assert.equal(f.jobs[1].backend, 'manager');
  assert.equal(f.jobs[1].resumeConversationId, 'conversation-1');
  assert.equal(f.jobs[1].trigger.quoted, '');
  f.responses.push(delivery());
  f.advance();
  const sent = f.client.sent.length;
  await f.w.poll();
  assert.equal(f.client.sent.length, sent, 'an acknowledged duplicate must not send again');
});

test('reservations are durable before send and unknown send outcomes are never retried', async () => {
  for (const outcome of ['throw', 'missing-id', 'stopped-before-send']) {
    const f = await fixture({ responses: [delivery()] });
    const scope = await register(f);
    let attempts = 0;
    f.client.sendText = async () => {
      attempts++;
      const saved = f.w.managerDeliveryStore.journal(delivery().id);
      assert.equal(saved.state, 'reserved');
      if (outcome === 'throw') throw new Error('provider response lost');
      return {};
    };
    if (outcome === 'stopped-before-send') f.w.managerDeliveryStore.reserve(scope, delivery());
    await f.w.poll();
    assert.equal(attempts, outcome === 'stopped-before-send' ? 0 : 1);
    assert.equal(f.w.managerDeliveryStore.health().localUnknown, 1);
    assert.equal(f.calls.some(([command]) => command === 'ack'), false);
    const restarted = await fixture({ stateDir: f.cfg.stateDir, client: f.client, responses: [delivery()] });
    await restarted.w.poll();
    assert.equal(attempts, outcome === 'stopped-before-send' ? 0 : 1);
    assert.equal(restarted.w.managerDeliveryStore.journal(delivery().id).state, 'reserved');
  }
});

test('known provider sends recover only acknowledgment after restart and rebuild thread routing', async () => {
  const f = await fixture();
  const scope = await register(f);
  const reserved = f.w.managerDeliveryStore.reserve(scope, delivery());
  f.w.managerDeliveryStore.sent(reserved, 'PROVIDERSENT');
  const restarted = await fixture({ stateDir: f.cfg.stateDir, responses: [delivery()] });
  await restarted.w.poll();
  assert.equal(restarted.client.sent.length, 0);
  assert.equal(restarted.calls.filter(([command]) => command === 'ack').length, 1);
  assert.equal(restarted.w.managerDeliveryStore.journal(delivery().id).state, 'acked');
  assert.equal(restarted.store.sentIds().has('PROVIDERSENT'), true);
  assert.equal(restarted.store.getThread('PROVIDERSENT').conversationId, 'conversation-1');
});

test('failed acknowledgments retry without resending and a completed ack is idempotent', async () => {
  const f = await fixture({ responses: [delivery()] });
  await register(f);
  const ack = f.commands.ack;
  let attempts = 0;
  f.commands.ack = async (...args) => { attempts++; return attempts === 1 ? { ok: false } : ack(...args); };
  await f.w.poll();
  assert.equal(f.client.sent.length, 1);
  assert.equal(f.w.managerDeliveryStore.health().pendingAcks, 1);
  f.advance();
  await f.w.poll();
  assert.equal(f.client.sent.length, 1);
  assert.equal(attempts, 2);
  assert.equal(f.w.managerDeliveryStore.health().pendingAcks, 0);
  f.advance();
  await f.w.poll();
  assert.equal(attempts, 2);
});

test('every delivery rechecks current identity and refuses drift after reservations arrive', async () => {
  for (const scenario of ['identity', 'destination', 'disabled', 'instance', 'unavailable', 'second-item']) {
    const first = delivery();
    const second = delivery({ id: 'b'.repeat(64), token: '22345678-1234-4123-8123-123456789abc' });
    const f = await fixture({ responses: scenario === 'second-item' ? [first, second] : [first] });
    await register(f);
    const poll = f.commands.deliveries;
    f.commands.deliveries = async (...args) => {
      const result = await poll(...args);
      if (scenario === 'identity') f.client.ownerJid = async () => '999@s.whatsapp.net';
      if (scenario === 'destination') f.w.ownerChat = '999@s.whatsapp.net';
      if (scenario === 'disabled') f.cfg.manager.deliveries = false;
      if (scenario === 'instance') f.cfg.accounts[0].instance = 'replacement';
      if (scenario === 'unavailable') f.client.ownerJid = async () => { throw new Error('offline'); };
      return result;
    };
    if (scenario === 'second-item') {
      const send = f.client.sendText.bind(f.client);
      f.client.sendText = async (...args) => { const key = await send(...args); f.client.ownerJid = async () => '999@s.whatsapp.net'; return key; };
    }
    await f.w.poll();
    assert.equal(f.client.sent.length, scenario === 'second-item' ? 1 : 0, scenario);
    assert.equal(f.calls.some(([command]) => command === 'ack'), false, scenario);
    assert.equal(f.w.managerDeliveryStore.health().localUnknown, 1, scenario);
  }
});

test('unrecognized source requests and wrong conversations stay unknown', async () => {
  for (const extra of [{ sourceMessageId: 'UNREGISTERED' }, { conversationId: 'unregistered-conversation' }]) {
    const f = await fixture({ responses: [delivery(extra)] });
    await register(f);
    await f.w.poll();
    assert.equal(f.client.sent.length, 0);
    assert.equal(f.w.managerDeliveryStore.health().localUnknown, 1);
    assert.equal(f.calls.some(([command]) => command === 'ack'), false);
  }
});

test('remote health exposes a reservation lost before the local journal without faking delivery', async () => {
  const f = await fixture();
  await register(f);
  f.commands.health = async () => ({ ok: true, unknownDeliveries: 1 });
  await f.w.poll();
  assert.equal(f.client.sent.length, 0);
  assert.equal(f.w.managerDeliveryStore.health().localUnknown, 0);
  const health = f.logs.find(entry => entry.event === 'manager-delivery-health');
  assert.equal(health.ok, false);
  assert.ok(health.remoteUnknown > 0);
  assert.equal(fs.existsSync(f.w.managerDeliveryStore.journalDir), false);
});

test('journal and source registry survive recreation, reject rebinding and fail closed on corruption', async () => {
  const f = await fixture();
  const scope = await register(f);
  const registry = new ManagerDeliveryStore(f.store.dir);
  assert.ok(registry.request(scope, 'REQUEST1').conversationIds.includes('conversation-1'));
  assert.equal(registry.request({ ...scope, actorId: '999@s.whatsapp.net', destination: '999@s.whatsapp.net' }, 'REQUEST1'), null);
  registry.reserve(scope, delivery());
  assert.throws(() => registry.reserve(scope, delivery({ token: '22345678-1234-4123-8123-123456789abc' })), /changed/);
  const file = registry.journalFile(delivery().id);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, '{broken');
  assert.equal(registry.health().corrupt, 1);
  f.responses.push(delivery());
  await f.w.poll();
  assert.equal(f.client.sent.length, 0);
});

test('source request is registered before the request adapter can enqueue work', async () => {
  const f = await fixture();
  f.w.runJob = async (_cfg, job) => {
    const envelope = managerEnvelope(f.cfg, job);
    const request = f.w.managerDeliveryStore.request(f.w.managerScope(), job.id);
    assert.ok(request.conversationIds.includes(envelope.conversationId));
    throw new Error('adapter response lost after durable enqueue');
  };
  await register(f);
  assert.ok(f.w.managerDeliveryStore.request(f.w.managerScope(), 'REQUEST1'));
});

test('overlapping delivery polls share one run and health refuses unverified identities', async () => {
  const f = await fixture();
  await register(f);
  await Promise.all([pollManagerDeliveries(f.w), pollManagerDeliveries(f.w)]);
  const conversations = f.w.managerDeliveryStore.conversations(f.w.managerScope());
  assert.equal(f.calls.filter(([command]) => command === 'deliveries').length, conversations.length);
  const health = await managerDeliveryHealth(f.cfg, f.w.managerDeliveryStore, f.w.managerScope(), async () => false, f.commands.health);
  assert.equal(health.available, false);
  assert.equal(health.ok, false);
});

test('real subprocess protocol accepts a request, reserves progress, sends once and acknowledges', async () => {
  const f = await fixture();
  const requests = path.join(f.cfg.stateDir, 'adapter-request.json');
  const reserved = path.join(f.cfg.stateDir, 'adapter-reserved');
  const acknowledged = path.join(f.cfg.stateDir, 'adapter-ack.json');
  const calls = path.join(f.cfg.stateDir, 'adapter-calls.log');
  const script = `
    const fs = require('node:fs');
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', value => input += value);
    process.stdin.on('end', () => {
      const envelope = JSON.parse(input);
      const command = process.argv.at(-1);
      fs.appendFileSync(${JSON.stringify(calls)}, command + '\\n');
      let output;
      if (command === 'request') {
        fs.writeFileSync(${JSON.stringify(requests)}, JSON.stringify(envelope));
        output = {ok:true,reply:'accepted',conversationId:envelope.conversationId,taskIds:['task-1']};
      } else if (command === 'deliveries') {
        const request = JSON.parse(fs.readFileSync(${JSON.stringify(requests)}, 'utf8'));
        const fresh = !fs.existsSync(${JSON.stringify(reserved)});
        if (fresh) fs.writeFileSync(${JSON.stringify(reserved)}, 'reserved');
        output = {ok:true,deliveries:fresh ? [{...${JSON.stringify(delivery())},conversationId:request.conversationId,sourceMessageId:request.messageId}] : []};
      } else if (command === 'delivery-ack') {
        fs.writeFileSync(${JSON.stringify(acknowledged)}, JSON.stringify(envelope));
        output = {ok:true};
      } else if (command === 'delivery-health') {
        output = {ok:true,unknownDeliveries:fs.existsSync(${JSON.stringify(reserved)}) && !fs.existsSync(${JSON.stringify(acknowledged)}) ? 1 : 0};
      }
      process.stdout.write(JSON.stringify(output));
    });`;
  f.cfg.manager.args = ['-e', script];
  f.w.managerCommands = undefined;
  f.w.runJob = runJob;
  await register(f);
  await f.w.poll();
  assert.equal(f.client.sent.length, 1);
  const ack = JSON.parse(fs.readFileSync(acknowledged, 'utf8'));
  assert.equal(ack.actorId, OWNER);
  assert.equal(ack.providerMessageId, f.client.sent[0].key.id);
  assert.equal(f.store.getThread(ack.providerMessageId).conversationId, ack.conversationId);
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), ['request', 'deliveries', 'delivery-ack', 'delivery-health']);
  f.advance();
  await f.w.poll();
  assert.equal(f.client.sent.length, 1);
});
