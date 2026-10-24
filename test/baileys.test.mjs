import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { BaileysClient, pairedOwner } from '../src/baileys.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { buildDirectory } from '../src/directory.mjs';
import { MessageStore, toRecord } from '../src/msgstore.mjs';
import { RpcClient, serveRpc } from '../src/rpc.mjs';
import { runService } from '../src/service.mjs';
import { AccountStore, readActions } from '../src/store.mjs';
import { messageText, quotedId, quotedText, timestampOf } from '../src/text.mjs';
import { createTools } from '../src/tools.mjs';
import { toolClient } from '../src/transport.mjs';
import { OWNER, OWNER_LID, tmpDir } from './helpers.mjs';

const GROUP = '120363000000000001@g.us';
const PEER = '972511111111@s.whatsapp.net';
const PEER_LID = '222222222222222@lid';
const AUTHOR_LID = '333333333333333@lid';

function long(n) {
  return { low: n | 0, high: Math.floor(n / 2 ** 32), unsigned: true };
}

// Stand-in for a Baileys socket: an event emitter plus the calls the client makes.
class FakeSocket {
  constructor({ user = { id: '972500000001:7@s.whatsapp.net', lid: OWNER_LID } } = {}) {
    this.ev = new EventEmitter();
    this.user = user;
    this.sent = [];
    this.groups = { [GROUP]: { id: GROUP, subject: 'Builders', participants: [] } };
    this.n = 0;
  }

  open() { this.ev.emit('connection.update', { connection: 'open' }); }

  close(statusCode) {
    this.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode } } } });
  }

  // Like Baileys with emitOwnEvents: the sent message also arrives as an upsert.
  async sendMessage(jid, content, opts = {}) {
    this.n += 1;
    this.sent.push({ jid, content, opts });
    const message = content.text !== undefined
      ? { extendedTextMessage: { text: content.text, ...(opts.quoted ? { contextInfo: { stanzaId: opts.quoted.key.id, quotedMessage: opts.quoted.message } } : {}) } }
      : { protocolMessage: { key: content.delete, type: 0 } };
    const wa = { key: { id: `BAE${this.n}`, remoteJid: jid, fromMe: true }, message, messageTimestamp: long(Math.floor(Date.now() / 1000)) };
    this.ev.emit('messages.upsert', { messages: [wa], type: 'append' });
    return wa;
  }

  async groupFetchAllParticipating() { return this.groups; }
  end() { this.ended = true; this.close(428); }
}

function wa({ id, chat, text, ts, fromMe = false, alt, participant, participantAlt, pushName, message }) {
  return {
    key: {
      id, remoteJid: chat, fromMe,
      ...(alt ? { remoteJidAlt: alt } : {}),
      ...(participant ? { participant } : {}), ...(participantAlt ? { participantAlt } : {}),
    },
    pushName,
    messageTimestamp: typeof ts === 'number' ? long(ts) : ts,
    message: message || { conversation: text },
  };
}

async function makeClient({ open = true, connectWaitMs = 0 } = {}) {
  const dir = tmpDir();
  const sockets = [];
  const logs = [];
  const client = new BaileysClient([{ instance: 'personal', authDir: path.join(dir, 'auth'), dbFile: path.join(dir, 'personal', 'messages.sqlite') }], {
    log: (level, fields) => logs.push({ level, ...fields }),
    connectWaitMs,
    makeSocket: async () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  });
  await client.start();
  if (open) sockets[0].open();
  return { client, sockets, logs, dir, sock: () => sockets[sockets.length - 1] };
}

