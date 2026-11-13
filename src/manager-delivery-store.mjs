// Durable delivery evidence. A reservation without a provider id is unknown,
// including when the process stopped before it actually called WhatsApp.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { managerDeliveryValid, managerUserJid, managerJobScope } from './manager.mjs';
import { writeJsonAtomic } from './store.mjs';

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId = value => typeof value === 'string' && ID.test(value);
const scopeKey = scope => [scope.account.name, scope.account.instance, scope.actorId, scope.destination, ...(scope.route ? [scope.route, scope.ownerId, scope.enabledSince] : [])];
const sameScope = (a, b) => JSON.stringify(scopeKey(a)) === JSON.stringify(scopeKey(b));
const deliveryKey = d => [d.id, d.token, d.body, d.conversationId, d.taskIds, d.sourceMessageId];

function validScope(scope) {
  return scope && typeof scope.account?.name === 'string' && scope.account.name
    && typeof scope.account.instance === 'string' && scope.account.instance
    && Boolean(managerUserJid(scope.actorId)) && managerUserJid(scope.actorId) === scope.actorId
    && scope.destination === scope.actorId
    && (!scope.route || (scope.route === 'direct' && /^\d+@s\.whatsapp\.net$/.test(scope.ownerId) && scope.ownerId !== scope.actorId && typeof scope.enabledSince === 'string' && Number.isFinite(Date.parse(scope.enabledSince))));
}

function durableJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeJsonAtomic(file, value, { durable: true });
}

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return null; throw new Error('manager delivery state is unreadable'); }
}

function files(dir) {
  try { return fs.readdirSync(dir).filter(n => /^[a-f0-9]{64}\.json$/.test(n)); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}

export class ManagerDeliveryStore {
  constructor(accountDir) {
    this.notificationsDir = path.join(accountDir, 'manager-notifications');
    this.requestsDir = path.join(accountDir, 'manager-requests');
    this.journalDir = path.join(accountDir, 'manager-deliveries');
  }

  notificationFile(scope, messageId, kind) {
    if (!validScope(scope) || !validId(messageId) || !['result', 'history', 'request'].includes(kind)) throw new Error('invalid manager notification scope');
    return path.join(this.notificationsDir, `${hash([...scopeKey(scope), messageId, kind])}.json`);
  }

  requestFile(scope, messageId) {
    if (!validScope(scope) || !validId(messageId)) throw new Error('invalid manager request scope');
    return path.join(this.requestsDir, `${hash([...scopeKey(scope), messageId])}.json`);
  }

  validateRequest(record) {
    if (!record || record.schemaVersion !== 1 || !validScope(record.scope) || !validId(record.messageId)
      || !Array.isArray(record.conversationIds) || !record.conversationIds.length || record.conversationIds.length > 2
      || !record.conversationIds.every(validId) || typeof record.triggerName !== 'string'
      || !HASH.test(record.requestHash)) throw new Error('invalid manager request registry');
    return record;
  }

  registerRequest(job, envelope, acceptedConversationId = '') {
    const scope = managerJobScope(job);
    const file = this.requestFile(scope, job.id);
    const existing = read(file);
    const digest = hash(envelope.attachments ? [envelope.body, envelope.attachments] : envelope.body);
    if (existing) {
      this.validateRequest(existing);
      if (!sameScope(existing.scope, scope) || existing.messageId !== job.id || existing.requestHash !== digest
        || existing.conversationIds[0] !== envelope.conversationId) throw new Error('manager request scope changed');
    }
    const record = existing || { schemaVersion: 1, scope, messageId: job.id, conversationIds: [envelope.conversationId],
      triggerName: job.triggerName, requestHash: digest };
    if (acceptedConversationId && !record.conversationIds.includes(acceptedConversationId)) record.conversationIds.push(acceptedConversationId);
    this.validateRequest(record);
    durableJson(file, record);
  }

  request(scope, messageId) {
    const value = read(this.requestFile(scope, messageId));
    if (!value) return null;
    this.validateRequest(value);
    if (!sameScope(value.scope, scope) || value.messageId !== messageId) throw new Error('manager request registry scope changed');
    return value;
  }

  conversations(scope) {
    const conversations = new Set();
    for (const file of files(this.requestsDir)) {
      const value = this.validateRequest(read(path.join(this.requestsDir, file)));
      if (sameScope(value.scope, scope)) for (const id of value.conversationIds) conversations.add(id);
    }
    return [...conversations];
  }

  journalFile(id) {
    if (typeof id !== 'string' || !HASH.test(id)) throw new Error('invalid manager delivery id');
    return path.join(this.journalDir, `${id}.json`);
  }

  journal(id) {
    const record = read(this.journalFile(id));
    if (!record) return null;
    if (record.schemaVersion !== 1 || !validScope(record.scope) || !managerDeliveryValid(record.delivery)
      || record.delivery.id !== id || !['reserved', 'sent', 'acked'].includes(record.state)
      || (record.state !== 'reserved' && !validId(record.providerMessageId))) throw new Error('invalid manager delivery journal');
    return record;
  }

  reserve(scope, delivery) {
    if (!validScope(scope) || !managerDeliveryValid(delivery)) throw new Error('invalid manager delivery reservation');
    const existing = this.journal(delivery.id);
    if (existing) {
      if (!sameScope(existing.scope, scope) || JSON.stringify(deliveryKey(existing.delivery)) !== JSON.stringify(deliveryKey(delivery))) {
        throw new Error('manager delivery reservation changed');
      }
      return null;
    }
    const record = { schemaVersion: 1, state: 'reserved', scope: structuredClone(scope), delivery: structuredClone(delivery) };
    durableJson(this.journalFile(delivery.id), record);
    return record;
  }

  sent(record, providerMessageId) {
    if (!validId(providerMessageId)) throw new Error('invalid WhatsApp provider message id');
    const current = this.journal(record.delivery.id);
    if (current?.state !== 'reserved') throw new Error('manager delivery is not reserved');
    const next = { ...current, state: 'sent', providerMessageId };
    durableJson(this.journalFile(record.delivery.id), next);
    return next;
  }

  acked(record) {
    const current = this.journal(record.delivery.id);
    if (current?.state !== 'sent' || current.providerMessageId !== record.providerMessageId) throw new Error('manager delivery has no send proof');
    durableJson(this.journalFile(record.delivery.id), { ...current, state: 'acked' });
  }

  pendingAcks(scope) {
    return files(this.journalDir).map(file => this.journal(file.slice(0, -5)))
      .filter(record => record.state === 'sent' && sameScope(record.scope, scope));
  }

  health() {
    const out = { localUnknown: 0, pendingAcks: 0, corrupt: 0 };
    for (const file of files(this.journalDir)) {
      try {
        const record = this.journal(file.slice(0, -5));
        if (record.state === 'reserved') out.localUnknown++;
        if (record.state === 'sent') out.pendingAcks++;
      } catch { out.corrupt++; }
    }
    for (const file of files(this.notificationsDir)) {
      try {
        const record = read(path.join(this.notificationsDir, file));
        if (!record || !validScope(record.scope) || !validId(record.messageId) || !HASH.test(record.digest)
          || !['reserved', 'sent'].includes(record.state)
          || (record.state === 'sent' && !validId(record.providerMessageId))) out.corrupt++;
        else if (record.state === 'reserved') out.localUnknown++;
      } catch { out.corrupt++; }
    }
    for (const file of files(this.requestsDir)) {
      try { this.validateRequest(read(path.join(this.requestsDir, file))); } catch { out.corrupt++; }
    }
    return out;
  }
}
