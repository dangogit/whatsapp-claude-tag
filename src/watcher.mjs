// Polls one account for the owner's own messages and turns "@claude ..." into runs.
//
// Polling, not a webhook: Evolution allows one webhook per instance and that slot
// may already belong to another service. A fromMe-filtered findMessages call is a
// cheap indexed query, so polling every couple of seconds costs little.

import fs from 'node:fs';
import path from 'node:path';
import { buildDirectory } from './directory.mjs';
import { confirmedTargets, sameUser } from './policy.mjs';
import { appendAction, readActions, writeJsonAtomic } from './store.mjs';
import { t } from './strings.mjs';
import { approvalAnswer, buildTriggerMatcher, canonicalTriggerName, defuseTrigger, parseVoiceTrigger } from './trigger.mjs';
import { managerEnvelope, managerTrigger, managerUserJid, managerJobScope, managerScopeConfigured } from './manager.mjs';
import { managerBody, peerKeyMatches, readManagerHistory, syncManagerHistory } from './manager-history.mjs';
import { createHash } from 'node:crypto';
import { ManagerDeliveryStore } from './manager-delivery-store.mjs';
import { pollManagerDeliveries } from './manager-deliveries.mjs';
import { mediaKind, ownVoiceNote, quotedMediaKind, saveMedia, transcribe } from './media.mjs';
import { MANAGER_MEDIA_LIMITS, managerMediaFailure, managerMediaIdentity, prepareManagerAttachment } from './manager-media.mjs';
import { NOT_DONE } from './runner.mjs';
import { isGroupJid, messageText, quotedId, quotedText, timestampOf, userPart } from './text.mjs';

const CATCH_UP_SECONDS = 10 * 60;
const BATCH = 30;
const MAX_PAGES = 5;
const APPROVAL_TTL_MS = 24 * 3600 * 1000;
const INTERRUPTED_MAX_AGE_MS = 60 * 60 * 1000;

export class AccountWatcher {
  // deps: { cfg, account, client, store, regex, runJob(cfg, job, jobDir), log, now }
  constructor(deps) {
    Object.assign(this, deps);
    this.now ||= Date.now;
    this.log ||= () => {};
    this.queue = Promise.resolve();
    this.pendingJobs = 0;
    this.namesPromise = null;
    this.directQueued = new Set();
    this.managerPeerJids = [];
    this.managerDeliveryStore = new ManagerDeliveryStore(this.store.dir);
    this.matchClaude = buildTriggerMatcher(this.cfg.triggers, 'claude');
    this.matchManager = this.cfg.manager?.enabled ? buildTriggerMatcher(this.cfg.manager.triggers, 'manager') : () => null;
  }

  async init() {
    let connectedOwner = '';
    if (!this.account.ownerChat || this.cfg.manager?.enabled) {
      try { connectedOwner = await this.client.ownerJid(this.account.instance); }
      catch (err) { if (!this.account.ownerChat) throw err; }
    }
    const ownerJid = this.account.ownerChat || connectedOwner;
    if (!ownerJid) throw new Error(`cannot tell the owner number of instance ${this.account.instance}`);
    this.ownerChat = ownerJid.includes('@') ? ownerJid : `${ownerJid}@s.whatsapp.net`;
    this.ownerJids = [this.ownerChat, ...this.store.ownerJids().filter(j => j !== this.ownerChat && j.endsWith('@lid'))];
    // ownerChat is a reply target override. Manager identity comes from the transport.
    const authenticatedOwner = managerUserJid(connectedOwner);
    this.managerOwnerChat = this.cfg.manager?.enabled && authenticatedOwner === managerUserJid(this.ownerChat) ? authenticatedOwner : '';
    this.managerOwnerJids = this.managerOwnerChat ? [this.managerOwnerChat] : [];
    if (this.cfg.manager?.enabled && !this.managerOwnerChat) {
      this.log('warn', { account: this.account.name, event: 'manager-owner-unverified' });
    }
    this.startedAt = Math.floor(this.now() / 1000);
    // Learn the self-chat LID from recent history now, not at the next self-chat message.
    try {
      const recent = await this.client.findMessages(this.account.instance, { key: { fromMe: true } }, 100);
      for (const rec of recent) if (rec?.key) this.learnOwnerLid(rec.key);
    } catch (err) {
      this.log('warn', { account: this.account.name, event: 'owner-lid', error: err.message });
    }
    this.getNames().catch(err => this.log('warn', { account: this.account.name, event: 'directory', error: err.message }));
  }