test('toRecord maps a Baileys message to the Evolution record shape', () => {
  const rec = toRecord({
    key: { id: 'X1', remoteJid: OWNER_LID, remoteJidAlt: OWNER, fromMe: true, addressingMode: 'lid' },
    pushName: 'Owner',
    messageTimestamp: long(1_800_000_000),
    message: {
      ephemeralMessage: {
        message: {
          extendedTextMessage: {
            text: '@claude what did she mean',
            jpegThumbnail: new Uint8Array([1, 2, 3]),
            contextInfo: { stanzaId: 'Q1', participant: PEER, quotedMessage: { conversation: 'see you at 5' }, expiration: long(604800) },
          },
        },
      },
      messageContextInfo: { messageSecret: new Uint8Array([9]) },
    },
  });
  assert.deepEqual(rec.key, { id: 'X1', fromMe: true, remoteJid: OWNER_LID, remoteJidAlt: OWNER });
  assert.equal(rec.remoteJidAlt, OWNER);
  assert.equal(rec.messageTimestamp, 1_800_000_000);
  assert.equal(rec.pushName, 'Owner');
  assert.equal(rec.contextInfo.stanzaId, 'Q1');
  assert.equal(rec.contextInfo.expiration, 604800);
  // Binary fields are dropped, so the record is plain JSON.
  assert.equal(rec.message.ephemeralMessage.message.extendedTextMessage.jpegThumbnail, undefined);
  assert.deepEqual(rec.message.messageContextInfo, {});
  // The existing readers work on it unchanged.
  assert.equal(messageText(rec), '@claude what did she mean');
  assert.equal(quotedId(rec), 'Q1');
  assert.equal(quotedText(rec), 'see you at 5');
  assert.equal(timestampOf(rec), 1_800_000_000);
});

test('toRecord keeps media and group authors, and skips protocol noise', () => {
  const img = toRecord(wa({
    id: 'I1', chat: GROUP, participant: AUTHOR_LID, participantAlt: PEER, ts: 100,
    message: { imageMessage: { caption: 'the plan', mediaKey: new Uint8Array([1]), fileLength: long(12345) } },
  }));
  assert.equal(messageText(img), 'the plan');
  assert.equal(img.key.participant, AUTHOR_LID);
  assert.equal(img.key.participantAlt, PEER);
  assert.equal(img.message.imageMessage.fileLength, 12345);
  assert.equal(messageText(toRecord(wa({ id: 'A1', chat: PEER, ts: 1, message: { audioMessage: { seconds: 3 } } }))), '[audio]');
  assert.equal(toRecord(wa({ id: 'P1', chat: PEER, ts: 1, message: { protocolMessage: { type: 0 } } })), null);
  assert.equal(toRecord(wa({ id: 'R1', chat: PEER, ts: 1, message: { reactionMessage: { text: 'x' } } })), null);
  assert.equal(toRecord({ key: { id: 'N1', remoteJid: PEER }, messageStubType: 1 }), null);
});

test('MessageStore finds newest first with fromMe, remoteJid (and alt) filters and paging', async () => {
  const store = await MessageStore.open(path.join(tmpDir(), 'm.sqlite'));
  for (let i = 1; i <= 7; i += 1) store.put(wa({ id: `G${i}`, chat: GROUP, text: `g${i}`, ts: 1000 + i, fromMe: i % 2 === 0 }));
  store.put(wa({ id: 'D1', chat: PEER_LID, alt: PEER, text: 'hi via lid', ts: 2000 }));
  store.put(wa({ id: 'D2', chat: PEER, text: 'hi via phone', ts: 2001 }));

  assert.deepEqual(store.find({ key: { fromMe: true } }, 10).map(r => r.key.id), ['G6', 'G4', 'G2']);
  assert.deepEqual(store.find({ key: { remoteJid: GROUP } }, 3, 1).map(r => r.key.id), ['G7', 'G6', 'G5']);
  assert.deepEqual(store.find({ key: { remoteJid: GROUP } }, 3, 3).map(r => r.key.id), ['G1']);
  assert.deepEqual(store.find({ key: { remoteJid: PEER } }, 10).map(r => r.key.id), ['D2', 'D1']);
  assert.equal(store.find({}, 100).length, 9);

  // A repeated upsert replaces the row rather than duplicating it.
  store.put(wa({ id: 'G7', chat: GROUP, text: 'g7 edited', ts: 1007 }));
  assert.equal(store.find({ key: { remoteJid: GROUP } }, 100).length, 7);
  assert.equal(messageText(store.get('G7')), 'g7 edited');

  store.prune(1);
  assert.equal(store.find({}, 100).length, 0);
  store.close();
});

