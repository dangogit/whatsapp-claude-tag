// Local message history for the Baileys transport. Baileys has no history API, so
// everything the socket receives (and sends) is kept here, shaped like Evolution API
// records so text.mjs, directory.mjs and the watcher read it unchanged.
//
// Uses the built-in node:sqlite (Node >= 22.13): no native build and no dependency.
// Only the watcher process opens the database; per-run MCP servers go through it.

const RECORD_TYPES_SKIPPED = ['protocolMessage', 'senderKeyDistributionMessage', 'reactionMessage', 'messageContextInfo'];

let DatabaseSync;
async function sqlite() {
  if (DatabaseSync) return DatabaseSync;
  // node:sqlite announces itself as experimental on load; that line is noise in a service log.
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (String(warning?.message ?? warning).includes('SQLite')) return;
    emit.call(process, warning, ...rest);
  };
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    throw new Error(`the baileys transport needs Node 22.13 or newer for node:sqlite (this is ${process.version})`);
  } finally {
    process.emitWarning = emit;
  }
  return DatabaseSync;
}

// Protobuf objects into plain JSON: Long -> number, binary (media keys, thumbnails) dropped.
export function plain(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== 'object') return typeof v === 'function' ? undefined : v;
  if (v instanceof Uint8Array || ArrayBuffer.isView(v)) return undefined;
  if (typeof v.low === 'number' && typeof v.high === 'number' && typeof v.unsigned === 'boolean') {
    return v.high * 2 ** 32 + (v.low >>> 0);
  }
  if (Array.isArray(v)) return v.map(plain).filter(x => x !== undefined);
  const out = {};
  for (const k of Object.keys(v)) {
    const x = plain(v[k]);
    if (x !== undefined) out[k] = x;
  }
  return out;
}

function unwrap(message) {
  let m = message;
  for (let i = 0; i < 4 && m; i += 1) {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message
      || m.documentWithCaptionMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}

// Evolution flattens the content's contextInfo onto the record.
function findContextInfo(message) {
  const m = unwrap(message);
  if (!m || typeof m !== 'object') return null;
  for (const v of Object.values(m)) {
    if (v && typeof v === 'object' && v.contextInfo) return v.contextInfo;
  }
  return null;
}

// A Baileys WAMessage as an Evolution-shaped record, or null for protocol noise.
export function toRecord(wa) {
  const k = wa?.key;
  if (!k?.id || !k.remoteJid || !wa.message) return null;
  const message = plain(wa.message) || {};
  const types = Object.keys(unwrap(message) || {});
  if (!types.length || types.every(t => RECORD_TYPES_SKIPPED.includes(t))) return null;
  const key = { id: k.id, fromMe: k.fromMe === true, remoteJid: k.remoteJid };
  for (const f of ['remoteJidAlt', 'participant', 'participantAlt']) if (k[f]) key[f] = k[f];
  const ts = plain(wa.messageTimestamp);
  const rec = {
    key,
    pushName: wa.pushName || '',
    messageTimestamp: Number.isFinite(Number(ts)) ? Number(ts) : 0,
    message,
  };
  const ctx = plain(findContextInfo(wa.message));
  if (ctx) rec.contextInfo = ctx;
  if (key.remoteJidAlt) rec.remoteJidAlt = key.remoteJidAlt;
  return rec;
}

export class MessageStore {
  static async open(file) {
    const Db = await sqlite();
    return new MessageStore(new Db(file));
  }

  constructor(db) {
    this.db = db;
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        remote_jid TEXT NOT NULL,
        remote_jid_alt TEXT NOT NULL DEFAULT '',
        from_me INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_from_me ON messages (from_me, ts);
      CREATE INDEX IF NOT EXISTS messages_jid ON messages (remote_jid, ts);
      CREATE INDEX IF NOT EXISTS messages_jid_alt ON messages (remote_jid_alt, ts);
      CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
    `);
    this.putStmt = db.prepare(`INSERT INTO messages (id, remote_jid, remote_jid_alt, from_me, ts, record) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET record = excluded.record, ts = excluded.ts`);
    this.getStmt = db.prepare('SELECT record FROM messages WHERE id = ?');
    this.contactStmt = db.prepare(`INSERT INTO contacts (jid, name) VALUES (?, ?)
      ON CONFLICT (jid) DO UPDATE SET name = excluded.name`);
    this.contactIfMissingStmt = db.prepare('INSERT OR IGNORE INTO contacts (jid, name) VALUES (?, ?)');
  }

  // Returns the stored record, or null when the message carries nothing worth keeping.
  put(wa) {
    const rec = toRecord(wa);
    if (!rec) return null;
    const k = rec.key;
    this.putStmt.run(k.id, k.remoteJid, k.remoteJidAlt || '', k.fromMe ? 1 : 0, rec.messageTimestamp, JSON.stringify(rec));
    return rec;
  }

  get(id) {
    const row = this.getStmt.get(String(id));
    return row ? JSON.parse(row.record) : null;
  }

  // Same contract as EvolutionClient.findMessages: newest first, paged. A remoteJid
  // filter also matches the alternate JID, so one person's LID and phone rows join.
  find(where = {}, limit = 50, page = 1) {
    const conds = [];
    const args = [];
    if (where.key?.fromMe === true || where.key?.fromMe === false) {
      conds.push('from_me = ?');
      args.push(where.key.fromMe ? 1 : 0);
    }
    if (where.key?.remoteJid) {
      conds.push('(remote_jid = ? OR remote_jid_alt = ?)');
      args.push(where.key.remoteJid, where.key.remoteJid);
    }
    if (where.key?.id) {
      conds.push('id = ?');
      args.push(where.key.id);
    }
    const n = Math.min(Math.max(Math.trunc(Number(limit)) || 50, 1), 1000);
    const p = Math.max(Math.trunc(Number(page)) || 1, 1);
    const sql = `SELECT record FROM messages ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
      ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?`;
    return this.db.prepare(sql).all(...args, n, (p - 1) * n).map(r => JSON.parse(r.record));
  }

  putContact(jid, name) {
    const clean = String(name || '').trim();
    if (jid && clean) this.contactStmt.run(jid, clean);
  }

  // A message's pushName fills a gap but never overrides a name from the address book.
  putContactIfMissing(jid, name) {
    const clean = String(name || '').trim();
    if (jid && clean && !/^\d+$/.test(clean)) this.contactIfMissingStmt.run(jid, clean);
  }

  // Shaped like Evolution contact rows.
  contacts() {
    return this.db.prepare('SELECT jid, name FROM contacts').all().map(r => ({ remoteJid: r.jid, pushName: r.name }));
  }

  prune(keepDays) {
    const cutoff = Math.floor(Date.now() / 1000) - keepDays * 86400;
    this.db.prepare('DELETE FROM messages WHERE ts < ?').run(cutoff);
  }

  close() {
    this.db.close();
  }
}