  getNames() {
    this.namesPromise ||= buildDirectory(this.client, this.account.instance, path.join(this.cfg.stateDir, 'cache'))
      .catch(err => { this.namesPromise = null; throw err; });
    return this.namesPromise;
  }

  isOwnerChat(key) {
    return this.ownerJids.some(o => sameUser(o, key.remoteJid) || sameUser(o, key.remoteJidAlt));
  }

  isManagerOwnerChat(key) {
    return key.fromMe === true && Boolean(this.managerOwnerChat) && this.managerOwnerJids.includes(managerUserJid(key.remoteJid));
  }

  managerScope() {
    return { actorId: this.managerOwnerChat, destination: this.managerOwnerChat,
      account: { name: this.account.name, instance: this.account.instance } };
  }

  directPeer() {
    return this.cfg.manager?.enabled && this.cfg.manager.directPeers?.find(p => p.account === this.account.name);
  }

  directScope() {
    const peer = this.directPeer();
    return peer ? { route: 'direct', ownerId: peer.ownerId, enabledSince: peer.enabledSince, actorId: peer.actorId, destination: peer.actorId,
      account: { name: this.account.name, instance: this.account.instance } } : null;
  }

  managerScopes() {
    return [this.managerScope(), this.directScope()].filter(scope => scope && this.managerScopeMatches(scope));
  }

  async refreshPeerJids() {
    const peer = this.directPeer();
    if (!peer || !await this.managerIdentityMatches(this.directScope())) return;
    if (typeof this.client.peerJids !== 'function') throw new Error('trusted manager peer mapping unavailable');
    const aliases = await this.client.peerJids(this.account.instance, peer.actorId);
    if (!Array.isArray(aliases) || !aliases.every(j => /^\d+@lid$/.test(j))) throw new Error('invalid manager peer mapping');
    this.managerPeerJids = aliases;
  }

  async dedicatedOutgoing(key) {
    if (key?.fromMe !== true || key.participant || key.participantAlt) return false;
    const remote = managerUserJid(key.remoteJid), alt = managerUserJid(key.remoteJidAlt);
    if (!remote) return false;
    for (const peer of this.cfg.manager?.enabled ? this.cfg.manager.directPeers || [] : []) {
      // A provider phone identity proves an unrelated destination without a LID
      // lookup. For LID-only traffic, establish the sending owner first.
      if (remote !== peer.ownerId && !remote.endsWith('@lid')) continue;
      if (remote.endsWith('@lid') && alt.endsWith('@s.whatsapp.net') && alt !== peer.ownerId) continue;
      let owner;
      try { owner = managerUserJid(await this.client.ownerJid(this.account.instance)); } catch { return true; }
      if (owner !== peer.actorId) continue;
      if (peerKeyMatches(key, peer.ownerId)) return true;
      // Historical aliases cannot prove that a different LID is unrelated to
      // the business peer. Only a positive provider phone identity can allow
      // legacy routing on the authorized personal account.
      this.log('warn', { account: this.account.name, event: 'manager-outgoing-lid-unresolved', message: key.id });
      return true;
    }
    return false;
  }

  managerScopeMatches(scope) {
    if (scope?.route === 'direct') return managerScopeConfigured(this.cfg, scope)
      && scope.account.name === this.account.name && scope.account.instance === this.account.instance
      && this.managerOwnerChat === scope.ownerId && managerUserJid(this.ownerChat) === scope.ownerId;
    const actor = managerUserJid(scope?.actorId);
    const account = this.cfg.accounts.find(a => a.name === scope?.account?.name && a.instance === scope?.account?.instance);
    return this.cfg.manager?.enabled === true && Boolean(actor) && actor === this.managerOwnerChat
      && managerUserJid(scope.destination) === actor && managerUserJid(this.ownerChat) === actor
      && Boolean(account) && account.name === this.account.name && account.instance === this.account.instance
      && (!account.ownerChat || managerUserJid(account.ownerChat) === actor);
  }

  async managerIdentityMatches(scope) {
    if (!this.managerScopeMatches(scope)) return false;
    try {
      const connectedOwner = await this.client.ownerJid(scope.account.instance);
      return managerUserJid(connectedOwner) === managerUserJid(scope.ownerId || scope.actorId) && this.managerScopeMatches(scope);
    } catch { return false; }
  }

  async managerJobAllowed(job) {
    try { managerEnvelope(this.cfg, job); } catch { return false; }
    return this.managerIdentityMatches(managerJobScope(job));
  }