test('MessageStore contacts: address book names win over push names', async () => {
  const store = await MessageStore.open(path.join(tmpDir(), 'm.sqlite'));
  store.putContactIfMissing(PEER, 'Yossi from WhatsApp');
  store.putContact(PEER, 'Yossi Cohen');
  store.putContactIfMissing(PEER, 'Yossi again');
  store.putContactIfMissing(PEER_LID, '12345');
  assert.deepEqual(store.contacts(), [{ remoteJid: PEER, pushName: 'Yossi Cohen' }]);
  store.close();
});

test('BaileysClient ingests upserts and history, and names people but never groups', async () => {
  const { client, sock } = await makeClient();
  sock().ev.emit('messages.upsert', {
    type: 'notify',
    messages: [
      wa({ id: 'M1', chat: GROUP, participant: AUTHOR_LID, participantAlt: PEER, pushName: 'Dana', text: 'hello all', ts: 500 }),
      wa({ id: 'M2', chat: PEER_LID, alt: PEER, pushName: 'Dana', text: 'hi', ts: 501 }),
      wa({ id: 'M3', chat: GROUP, fromMe: true, text: '@claude summarize', ts: 502, pushName: 'Owner' }),
      wa({ id: 'M4', chat: PEER, ts: 503, message: { protocolMessage: { type: 0 } } }),
    ],
  });
  sock().ev.emit('messaging-history.set', {
    messages: [wa({ id: 'H1', chat: GROUP, participant: AUTHOR_LID, pushName: 'Dana', text: 'older', ts: 400 })],
    contacts: [{ id: '972533333333@s.whatsapp.net', lid: '444@lid', name: 'Avi' }],
  });
  sock().ev.emit('contacts.upsert', [{ id: '972544444444@s.whatsapp.net', notify: 'Noa' }]);

  assert.deepEqual((await client.findMessages('personal', { key: { fromMe: true } }, 10)).map(r => r.key.id), ['M3']);
  assert.deepEqual((await client.findMessages('personal', { key: { remoteJid: GROUP } }, 10)).map(r => r.key.id), ['M3', 'M1', 'H1']);
  const names = await buildDirectory(client, 'personal', path.join(tmpDir(), 'cache'));
  assert.equal(names.get(GROUP), 'Builders');
  assert.equal(names.get(AUTHOR_LID), 'Dana');
  assert.equal(names.get(PEER_LID), 'Dana');
  assert.equal(names.get('444@lid'), 'Avi');
  assert.equal(names.get('972544444444@s.whatsapp.net'), 'Noa');
  client.close();
});

test('BaileysClient sends, quotes a stored message, deletes, and reports owner and state', async () => {
  const { client, sock } = await makeClient();
  sock().ev.emit('messages.upsert', { type: 'notify', messages: [wa({ id: 'TRIG', chat: GROUP, fromMe: true, text: '@claude hi', ts: 700 })] });

  assert.equal(await client.ownerJid('personal'), OWNER);
  assert.equal(await client.connectionState('personal'), 'open');

  const key = await client.sendText('personal', GROUP, 'answer', { quotedId: 'TRIG' });
  assert.deepEqual(key, { id: 'BAE1', remoteJid: GROUP, fromMe: true });
  assert.equal(sock().sent[0].opts.quoted.key.id, 'TRIG');
  assert.equal(sock().sent[0].opts.quoted.message.conversation, '@claude hi');
  // The echo of our own send is stored like any message.
  assert.equal(messageText(await client.findMessages('personal', { key: { remoteJid: GROUP } }, 1).then(r => r[0])), 'answer');

  // A bare number becomes a phone JID; an unknown quote id sends unquoted.
  await client.sendText('personal', '+972 51-1111111', 'dm', { quotedId: 'NOPE' });
  assert.equal(sock().sent[1].jid, PEER);
  assert.deepEqual(sock().sent[1].opts, {});

  await client.deleteForEveryone('personal', { id: 'TRIG', remoteJid: GROUP, fromMe: true, participant: OWNER });
  assert.deepEqual(sock().sent[2].content, { delete: { id: 'TRIG', remoteJid: GROUP, fromMe: true, participant: OWNER } });
  assert.deepEqual(await client.fetchGroups('personal'), [{ id: GROUP, subject: 'Builders' }]);
  client.close();
});

