import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wct-test-'));
}

export const OWNER = '972500000001@s.whatsapp.net';
export const OWNER_LID = '111111111111111@lid';

// In-memory stand-in for EvolutionClient.
export class FakeClient {
  constructor({ messages = [], groups = [], contacts = [] } = {}) {
    this.messages = messages;
    this.groups = groups;
    this.contacts = contacts;
    this.sent = [];
    this.deleted = [];
    this.n = 0;
  }

  async findMessages(_instance, where = {}, limit = 50, page = 1) {
    let recs = this.messages;
    if (where.key?.fromMe === true) recs = recs.filter(r => r.key.fromMe === true);
    if (where.key?.remoteJid) recs = recs.filter(r => r.key.remoteJid === where.key.remoteJid);
    return [...recs].sort((a, b) => b.messageTimestamp - a.messageTimestamp).slice((page - 1) * limit, page * limit);
  }

  async findContacts() { return this.contacts; }
  async fetchGroups() { return this.groups; }
  async ownerJid() { return OWNER; }

  async sendText(instance, number, text, opts = {}) {
    if (this.failSendTo === number) throw new Error('send failed');
    this.n += 1;
    const key = { id: `SENT${this.n}`, remoteJid: number, fromMe: true };
    this.sent.push({ instance, number, text, ...opts, key });
    return key;
  }

  async deleteForEveryone(instance, key) {
    this.deleted.push({ instance, key });
    return {};
  }
}

let counter = 0;
export function msg({ id, chat, text, ts, fromMe = true, alt, participant, pushName, quoted, quotedStanza }) {
  counter += 1;
  return {
    key: {
      id: id || `M${counter}`, fromMe, remoteJid: chat,
      ...(alt ? { remoteJidAlt: alt } : {}), ...(participant ? { participant } : {}),
    },
    pushName: pushName || '',
    messageTimestamp: ts,
    message: { conversation: text },
    ...(quoted || quotedStanza ? { contextInfo: { stanzaId: quotedStanza || '', quotedMessage: quoted ? { conversation: quoted } : undefined } } : {}),
  };
}
