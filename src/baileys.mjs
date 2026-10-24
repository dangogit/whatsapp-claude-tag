// Direct WhatsApp connection through Baileys, with the same methods the watcher and
// tools use on EvolutionClient. One socket per account lives in the watcher process;
// per-run MCP servers reach it through rpc.mjs, because a second socket on the same
// credentials would make WhatsApp drop the first.

import fs from 'node:fs';
import path from 'node:path';
import { MessageStore } from './msgstore.mjs';
import { isGroupJid, userPart } from './text.mjs';

const LOGGED_OUT = 401;
const REPLACED = 440;
const RESTART_REQUIRED = 515;
const MAX_BACKOFF_MS = 60_000;
const CONNECT_WAIT_MS = 15_000;

// Baileys logs through a pino-shaped object; the service writes its own JSON log.
const SILENT = {
  level: 'silent',
  child() { return SILENT; },
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
};

async function defaultMakeSocket({ authDir, getMessage }) {
  let b;
  try {
    b = await import('baileys');
  } catch {
    throw new Error('the baileys transport needs its optional dependency: run `npm install` in the checkout');
  }
  const makeWASocket = b.makeWASocket || b.default?.default || b.default;
  const { state, saveCreds } = await b.useMultiFileAuthState(authDir);
  // A stale built-in WhatsApp Web version is refused with 405; fall back to it when offline.
  const { version } = await b.fetchLatestBaileysVersion().catch(() => ({}));
  const sock = makeWASocket({
    auth: state,
    logger: SILENT,
    getMessage,
    ...(version ? { version } : {}),
    // Staying offline keeps notifications on the owner's phone.
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  sock.ev.on('creds.update', saveCreds);
  return sock;
}

export function bareJid(jid) {
  const s = String(jid || '');
  if (!s) return '';
  return `${userPart(s)}@${s.split('@')[1] || 's.whatsapp.net'}`;
}

function toJid(number) {
  const s = String(number || '').trim();
  if (s.includes('@')) return s;
  const digits = s.replace(/\D/g, '');
  if (!digits) throw new Error(`invalid recipient "${s}"`);
  return `${digits}@s.whatsapp.net`;
}

// Paired means creds.json holds a registered identity.
export function pairedOwner(authDir) {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(authDir, 'creds.json'), 'utf8'));
    return creds?.me?.id ? bareJid(creds.me.id) : '';
  } catch { return ''; }
}

export class BaileysClient {
  // accounts: [{ instance, authDir, dbFile }]
  // opts: { log, makeSocket, keepDays, onQr(instance, qr), pairing, connectWaitMs }
  constructor(accounts, opts = {}) {
    this.log = opts.log || (() => {});
    this.makeSocket = opts.makeSocket || defaultMakeSocket;
    this.keepDays = opts.keepDays || 30;
    this.onQr = opts.onQr || null;
    this.pairing = opts.pairing === true;
    this.connectWaitMs = opts.connectWaitMs ?? CONNECT_WAIT_MS;
    this.closed = false;
    this.conns = new Map(accounts.map(a => [a.instance, {
      ...a, sock: null, state: 'close', store: null, failures: 0, timer: null, waiters: [],
    }]));
  }

  async start() {
    for (const c of this.conns.values()) {
      fs.mkdirSync(c.authDir, { recursive: true, mode: 0o700 });
      if (!c.store && c.dbFile) {
        fs.mkdirSync(path.dirname(c.dbFile), { recursive: true, mode: 0o700 });
        c.store = await MessageStore.open(c.dbFile);
        c.store.prune(this.keepDays);
      }
      await this.connect(c);
    }
    if (!this.pairing) {
      this.pruneTimer = setInterval(() => {
        for (const c of this.conns.values()) c.store?.prune(this.keepDays);
      }, 3600_000);
      this.pruneTimer.unref?.();
    }
  }

  conn(instance) {
    const c = this.conns.get(instance);
    if (!c) throw new Error(`unknown account instance ${instance}`);
    return c;
  }

  async connect(c) {
    if (this.closed) return;
    c.state = 'connecting';
    const sock = await this.makeSocket({
      authDir: c.authDir,
      // Baileys asks for a sent message again when a recipient could not decrypt it. Only
      // our own message in the chat asking is ever re-sent, never another chat's by id.
      getMessage: async key => (key?.id && key.remoteJid ? c.store?.get(key.id, { jid: key.remoteJid, fromMe: true })?.message : undefined),
    });
    c.sock = sock;
    sock.ev.on('connection.update', u => this.onUpdate(c, sock, u));
    sock.ev.on('messages.upsert', ({ messages }) => this.ingest(c, messages));
    sock.ev.on('messaging-history.set', ({ messages, contacts }) => {
      this.ingestContacts(c, contacts);
      this.ingest(c, messages);
    });
    sock.ev.on('contacts.upsert', list => this.ingestContacts(c, list));
    sock.ev.on('contacts.update', list => this.ingestContacts(c, list));
  }