test('BaileysClient refuses sends while closed and reconnects after a drop', async () => {
  const { client, sockets, logs } = await makeClient();
  sockets[0].close(428);
  assert.equal(await client.connectionState('personal'), 'connecting');
  await assert.rejects(client.sendText('personal', GROUP, 'x'), /WhatsApp is connecting/);
  await new Promise(r => setTimeout(r, 2100));
  assert.equal(sockets.length, 2);
  sockets[1].open();
  assert.equal(await client.connectionState('personal'), 'open');
  assert.ok(logs.some(l => l.event === 'baileys-reconnect' && l.code === 428));
  // A send during a reconnect waits for it rather than failing at once.
  client.connectWaitMs = 5000;
  sockets[1].close(428);
  const pending = client.sendText('personal', GROUP, 'late');
  await new Promise(r => setTimeout(r, 2100));
  sockets[2].open();
  assert.equal((await pending).remoteJid, GROUP);
  // Logged out is final: no reconnect loop.
  sockets[2].close(401);
  assert.equal(await client.connectionState('personal'), 'logged-out');
  await assert.rejects(client.sendText('personal', GROUP, 'x'), /WhatsApp is logged-out/);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(sockets.length, 3);
  client.close();
});

test('the service never pairs on its own: a QR closes the socket as unpaired', async () => {
  const { client, sockets, logs } = await makeClient({ open: false });
  sockets[0].ev.emit('connection.update', { qr: '2@abc' });
  assert.equal(await client.connectionState('personal'), 'unpaired');
  assert.equal(sockets[0].ended, true);
  assert.ok(logs.some(l => l.event === 'baileys-unpaired'));
  await new Promise(r => setTimeout(r, 50));
  assert.equal(sockets.length, 1);
  client.close();
});

test('pairedOwner reads the identity from creds.json', () => {
  const dir = tmpDir();
  assert.equal(pairedOwner(dir), '');
  fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ me: { id: '972500000001:12@s.whatsapp.net', lid: OWNER_LID } }));
  assert.equal(pairedOwner(dir), OWNER);
});

test('rpc carries the client surface across processes and only that surface', async () => {
  const { client, sock, dir } = await makeClient();
  const socketPath = path.join(dir, 'rpc.sock');
  const server = await serveRpc(client, socketPath);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  const rpc = new RpcClient(socketPath);
  sock().ev.emit('messages.upsert', { type: 'notify', messages: [wa({ id: 'R1', chat: GROUP, text: 'over the wire', ts: 900 })] });
  const [rec] = await rpc.findMessages('personal', { key: { remoteJid: GROUP } }, 5);
  assert.equal(messageText(rec), 'over the wire');
  assert.equal(await rpc.ownerJid('personal'), OWNER);
  assert.equal((await rpc.sendText('personal', GROUP, 'pong')).id, 'BAE1');
  await assert.rejects(rpc.connectionState('nobody'), /unknown account instance/);
  await assert.rejects(rpc.call('close', []), /bad request/);
  await server.close();
  await assert.rejects(rpc.ownerJid('personal'), /watcher is not running/);
  client.close();
});

