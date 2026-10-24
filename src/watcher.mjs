// Polls one account for the owner's own messages and turns "@claude ..." into runs.
//
// Polling, not a webhook: Evolution allows one webhook per instance and that slot
// may already belong to another service. A fromMe-filtered findMessages call is a
// cheap indexed query, so polling every couple of seconds costs little.

import path from 'node:path';
import { buildDirectory } from './directory.mjs';
import { sameUser } from './policy.mjs';
import { appendAction, readActions, writeJsonAtomic } from './store.mjs';
import { t } from './strings.mjs';
import { approvalAnswer, defuseTrigger, parseTrigger } from './trigger.mjs';
import { isGroupJid, messageText, quotedId, quotedText, timestampOf, userPart } from './text.mjs';

const CATCH_UP_SECONDS = 10 * 60;
const BATCH = 30;

export class AccountWatcher {
  // deps: { cfg, account, client, store, regex, runJob(cfg, job, jobDir), log, now }
  constructor(deps) {
    Object.assign(this, deps);
    this.now ||= Date.now;
    this.log ||= () => {};
    this.queue = Promise.resolve();
    this.pendingJobs = 0;
    this.namesPromise = null;
  }

  async init() {
    const ownerJid = this.account.ownerChat || await this.client.ownerJid(this.account.instance);
    if (!ownerJid) throw new Error(`cannot tell the owner number of instance ${this.account.instance}`);
    this.ownerChat = ownerJid.includes('@') ? ownerJid : `${ownerJid}@s.whatsapp.net`;
    this.ownerJids = [this.ownerChat];
    this.startedAt = Math.floor(this.now() / 1000);
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

  async poll() {
    const recs = await this.client.findMessages(this.account.instance, { key: { fromMe: true } }, BATCH);
    const sent = this.store.sentIds();
    const oldest = Math.floor(this.now() / 1000) - CATCH_UP_SECONDS;
    const fresh = recs
      .filter(r => r?.key?.id && r.key.fromMe === true && !this.store.hasSeen(r.key.id))
      .sort((a, b) => timestampOf(a) - timestampOf(b));
    if (!fresh.length) return;
    // Mark first: a message that crashes its handler must not run again on every poll.
    this.store.markSeen(fresh.map(r => r.key.id));
    for (const rec of fresh) {
      if (sent.has(rec.key.id) || timestampOf(rec) < oldest) continue;
      await this.handle(rec);
    }
  }

  async handle(rec) {
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
    const trig = parseTrigger(text, this.regex);
    // A swipe-reply to something a run sent continues that run's conversation. In the
    // owner's own chat no "@claude" is needed; anywhere else it still is, because there
    // the owner may simply be quoting the message while talking to people.
    const thread = qid ? this.store.getThread(qid) : null;
    if (thread && text.trim() && (trig || this.isOwnerChat(rec.key))) {
      this.enqueue(rec, { name: thread.triggerName || this.cfg.triggers[0], request: trig ? trig.request : text.trim() }, thread);
      return;
    }
    if (!trig) return;
    this.enqueue(rec, trig);
  }

  async resolveApproval(pending, answer) {
    const lang = this.cfg.language;
    const target = pending.target.name;
    this.store.removePending(pending.draftId);
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
    try {
      const key = await this.client.sendText(this.account.instance, this.ownerChat, defuseTrigger(text));
      this.store.recordSent(key.id);
      return key.id || '';
    } catch (err) {
      this.log('error', { account: this.account.name, event: 'notify-failed', error: err.message });
      return '';
    }
  }

  enqueue(rec, trig, thread = null) {
    this.pendingJobs += 1;
    this.queue = this.queue
      .then(() => this.runOne(rec, trig, thread))
      .catch(err => this.log('error', { account: this.account.name, event: 'job-crashed', error: err.message }))
      .finally(() => { this.pendingJobs -= 1; });
    return this.queue;
  }

  async buildJob(rec, trig, thread = null) {
    const key = rec.key;
    const alt = key.remoteJidAlt || '';
    const isGroup = isGroupJid(key.remoteJid);
    const isOwnerChat = !isGroup && this.isOwnerChat(key);
    let names = new Map();
    try { names = await this.getNames(); } catch { /* names are cosmetic here */ }
    const name = isOwnerChat ? 'owner'
      : names.get(key.remoteJid) || names.get(alt) || (isGroup ? key.remoteJid : `+${userPart(alt || key.remoteJid)}`);
    const sendTo = isGroup ? key.remoteJid
      : isOwnerChat ? this.ownerChat
        : alt.endsWith('@s.whatsapp.net') ? alt : key.remoteJid;
    const nowDate = new Date(this.now());
    return {
      id: key.id,
      triggerName: trig.name,
      account: { name: this.account.name, instance: this.account.instance },
      chat: { jid: key.remoteJid, alt, name, isGroup, isOwnerChat, sendTo },
      ownerChat: this.ownerChat,
      ownerJids: this.ownerJids,
      trigger: {
        key: { id: key.id, remoteJid: key.remoteJid, fromMe: true, ...(key.participant ? { participant: key.participant } : {}) },
        request: trig.request,
        quoted: thread ? '' : quotedText(rec),
        // Earlier requests in this conversation still name the chats it may use.
        earlier: thread?.requests || '',
      },
      resumeSessionId: thread?.sessionId || '',
      replyPrefix: this.cfg.replyPrefix,
      language: this.cfg.language,
      timezone: this.cfg.timezone,
      localTime: nowDate.toLocaleString('sv-SE', { timeZone: this.cfg.timezone }).slice(0, 16),
      createdAt: nowDate.toISOString(),
    };
  }

  async runOne(rec, trig, thread = null) {
    const job = await this.buildJob(rec, trig, thread);
    const jobDir = this.store.jobDir(job.id);
    writeJsonAtomic(path.join(jobDir, 'job.json'), job);
    const base = {
      account: this.account.name, job: job.id,
      chat: job.chat.isGroup ? 'group' : job.chat.isOwnerChat ? 'self' : 'dm',
      ...(thread ? { continues: thread.jobId } : {}),
    };
    this.log('info', { ...base, event: 'run-start', requestChars: job.trigger.request.length });

    const res = await this.runJob(this.cfg, job, jobDir);
    const actions = readActions(jobDir);
    const delivered = actions.some(a => a.type === 'send' || a.type === 'approval');
    const replyIds = actions.filter(a => a.type === 'send' && a.id).map(a => a.id);
    if (!res.ok) {
      await this.notifyOwner(t(this.cfg.language, 'failed', { name: job.triggerName, error: res.error || 'unknown error' }));
    } else if (!delivered && res.result) {
      replyIds.push(await this.notifyOwner(res.result));
      appendAction(jobDir, { type: 'fallback-to-owner' });
    }
    if (res.ok && res.sessionId) {
      for (const id of replyIds.filter(Boolean)) {
        this.store.linkThread(id, {
          jobId: job.id, sessionId: res.sessionId, triggerName: job.triggerName,
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