  onUpdate(c, sock, u) {
    if (sock !== c.sock) return;
    if (u.qr) {
      if (this.onQr) this.onQr(c.instance, u.qr);
      else {
        // The service never pairs on its own: a QR nobody sees just burns attempts.
        c.state = 'unpaired';
        this.log('error', { event: 'baileys-unpaired', instance: c.instance, hint: 'run: whatsapp-claude-tag pair' });
        this.drop(c);
        return;
      }
    }
    if (u.connection === 'open') {
      c.state = 'open';
      c.failures = 0;
      this.log('info', { event: 'baileys-open', instance: c.instance });
      for (const w of c.waiters.splice(0)) w.resolve();
    } else if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      c.sock = null;
      if (code === LOGGED_OUT || code === REPLACED) {
        c.state = code === LOGGED_OUT ? 'logged-out' : 'replaced';
        this.log('error', { event: 'baileys-closed', instance: c.instance, state: c.state, code });
        for (const w of c.waiters.splice(0)) w.reject(new Error(`WhatsApp connection ${c.state}`));
        return;
      }
      c.state = 'connecting';
      c.failures += 1;
      // 515 is the normal restart right after pairing.
      const delay = code === RESTART_REQUIRED ? 0 : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(c.failures, 6));
      if (c.failures === 1 || c.failures % 10 === 0) {
        this.log('warn', { event: 'baileys-reconnect', instance: c.instance, code, failures: c.failures, delayMs: delay });
      }
      clearTimeout(c.timer);
      c.timer = setTimeout(() => {
        this.connect(c).catch(err => this.log('error', { event: 'baileys-connect-failed', instance: c.instance, error: err.message }));
      }, delay);
    }
  }

  drop(c) {
    const sock = c.sock;
    c.sock = null;
    try { sock?.end?.(undefined); } catch { /* already closed */ }
  }

  ingest(c, messages) {
    if (!c.store || !Array.isArray(messages)) return;
    for (const wa of messages) {
      let rec;
      try { rec = c.store.put(wa); } catch (err) {
        this.log('warn', { event: 'baileys-store', instance: c.instance, error: err.message });
        continue;
      }
      if (!rec || rec.key.fromMe || !rec.pushName) continue;
      // A group row's pushName is the author's, so it names the participant, never the group.
      const who = isGroupJid(rec.key.remoteJid)
        ? [rec.key.participant, rec.key.participantAlt]
        : [rec.key.remoteJid, rec.key.remoteJidAlt];
      for (const jid of who) if (jid) c.store.putContactIfMissing(jid, rec.pushName);
    }
  }

  ingestContacts(c, list) {
    if (!c.store || !Array.isArray(list)) return;
    for (const ct of list) {
      const name = ct?.name || ct?.notify || ct?.verifiedName;
      if (!name) continue;
      for (const jid of [ct.id, ct.lid, ct.phoneNumber]) if (jid) c.store.putContact(jid, name);
    }
  }

  // Resolves once the socket is open, for `pair`.
  waitOpen(instance) {
    const c = this.conn(instance);
    if (c.state === 'open') return Promise.resolve();
    return new Promise((resolve, reject) => c.waiters.push({ resolve, reject }));
  }

  // The open socket, after waiting out a short reconnect (startup, a dropped network).
  async openSock(instance) {
    const c = this.conn(instance);
    if (c.state === 'connecting' && this.connectWaitMs > 0) {
      let timer;
      await Promise.race([
        this.waitOpen(instance).catch(() => {}),
        new Promise(r => { timer = setTimeout(r, this.connectWaitMs); }),
      ]);
      clearTimeout(timer);
    }
    if (c.state !== 'open' || !c.sock) throw new Error(`WhatsApp is ${c.state} for ${instance}`);
    return c.sock;
  }

  // ----- the EvolutionClient surface -----

  async findMessages(instance, where = {}, limit = 50, page = 1) {
    const store = this.conn(instance).store;
    return store ? store.find(where, limit, page) : [];
  }

  async findContacts(instance) {
    return this.conn(instance).store?.contacts() || [];
  }

  async fetchGroups(instance) {
    const all = await (await this.openSock(instance)).groupFetchAllParticipating();
    return Object.values(all || {}).map(g => ({ id: g.id, subject: g.subject || '' })).filter(g => g.id);
  }

  async ownerJid(instance) {
    const c = this.conn(instance);
    return bareJid(c.sock?.user?.id) || pairedOwner(c.authDir);
  }

  async connectionState(instance) {
    return this.conn(instance).state;
  }

  async sendText(instance, number, text, { quotedId } = {}) {
    const c = this.conn(instance);
    const sock = await this.openSock(instance);
    // Baileys quotes a full message, not an id. Only the owner's own message in the
    // target chat is quoted (the trigger); anything else sends unquoted.
    const jid = toJid(number);
    const quoted = quotedId ? c.store?.get(quotedId, { jid, fromMe: true }) : null;
    const sent = await sock.sendMessage(jid, { text }, quoted ? { quoted } : {});
    if (sent) c.store?.put(sent);
    const key = sent?.key || {};
    return { id: key.id, remoteJid: key.remoteJid, fromMe: true };
  }

  async deleteForEveryone(instance, key) {
    const target = { id: key.id, remoteJid: key.remoteJid, fromMe: key.fromMe === true };
    if (key.participant) target.participant = key.participant;
    await (await this.openSock(instance)).sendMessage(key.remoteJid, { delete: target });
    return {};
  }

  close() {
    this.closed = true;
    clearInterval(this.pruneTimer);
    for (const c of this.conns.values()) {
      clearTimeout(c.timer);
      this.drop(c);
      c.store?.close();
      c.store = null;
    }
  }
}