test('config: baileys needs no API key and derives instance and auth dir', () => {
  const dir = tmpDir();
  const cfg = normalizeConfig({ transport: 'baileys', accounts: [{ name: 'personal' }], stateDir: dir }, {});
  assert.equal(cfg.accounts[0].instance, 'personal');
  assert.equal(cfg.baileys.authDir, path.join(dir, 'baileys'));
  assert.equal(cfg.baileys.keepDays, 30);
  assert.throws(() => normalizeConfig({ transport: 'carrier-pigeon', accounts: [{ name: 'a' }] }, {}), /transport must be one of/);
  assert.throws(() => normalizeConfig({ transport: 'baileys', accounts: [{ name: 'a', instance: '../x' }] }, {}), /invalid account instance/);
  assert.throws(() => normalizeConfig({ accounts: [{ name: 'personal' }] }, { EVOLUTION_API_KEY: 'k' }), /instance is required/);
  assert.throws(() => normalizeConfig({ accounts: [{ instance: 'i' }] }, {}), /no Evolution API key/);
});

// The whole `run` path on a fake socket: an owner "@claude" message in a group becomes
// a job, and the run's MCP tools answer through the watcher's socket, quoting the trigger.
test('dry run: runService on a fake Baileys socket turns a trigger into a job', async () => {
  const dir = tmpDir();
  const cfg = normalizeConfig({
    transport: 'baileys', accounts: [{ name: 'personal' }], stateDir: dir, pollMs: 500, timezone: 'Asia/Jerusalem',
  }, {});
  const sockets = [];
  const jobs = [];
  const ac = new AbortController();
  let jobDone;
  const done = new Promise(r => { jobDone = r; });
  const service = runService(cfg, {
    signal: ac.signal,
    makeSocket: async () => {
      const s = new FakeSocket();
      sockets.push(s);
      setImmediate(() => s.open());
      return s;
    },
    runJob: async (c, job, jobDir) => {
      jobs.push({ job, jobDir });
      // What the per-run MCP server does: a separate client that reaches the socket by rpc.
      const tools = Object.fromEntries(createTools({
        client: toolClient(c), store: new AccountStore(c.stateDir, job.account.name), job, jobDir, getNames: async () => new Map(),
      }).map(t => [t.name, t]));
      await tools.send_message.handler({ chat: 'current', text: 'Summary: all good', reply_to_trigger: true });
      jobDone();
      return { ok: true, result: '', sessionId: 'S1' };
    },
  });
  while (!sockets.length) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 20));
  const now = Math.floor(Date.now() / 1000);
  sockets[0].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [
      wa({ id: 'OTHER', chat: GROUP, participant: AUTHOR_LID, pushName: 'Dana', text: '@claude not the owner', ts: now }),
      wa({ id: 'TRIG', chat: GROUP, fromMe: true, text: '@claude summarize this group', ts: now }),
    ],
  });
  await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('no job within 5s')), 5000))]);
  ac.abort();
  await service;

  assert.equal(jobs.length, 1);
  const { job, jobDir } = jobs[0];
  assert.equal(job.id, 'TRIG');
  assert.equal(job.trigger.request, 'summarize this group');
  assert.equal(job.chat.name, 'Builders');
  assert.equal(job.chat.sendTo, GROUP);
  assert.equal(job.ownerChat, OWNER);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf8')).trigger.key, { id: 'TRIG', remoteJid: GROUP, fromMe: true });
  assert.equal(sockets[0].sent.length, 1);
  assert.equal(sockets[0].sent[0].jid, GROUP);
  assert.equal(sockets[0].sent[0].content.text, 'Summary: all good');
  assert.equal(sockets[0].sent[0].opts.quoted.key.id, 'TRIG');
  assert.deepEqual(readActions(jobDir).map(a => a.type), ['send']);
  // Shut down cleanly: socket file and lock are gone.
  assert.equal(fs.existsSync(path.join(dir, 'baileys.sock')), false);
  assert.equal(fs.existsSync(path.join(dir, 'watcher.pid')), false);
});
