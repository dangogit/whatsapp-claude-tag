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
import { managerEnvelope, managerTrigger, managerUserJid } from './manager.mjs';
import { ManagerDeliveryStore } from './manager-delivery-store.mjs';
import { pollManagerDeliveries } from './manager-deliveries.mjs';
import { mediaKind, ownVoiceNote, quotedMediaKind, saveMedia, transcribe } from './media.mjs';
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

  managerScopeMatches(scope) {
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
      return managerUserJid(connectedOwner) === managerUserJid(scope.actorId) && this.managerScopeMatches(scope);
    } catch { return false; }
  }

  async managerJobAllowed(job) {
    try { managerEnvelope(this.cfg, job); } catch { return false; }
    return this.managerIdentityMatches({ account: job.account, actorId: job.authenticatedOwnerChat, destination: job.ownerChat });
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
    for (const { job, dir } of this.store.unfinishedJobs(INTERRUPTED_MAX_AGE_MS)) {
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
    if (rec?.key?.fromMe !== true) return;
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

  async notifyForJob(job, text) {
    if (!job.backend || job.backend === 'claude') return this.notifyOwner(text);
    if (job.backend !== 'manager' || !await this.managerJobAllowed(job)) {
      this.log('warn', { account: this.account.name, event: 'manager-notification-refused', job: job.id });
      return '';
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
    if (key?.fromMe !== true) throw new Error('only owner-sent messages can become jobs');
    const backend = trig.backend;
    if (!['manager', 'claude'].includes(backend)
      || (backend === 'claude' && managerTrigger(this.cfg, trig.name))) throw new Error('invalid trigger backend');
    if (thread && (thread.backend || 'claude') !== backend) thread = null;
    const alt = key.remoteJidAlt || '';
    const isGroup = isGroupJid(key.remoteJid);
    const isOwnerChat = !isGroup && this.isOwnerChat(key);
    if (backend === 'manager' && (!this.isManagerOwnerChat(key) || !this.managerScopeMatches(trig.managerScope)
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
      ...(backend === 'manager' ? { authenticatedOwnerChat: trig.managerScope.actorId } : {}),
      trigger: {
        key: { id: key.id, remoteJid: key.remoteJid, fromMe: true, ...(key.participant ? { participant: key.participant } : {}) },
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

  async runOne(rec, trig, thread = null) {
    if (trig.voice) {
      let heard = null;
      try { heard = await this.voiceRequest(rec); } catch (err) {
        this.log('warn', { account: this.account.name, event: 'voice-failed', message: rec.key.id, error: err.message });
        return;
      }
      if (!heard) { this.log('info', { account: this.account.name, event: 'voice-not-addressed', message: rec.key.id }); return; }
      trig = { ...trig, request: heard.request };
    }
    const job = await this.buildJob(rec, trig, thread);
    if (job.backend === 'manager' && !await this.managerJobAllowed(job)) {
      this.log('warn', { account: this.account.name, event: 'manager-job-refused', job: job.id });
      return;
    }
    const jobDir = this.store.jobDir(job.id);
    writeJsonAtomic(path.join(jobDir, 'job.json'), job);
    const envelope = job.backend === 'manager' ? managerEnvelope(this.cfg, job) : null;
    if (envelope) this.managerDeliveryStore.registerRequest(job, envelope);
    const base = {
      account: this.account.name, job: job.id,
      chat: job.chat.isGroup ? 'group' : job.chat.isOwnerChat ? 'self' : 'dm',
      ...(thread ? { continues: thread.jobId } : {}),
    };
    this.log('info', { ...base, event: 'run-start', requestChars: job.trigger.request.length });

    const res = await this.runJob(this.cfg, job, jobDir);
    if (envelope && res.ok) this.managerDeliveryStore.registerRequest(job, envelope, res.conversationId);
    this.store.markDone(jobDir);
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
          actorId: job.authenticatedOwnerChat, conversationId: res.conversationId, taskIds: res.taskIds,
          managerScope: { account: job.account, actorId: job.authenticatedOwnerChat, destination: job.ownerChat },
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
    this.store.pruneJobs();
  }
}