  // Newest own messages, paging back while a page still holds unseen messages inside
  // the catch-up window, so a burst of sends cannot push a trigger out of view.
  async fetchFresh(oldest) {
    const fresh = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const recs = await this.client.findMessages(this.account.instance, { key: { fromMe: true } }, BATCH, page);
      const unseen = recs.filter(r => r?.key?.id && r.key.fromMe === true && !this.store.hasSeen(r.key.id));
      fresh.push(...unseen);
      const last = recs[recs.length - 1];
      if (recs.length < BATCH || !unseen.length || timestampOf(last) < oldest) break;
    }
    return fresh.sort((a, b) => timestampOf(a) - timestampOf(b));
  }

  poll() {
    this.polling = this.pollOnce().then(() => pollManagerDeliveries(this)).finally(() => { this.polling = null; });
    return this.polling;
  }

  async pollOnce() {
    const oldest = Math.floor(this.now() / 1000) - CATCH_UP_SECONDS;
    const fresh = await this.fetchFresh(oldest);
    if (this.directPeer()) {
      if (!this.nextDirectRetry || this.now() >= this.nextDirectRetry) {
        this.nextDirectRetry = this.now() + 30_000;
        for (const { job } of this.store.unfinishedJobs(Infinity)) {
          if (job.managerScope?.route === 'direct' && await this.managerJobAllowed(job)) this.queueDirect(job);
        }
      }
      await this.refreshPeerJids();
      const scope = this.directScope();
      if (await this.managerIdentityMatches(scope)) {
        const activation = Math.floor(Date.parse(scope.enabledSince) / 1000);
        // Evolution orders by timestamp only. Reconcile every post-activation
        // row so same-second ties and late provider arrivals cannot hide behind
        // a previous message-id cursor. Durable jobs deduplicate accepted work.
        const candidates = new Map();
        for (const jid of [scope.actorId, ...this.managerPeerJids]) {
          const stream = [];
          let finished = false, expectedTotal;
          for (let page = 1; page <= 1000; page++) {
            const result = await this.client.findMessagePage(this.account.instance, { key: { remoteJid: jid,
              ...(jid === scope.actorId ? { remoteJidAlt: scope.actorId } : {}) } }, BATCH, page);
            const rows = result.records;
            if (!Array.isArray(rows) || result.currentPage !== page || !Number.isSafeInteger(result.total) || result.total < 0
              || result.pages !== Math.ceil(result.total / BATCH)
              || rows.length !== Math.min(BATCH, Math.max(0, result.total - (page - 1) * BATCH))
              || (expectedTotal !== undefined && expectedTotal !== result.total)) throw new Error('manager incoming pagination unavailable');
            expectedTotal = result.total;
            for (const rec of rows) {
              if (!peerKeyMatches(rec?.key, scope.actorId, this.managerPeerJids)) throw new Error('manager incoming crossed scope');
              if (timestampOf(rec) <= activation) { finished = true; break; }
              if (rec.key.fromMe === false) stream.push(rec);
            }
            if (finished || page >= result.pages) { finished = true; break; }
          }
          if (!finished) throw new Error('manager incoming catch-up limit exceeded');
          for (const rec of stream.reverse()) if (!candidates.has(rec.key.id)) candidates.set(rec.key.id, rec);
        }
        for (const rec of [...candidates.values()].sort((a, b) => timestampOf(a) - timestampOf(b))) {
          if (!await this.managerIdentityMatches(scope)) throw new Error('manager incoming identity changed');
          await this.handle(rec);
          this.store.markSeen([rec.key.id]);
        }
      }
    }
    if (!fresh.length) return;
    const sent = this.store.sentIds();
    // Mark first: a message that crashes its handler must not run again on every poll.
    this.store.markSeen(fresh.map(r => r.key.id));
    for (const rec of fresh) {
      if (sent.has(rec.key.id) || timestampOf(rec) < oldest) continue;
      try {
        await this.handle(rec);
      } catch (err) {
        this.log('error', { account: this.account.name, event: 'handle-failed', message: rec.key.id, error: err.message });
      }
    }
  }

  // Waits for the poll in flight and every queued run.
  async drain() {
    await this.polling;
    let queue;
    do { queue = this.queue; await queue; } while (queue !== this.queue);
  }

  // A run the process never finished (stop, crash, reinstall) is reported, not
  // retried: it may already have sent something, and a retry could send it twice.
  async reportInterrupted() {
    for (const { job, dir } of this.store.unfinishedJobs(Infinity)) {
      if (job.managerScope?.route === 'direct') {
        if (await this.managerJobAllowed(job)) this.queueDirect(job);
        continue;
      }
      if (Date.now() - fs.statSync(path.join(dir, 'job.json')).mtimeMs > INTERRUPTED_MAX_AGE_MS) continue;
      this.store.markAbandoned(dir);
      await this.notifyForJob(job, t(this.cfg.language, 'interrupted', { request: job.trigger.request.slice(0, 120) }));
      this.log('warn', { account: this.account.name, event: 'run-interrupted', job: job.id });
    }
  }

  // The self-chat typed on the phone is stored under the owner's LID, with the phone
  // JID only as remoteJidAlt. Learn that LID so it counts as the owner chat everywhere.
  learnOwnerLid(key) {
    const lid = key.remoteJid || '';
    // Never reuse the reply-target alias cache as proof of the connected identity.
    const managerLid = managerUserJid(lid);
    if (key.fromMe === true && this.managerOwnerChat && managerLid.endsWith('@lid')
      && managerUserJid(key.remoteJidAlt) === this.managerOwnerChat && !this.managerOwnerJids.includes(managerLid)) {
      this.managerOwnerJids.push(managerLid);
    }
    if (key.fromMe === true && lid.endsWith('@lid') && key.remoteJidAlt && sameUser(key.remoteJidAlt, this.ownerChat)
      && !this.ownerJids.includes(lid)) {
      this.ownerJids.push(lid);
      this.store.saveOwnerJids(this.ownerJids);
    }
  }

  async handle(rec) {
    if (rec?.key?.fromMe === false) {
      const scope = this.directScope();
      if (!scope || timestampOf(rec) <= Math.floor(Date.parse(scope.enabledSince) / 1000)
        || !peerKeyMatches(rec.key, scope.actorId, this.managerPeerJids) || !await this.managerIdentityMatches(scope)) return;
      if (this.store.sentIds().has(rec.key.id)) return;
      const peerJids = [...new Set([...this.managerPeerJids, rec.key.remoteJid, rec.key.remoteJidAlt].filter(j => j?.endsWith('@lid')))];
      this.managerPeerJids = peerJids;
      const body = managerBody(rec);
      if (body.ignored) return;
      const trig = { backend: 'manager', name: this.cfg.manager.triggers[0], request: body.body, managerScope: structuredClone(scope) };
      const job = await this.buildJob(rec, trig);
      job.directRecord = structuredClone(rec);
      job.unsupportedMedia = body.unsupported;
      const dir = this.store.jobDir(job.id);
      const file = path.join(dir, 'job.json');
      if (fs.existsSync(file)) {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        const { attachments: _attachments, ...savedEnvelope } = managerEnvelope(this.cfg, saved);
        if (JSON.stringify(savedEnvelope) !== JSON.stringify(managerEnvelope(this.cfg, job))
          || managerMediaIdentity(saved.directRecord) !== managerMediaIdentity(rec)) throw new Error('manager message id conflict');
        if (!fs.existsSync(path.join(dir, 'done'))) this.queueDirect(saved);
        return;
      }
      if (this.managerDeliveryStore.request(scope, job.id)) return;
      writeJsonAtomic(file, job, { durable: true });
      this.queueDirect(job);
      return;
    }
    if (rec?.key?.fromMe !== true || await this.dedicatedOutgoing(rec.key)) return;
    this.learnOwnerLid(rec.key);
    const text = messageText(rec);
    const qid = quotedId(rec);
    if (qid && this.isOwnerChat(rec.key)) {
      const pending = this.store.getPending(qid);
      const answer = pending && approvalAnswer(text);
      if (answer) {
        await this.resolveApproval(pending, answer);
        return;
      }
    }
    const trig = this.matchClaude(text) || this.matchManager(text);
    // A swipe-reply to something a run sent continues that run's conversation. In the
    // owner's own chat no "@claude" is needed; anywhere else it still is, because there
    // the owner may simply be quoting the message while talking to people.
    const thread = qid ? this.store.getThread(qid) : null;
    const backend = trig?.backend || thread?.backend || 'claude';
    if (!['manager', 'claude'].includes(backend)) return;
    if (backend === 'manager' && (!this.cfg.manager?.enabled || !this.isManagerOwnerChat(rec.key))) return;
    if (thread && text.trim() && (trig || this.isOwnerChat(rec.key))) {
      const compatible = backend === (thread.backend || 'claude') && (backend === 'manager'
        ? this.managerScopeMatches(thread.managerScope) && thread.actorId === thread.managerScope.actorId && managerTrigger(this.cfg, thread.triggerName)
        : !managerTrigger(this.cfg, thread.triggerName));
      if (!compatible) {
        if (trig) this.enqueue(rec, { ...trig, omitQuoted: true });
        return;
      }
      // "yes" to a message of the run that named a person or an address makes that message
      // part of what the owner authorised: the same check that lets "send it to Dana" through.
      const approved = backend === 'claude' && approvalAnswer(text) === 'yes' ? confirmedTargets(quotedText(rec)) : '';
      this.enqueue(rec, { backend, name: trig?.name || thread.triggerName || this.cfg.triggers[0], request: trig ? trig.request : text.trim() }, { ...thread, approved });
      return;
    }
    if (!trig) {
      // A voice note the owner sends to their own chat is a request when it starts with the
      // assistant's name ("Claude, ..."). It is transcribed in the run queue, not in the poll.
      if (this.cfg.media.voiceCommands && this.cfg.media.whisperModel && ownVoiceNote(rec) && this.isOwnerChat(rec.key)) {
        this.enqueue(rec, { backend: 'claude', name: this.cfg.triggers[0], request: '', voice: true });
      }
      return;
    }
    this.enqueue(rec, trig);
  }

  queueDirect(job) {
    if (this.directQueued.has(job.id)) return;
    this.directQueued.add(job.id);
    this.pendingJobs++;
    this.queue = this.queue.then(() => this.runOne(job.directRecord, null, null, job))
      .catch(() => this.log('error', { account: this.account.name, event: 'manager-job-pending', job: job.id }))
      .finally(() => { this.directQueued.delete(job.id); this.pendingJobs--; });
  }

  // Transcribe a voice note and decide whether it is addressed to the assistant.
  async voiceRequest(rec) {
    const dir = path.join(this.store.jobDir(rec.key.id), 'media');
    const k = rec.key;
    const got = await saveMedia(this.client, this.account.instance, { id: k.id, remoteJid: k.remoteJid, fromMe: true }, dir);
    const text = await transcribe(got.file, this.cfg.media);
    return parseVoiceTrigger(text, this.cfg.triggers);
  }

  async resolveApproval(pending, answer) {
    const lang = this.cfg.language;
    const target = pending.target.name;
    this.store.removePending(pending.draftId);
    if (answer === 'yes' && this.now() - (pending.createdAt || 0) > APPROVAL_TTL_MS) {
      await this.notifyOwner(t(lang, 'approvalExpired', { target }));
      return;
    }
    if (answer === 'no') {
      await this.notifyOwner(t(lang, 'approvalDropped', { target }));
      this.log('info', { account: this.account.name, event: 'approval-dropped', draft: pending.draftId });
      return;
    }
    try {
      const key = await this.client.sendText(this.account.instance, pending.target.sendTo, pending.text);
      this.store.recordSent(key.id);
      await this.notifyOwner(t(lang, 'approvedSent', { target }));
      this.log('info', { account: this.account.name, event: 'approval-sent', draft: pending.draftId });
    } catch (err) {
      await this.notifyOwner(t(lang, 'approvalFailed', { target, error: err.message.slice(0, 200) }));
      this.log('error', { account: this.account.name, event: 'approval-failed', error: err.message });
    }
  }

  async notifyOwner(text) {
    return this.sendNotification(text, this.account.instance, this.ownerChat);
  }

  async notifyForJob(job, text, kind = 'result') {
    if (!job.backend || job.backend === 'claude') return this.notifyOwner(text);
    if (job.backend !== 'manager' || !await this.managerJobAllowed(job)) {
      this.log('warn', { account: this.account.name, event: 'manager-notification-refused', job: job.id });
      return '';
    }
    if (job.managerScope?.route === 'direct') {
      const scope = managerJobScope(job);
      const file = this.managerDeliveryStore.notificationFile(scope, job.id, kind);
      const digest = createHash('sha256').update(text).digest('hex');
      if (fs.existsSync(file)) {
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (record.digest !== digest || JSON.stringify(record.scope) !== JSON.stringify(scope) || record.messageId !== job.id) throw new Error('manager notification changed');
        if (record.providerMessageId) this.store.recordSent(record.providerMessageId);
        return record.providerMessageId || '';
      }
      writeJsonAtomic(file, { state: 'reserved', digest, scope, messageId: job.id }, { durable: true });
      if (!await this.managerJobAllowed(job)) return '';
      const key = await this.client.sendText(job.account.instance, job.ownerChat, defuseTrigger(text));
      if (!key?.id) throw new Error('manager notification outcome unknown');
      writeJsonAtomic(file, { state: 'sent', digest, scope, messageId: job.id, providerMessageId: key.id }, { durable: true });
      this.store.recordSent(key.id);
      return key.id;
    }
    return this.sendNotification(text, job.account.instance, job.ownerChat);
  }

  async sendNotification(text, instance, destination) {
    try {
      const key = await this.client.sendText(instance, destination, defuseTrigger(text));
      this.store.recordSent(key.id);
      return key.id || '';
    } catch (err) {
      this.log('error', { account: this.account.name, event: 'notify-failed', error: err.message });
      return '';
    }
  }

  enqueue(rec, trig, thread = null) {
    // The queue must retain the identity that accepted the request, even if init
    // runs again or account configuration changes before this job gets its turn.
    if (trig.backend === 'manager') trig = { ...trig, managerScope: this.managerScope() };
    this.pendingJobs += 1;
    this.queue = this.queue
      .then(() => this.runOne(rec, trig, thread))
      .catch(err => this.log('error', { account: this.account.name, event: 'job-crashed', error: err.message }))
      .finally(() => { this.pendingJobs -= 1; });
    return this.queue;
  }

  // A thread linked mid-run has no session id yet; the run's result file has it.
  sessionFor(thread) {
    if (!thread || (thread.backend && thread.backend !== 'claude')) return '';
    if (thread.sessionId) return thread.sessionId;
    try {
      const out = JSON.parse(fs.readFileSync(path.join(this.store.jobDir(thread.jobId), 'claude.json'), 'utf8'));
      return typeof out.session_id === 'string' ? out.session_id : '';
    } catch { return ''; }
  }

  async buildJob(rec, trig, thread = null) {
    const key = rec.key;
    const direct = trig.managerScope?.route === 'direct';
    if (key?.fromMe !== true && !(direct && key?.fromMe === false)) throw new Error('only owner-sent messages can become jobs');
    const backend = trig.backend;
    if (!['manager', 'claude'].includes(backend)
      || (backend === 'claude' && managerTrigger(this.cfg, trig.name))) throw new Error('invalid trigger backend');
    if (thread && (thread.backend || 'claude') !== backend) thread = null;
    const alt = key.remoteJidAlt || '';
    const isGroup = isGroupJid(key.remoteJid);
    const isOwnerChat = !isGroup && this.isOwnerChat(key);
    if (backend === 'manager' && (!(direct ? peerKeyMatches(key, trig.managerScope.actorId, this.managerPeerJids) : this.isManagerOwnerChat(key)) || !this.managerScopeMatches(trig.managerScope)
      || !managerTrigger(this.cfg, trig.name))) throw new Error('manager requests require the owner self-chat');
    if (backend === 'manager' && thread && (!this.managerScopeMatches(thread.managerScope)
      || thread.actorId !== thread.managerScope.actorId)) thread = null;
    let names = new Map();
    try { names = await this.getNames(); } catch { /* names are cosmetic here */ }
    const name = isOwnerChat ? 'owner'
      : names.get(key.remoteJid) || names.get(alt) || (isGroup ? key.remoteJid : `+${userPart(alt || key.remoteJid)}`);
    const sendTo = backend === 'manager' ? trig.managerScope.destination : isGroup ? key.remoteJid
      : isOwnerChat ? this.ownerChat
        : alt.endsWith('@s.whatsapp.net') ? alt : key.remoteJid;
    const nowDate = new Date(this.now());
    return {
      id: key.id,
      backend,
      triggerName: canonicalTriggerName(trig.name, backend === 'manager' ? this.cfg.manager.triggers : this.cfg.triggers) || trig.name,
      account: backend === 'manager' ? { ...trig.managerScope.account } : { name: this.account.name, instance: this.account.instance },
      chat: { jid: key.remoteJid, alt, name, isGroup, isOwnerChat, sendTo },
      ownerChat: backend === 'manager' ? trig.managerScope.destination : this.ownerChat,
      ownerJids: backend === 'manager' ? [...this.managerOwnerJids] : this.ownerJids,
      ...(backend === 'manager' ? { authenticatedOwnerChat: trig.managerScope.ownerId || trig.managerScope.actorId } : {}),
      ...(direct ? { managerScope: structuredClone(trig.managerScope), authenticatedPeerJids: [...this.managerPeerJids] } : {}),
      trigger: {
        key: { id: key.id, remoteJid: key.remoteJid, fromMe: key.fromMe, ...(key.remoteJidAlt ? { remoteJidAlt: key.remoteJidAlt } : {}), ...(key.participant ? { participant: key.participant } : {}) },
        request: trig.request,
        quoted: backend === 'manager' || thread || trig.omitQuoted ? '' : quotedText(rec),
        // Earlier requests in this conversation still name the chats it may use.
        earlier: backend === 'manager' ? '' : thread?.requests || '',
        approved: backend === 'manager' ? '' : thread?.approved || '',
        // media on the owner's message itself, and on the message it replies to
        mediaId: backend === 'claude' && mediaKind(rec) ? key.id : '',
        mediaKind: backend === 'claude' ? mediaKind(rec) : '',
        quotedMediaId: backend === 'claude' && !trig.omitQuoted && quotedMediaKind(rec) ? quotedId(rec) : '',
        quotedMediaKind: backend === 'claude' && !trig.omitQuoted ? quotedMediaKind(rec) : '',
        voice: Boolean(trig.voice),
      },
      resumeSessionId: backend === 'claude' ? this.sessionFor(thread) : '',
      ...(backend === 'manager' ? { resumeConversationId: thread?.conversationId || '' } : {}),
      replyPrefix: this.cfg.replyPrefix,
      language: this.cfg.language,
      timezone: this.cfg.timezone,
      localTime: nowDate.toLocaleString('sv-SE', { timeZone: this.cfg.timezone }).slice(0, 16),
      createdAt: nowDate.toISOString(),
    };
  }

  async runOne(rec, trig, thread = null, savedJob = null) {
    if (trig?.voice) {
      let heard = null;
      try { heard = await this.voiceRequest(rec); } catch (err) {
        this.log('warn', { account: this.account.name, event: 'voice-failed', message: rec.key.id, error: err.message });
        return;
      }
      if (!heard) { this.log('info', { account: this.account.name, event: 'voice-not-addressed', message: rec.key.id }); return; }
      trig = { ...trig, request: heard.request };
    }
    const job = savedJob || await this.buildJob(rec, trig, thread);
    if (job.backend === 'manager' && !await this.managerJobAllowed(job)) {
      this.log('warn', { account: this.account.name, event: 'manager-job-refused', job: job.id });
      return;
    }
    const jobDir = this.store.jobDir(job.id);
    if (!savedJob) writeJsonAtomic(path.join(jobDir, 'job.json'), job);
    let envelope = job.backend === 'manager' ? managerEnvelope(this.cfg, job) : null;
    if (envelope && job.managerScope?.route !== 'direct') this.managerDeliveryStore.registerRequest(job, envelope);
    const base = {
      account: this.account.name, job: job.id,
      chat: job.chat.isGroup ? 'group' : job.chat.isOwnerChat ? 'self' : 'dm',
      ...(thread ? { continues: thread.jobId } : {}),
    };
    this.log('info', { ...base, event: 'run-start', requestChars: job.trigger.request.length });

    let res;
    if (job.managerScope?.route === 'direct') {
      const resultFile = path.join(jobDir, 'direct-result.json');
      if (fs.existsSync(resultFile)) res = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      else {
        const historyFile = path.join(jobDir, 'conversation-history.json');
        let entries;
        try {
          // A previously registered request keeps its original immutable envelope,
          // including jobs accepted before attachment support was installed.
          const alreadyRegistered = this.managerDeliveryStore.request(job.managerScope, job.id);
          const prepare = !job.mediaPrepared && !alreadyRegistered;
          if (fs.existsSync(historyFile) && !prepare) entries = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
          else {
            await this.refreshPeerJids();
            entries = await readManagerHistory(this.client, job.account.instance, job.managerScope, this.managerPeerJids, job.directRecord, prepare ? async records => {
              const items = []; let images = 0;
              for (const source of records) {
                if (!await this.managerJobAllowed(job)) throw new Error('manager media identity changed');
                let item = await (this.prepareManagerMedia || prepareManagerAttachment)(this.cfg, this.client, job.managerScope, source,
                  { current: source.key.id === job.id, authenticatedPeerJids: this.managerPeerJids });
                if (!item) continue;
                if (images + (item.images?.length || 0) > MANAGER_MEDIA_LIMITS.images) {
                  const { images: _images, text: _text, ...metadata } = item;
                  item = { ...metadata, status: 'failed', commandEligible: false, reason: 'image_limit' };
                }
                images += item.images?.length || 0; items.push(item);
              }
              if (items.length) job.attachments = { schemaVersion: 1, items };
              job.mediaPrepared = true;
              envelope = managerEnvelope(this.cfg, job);
              writeJsonAtomic(path.join(jobDir, 'job.json'), job, { durable: true });
            } : undefined);
            writeJsonAtomic(historyFile, entries, { durable: true });
          }
          await syncManagerHistory(this.cfg, job.managerScope, envelope.conversationId, job.id, entries, this.managerSync);
        } catch {
          // Keep the durable job pending. A transient read or sync failure must
          // never turn a partly imported conversation into an executable request.
          this.log('warn', { account: this.account.name, event: 'manager-history-pending', job: job.id });
          await this.notifyForJob(job, this.cfg.language === 'he'
            ? 'עדיין לא הצלחתי לטעון את כל היסטוריית השיחה. הבקשה נשמרה ואנסה שוב, אבל טרם התחלתי לבצע אותה.'
            : 'I could not load the complete conversation history. Your request is saved and will be retried; execution has not started.', 'history');
          return;
        }
        if (!await this.managerJobAllowed(job)) return;
        this.managerDeliveryStore.registerRequest(job, envelope);
        const currentMedia = job.attachments?.items.find(item => item.messageId === job.id);
        res = job.unsupportedMedia && currentMedia?.status !== 'ready' ? { ok: true, result: managerMediaFailure(currentMedia, this.cfg.language),
          conversationId: envelope.conversationId, taskIds: [] } : await this.runJob(this.cfg, job, jobDir);
        if (!res.ok) {
          await this.notifyForJob(job, this.cfg.language === 'he'
            ? 'לא קיבלתי אישור ממנהל המשימות. הבקשה נשמרה ואבדוק שוב את אותה בקשה.'
            : 'The manager has not confirmed this request. It is saved and I will check the same request again.', 'request');
          return;
        }
        writeJsonAtomic(resultFile, res, { durable: true });
      }
    } else res = await this.runJob(this.cfg, job, jobDir);
    if (envelope && res.ok) this.managerDeliveryStore.registerRequest(job, envelope, res.conversationId);
    if (job.managerScope?.route !== 'direct') this.store.markDone(jobDir);
    const actions = readActions(jobDir);
    const delivered = actions.some(a => a.type === 'send' || a.type === 'approval');
    const replyIds = actions.filter(a => a.type === 'send' && a.id).map(a => a.id);
    // A final line that starts with NOT DONE: reaches the owner even when the run sent
    // something elsewhere, so "I could only text Ben, not invite him" is never lost in a log.
    const notDone = res.ok && res.result.toUpperCase().startsWith(NOT_DONE);
    const toldOwner = actions.some(a => a.type === 'send' && this.ownerJids.some(o => sameUser(o, a.to)));
    const finalLine = notDone ? `⚠️ ${res.result.slice(NOT_DONE.length).trim()}` : res.result;
    if (!res.ok) {
      await this.notifyForJob(job, t(this.cfg.language, 'failed', { name: job.triggerName, error: res.error || 'unknown error' }));
    } else if ((!delivered || (notDone && !toldOwner)) && finalLine) {
      const replyId = await this.notifyForJob(job, finalLine);
      if (replyId) {
        replyIds.push(replyId);
        appendAction(jobDir, { type: notDone ? 'not-done-to-owner' : 'fallback-to-owner' });
      }
    }
    if (res.ok && (job.backend === 'manager' ? res.conversationId : res.sessionId)) {
      for (const id of replyIds.filter(Boolean)) {
        this.store.linkThread(id, job.backend === 'manager' ? {
          backend: 'manager', jobId: job.id, triggerName: job.triggerName,
          actorId: managerJobScope(job).actorId, conversationId: res.conversationId, taskIds: res.taskIds,
          managerScope: managerJobScope(job),
        } : {
          backend: 'claude',
          jobId: job.id, sessionId: res.sessionId, triggerName: job.triggerName,
          // what the owner wrote, not what a "yes" confirmed: a confirmation covers one run
          requests: [job.trigger.earlier, job.trigger.request].filter(Boolean).join('\n').slice(-4000),
        });
      }
    }
    this.log(res.ok ? 'info' : 'error', {
      ...base, event: 'run-end', ok: res.ok, error: res.ok ? undefined : res.error,
      actions: actions.map(a => a.type), costUsd: res.costUsd, durationMs: res.durationMs,
    });
    if (job.managerScope?.route === 'direct' && replyIds.length) this.store.markDone(jobDir);
    this.store.pruneJobs();
  }
}
