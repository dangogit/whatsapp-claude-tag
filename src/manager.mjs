// Optional trusted local adapter. Requests never become command-line arguments.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { writeJsonAtomic } from './store.mjs';
import { t } from './strings.mjs';
import { canonicalTriggerName } from './trigger.mjs';

const MAX_OUTPUT = 64 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const USER_JID = /^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/;
const DELIVERY_ID = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function exactObject(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}

function validId(value) { return typeof value === 'string' && ID.test(value); }
function taskIds(value) { return Array.isArray(value) && value.length <= 100 && value.every(validId); }
function reply(value) { return typeof value === 'string' && Boolean(value.trim()) && value.length <= 16_000; }

export function managerDeliveryValid(value) {
  return exactObject(value, ['id', 'token', 'body', 'conversationId', 'taskIds', 'sourceMessageId'])
    && typeof value.id === 'string' && DELIVERY_ID.test(value.id)
    && typeof value.token === 'string' && TOKEN.test(value.token)
    && reply(value.body) && validId(value.conversationId) && taskIds(value.taskIds) && validId(value.sourceMessageId);
}

export function managerScopeConfigured(cfg, scope) {
  const actor = managerUserJid(scope?.actorId);
  const account = cfg.accounts.find(a => a.name === scope?.account?.name && a.instance === scope?.account?.instance);
  if (!cfg.manager?.enabled || !actor || actor !== scope.actorId || scope.destination !== actor || !account) return false;
  if (scope.route === 'direct') return (cfg.manager.directPeers || []).some(peer => peer.account === account.name
    && peer.actorId === actor && peer.ownerId === scope.ownerId && peer.enabledSince === scope.enabledSince)
    && (!account.ownerChat || managerUserJid(account.ownerChat) === scope.ownerId);
  return !scope.route && !scope.ownerId && (!account.ownerChat || managerUserJid(account.ownerChat) === actor);
}

export function managerJobScope(job) {
  return job.managerScope || { account: job.account, actorId: job.authenticatedOwnerChat, destination: job.ownerChat };
}

export function managerConversationId(account, actorId) {
  return `whatsapp:${createHash('sha256').update(JSON.stringify([account, actorId])).digest('hex')}`;
}

export function managerControlEnvelope(cfg, scope, conversationId) {
  if (!managerScopeConfigured(cfg, scope) || !validId(conversationId)) throw new Error('managerRefused');
  return { schemaVersion: 1, source: 'whatsapp', account: scope.account.name, actorId: scope.actorId, conversationId };
}

function validControlEnvelope(cfg, envelope, extra = [], requireDeliveries = true) {
  return cfg.manager?.enabled === true && (!requireDeliveries || cfg.manager.deliveries === true)
    && exactObject(envelope, ['schemaVersion', 'source', 'account', 'actorId', 'conversationId', ...extra])
    && envelope.schemaVersion === 1 && envelope.source === 'whatsapp'
    && Boolean(managerUserJid(envelope.actorId)) && managerUserJid(envelope.actorId) === envelope.actorId
    && cfg.accounts.some(a => a.name === envelope.account && ((!a.ownerChat || managerUserJid(a.ownerChat) === envelope.actorId)
      || cfg.manager.directPeers?.some(p => p.account === a.name && p.actorId === envelope.actorId
        && (!a.ownerChat || managerUserJid(a.ownerChat) === p.ownerId))))
    && validId(envelope.conversationId);
}

export async function runManagerConversationSync(cfg, envelope) {
  const entryId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value);
  if (!validControlEnvelope(cfg, envelope, ['entries', 'complete', 'throughId'], false)
    || !entryId(envelope.throughId) || typeof envelope.complete !== 'boolean'
    || !Array.isArray(envelope.entries) || envelope.entries.length > 100
    || Buffer.byteLength(JSON.stringify(envelope)) > 65536
    || !envelope.entries.every(e => e && entryId(e.id) && ['user', 'assistant'].includes(e.role)
      && typeof e.body === 'string' && e.body.trim() && Buffer.byteLength(e.body) <= 32768
      && typeof e.at === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(e.at) && Number.isFinite(Date.parse(e.at))
      && (!Object.hasOwn(e, 'quotedId') || entryId(e.quotedId)))) return { ok: false, error: t(cfg.language, 'managerRefused') };
  return invokeManager(cfg, 'conversation-sync', envelope, data => exactObject(data, ['ok', 'conversationId', 'stored', 'complete', 'throughId'])
    && data.ok === true && data.conversationId === envelope.conversationId && typeof data.complete === 'boolean' && (!envelope.complete || data.complete)
    && data.throughId === envelope.throughId && Number.isSafeInteger(data.stored) && data.stored >= 0);
}

export function managerUserJid(value) {
  if (typeof value !== 'string' || !value) return '';
  const jid = value.includes('@') ? value : `${value}@s.whatsapp.net`;
  return USER_JID.test(jid) ? jid.replace(/:\d+@/, '@') : '';
}

export function managerTrigger(cfg, name) {
  return cfg.manager?.enabled === true && Boolean(canonicalTriggerName(name, cfg.manager.triggers));
}

export function managerEnvelope(cfg, job) {
  const key = job.trigger?.key;
  if (job.managerScope?.route === 'direct') {
    const scope = job.managerScope;
    const aliases = job.authenticatedPeerJids || [];
    if (!Array.isArray(aliases) || !aliases.every(jid => /^\d+@lid$/.test(jid))) throw new Error('managerRefused');
    const peerJids = [scope.actorId, ...aliases];
    if (!managerScopeConfigured(cfg, scope) || job.backend !== 'manager' || key?.fromMe !== false
      || job.chat?.isGroup || !managerUserJid(key.remoteJid) || key.participant
      || !peerJids.includes(managerUserJid(key.remoteJid))
      || (key.remoteJidAlt && !peerJids.includes(managerUserJid(key.remoteJidAlt)))
      || job.account?.name !== scope.account.name || job.account?.instance !== scope.account.instance
      || !job.directRecord || job.directRecord.key?.id !== job.id
      || !Number.isFinite(Number(job.directRecord.messageTimestamp))
      || Number(job.directRecord.messageTimestamp) <= Math.floor(Date.parse(scope.enabledSince) / 1000)
      || job.authenticatedOwnerChat !== scope.ownerId || job.ownerChat !== scope.destination || job.chat.sendTo !== scope.destination
      || key.id !== job.id || !validId(job.id) || typeof job.trigger.request !== 'string' || !job.trigger.request.trim()
      || Buffer.byteLength(job.trigger.request) > 32768) throw new Error('managerRefused');
    return { schemaVersion: 1, source: 'whatsapp', account: scope.account.name, actorId: scope.actorId, messageId: job.id,
      conversationId: managerConversationId(scope.account.name, scope.actorId), body: job.trigger.request };
  }
  const owner = managerUserJid(job.authenticatedOwnerChat);
  const account = cfg.accounts.find(a => a.name === job.account?.name && a.instance === job.account?.instance);
  if (!managerTrigger(cfg, job.triggerName) || job.backend !== 'manager' || key?.fromMe !== true
    || !job.chat?.isOwnerChat || job.chat.isGroup || !USER_JID.test(key.remoteJid)
    || !owner || managerUserJid(job.ownerChat) !== owner || managerUserJid(job.chat.sendTo) !== owner
    || ![owner, ...(job.ownerJids || [])].some(j => managerUserJid(j) === managerUserJid(key.remoteJid))
    || !account || (account.ownerChat && managerUserJid(account.ownerChat) !== owner)
    || key.id !== job.id || typeof job.id !== 'string' || !job.id
    || typeof job.trigger.request !== 'string' || !job.trigger.request.trim()
    || Buffer.byteLength(job.trigger.request) > 32 * 1024) throw new Error('managerRefused');
  const scope = createHash('sha256').update(JSON.stringify([job.account.name, owner])).digest('hex');
  const conversationId = job.resumeConversationId || `whatsapp:${scope}`;
  if (!ID.test(conversationId)) throw new Error('managerRefused');
  return { schemaVersion: 1, source: 'whatsapp', account: job.account.name, actorId: owner,
    messageId: job.id, conversationId, body: job.trigger.request };
}

// Only fixed runtime settings reach the adapter. Provider keys, OAuth tokens,
// NODE_OPTIONS, WCT_CONFIG and shell startup hooks stay in the watcher.
export function managerEnv() {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8' };
}

export async function runOperationsManager(cfg, job, jobDir) {
  let envelope;
  try { envelope = managerEnvelope(cfg, job); } catch { return { ok: false, error: t(cfg.language, 'managerRefused') }; }
  const response = await invokeManager(cfg, 'request', envelope, data =>
    exactObject(data, ['ok', 'reply', 'conversationId', 'taskIds']) && data.ok === true
      && reply(data.reply) && validId(data.conversationId) && taskIds(data.taskIds));
  if (!response.ok) return response;
  try {
    writeJsonAtomic(path.join(jobDir, 'manager.json'), response);
    return { ok: true, result: response.reply.trim(), conversationId: response.conversationId, taskIds: response.taskIds };
  } catch { return { ok: false, error: t(cfg.language, 'managerFailed') }; }
}

export async function runManagerDeliveries(cfg, envelope) {
  if (!validControlEnvelope(cfg, envelope)) return { ok: false, error: t(cfg.language, 'managerRefused') };
  return invokeManager(cfg, 'deliveries', envelope, data => exactObject(data, ['ok', 'deliveries']) && data.ok === true
    && Array.isArray(data.deliveries) && data.deliveries.length <= 100
    && data.deliveries.every(d => managerDeliveryValid(d) && d.conversationId === envelope.conversationId)
    && new Set(data.deliveries.map(d => d.id)).size === data.deliveries.length
    && new Set(data.deliveries.map(d => d.token)).size === data.deliveries.length);
}

export async function runManagerDeliveryAck(cfg, envelope) {
  if (!validControlEnvelope(cfg, envelope, ['id', 'token', 'providerMessageId'])
    || typeof envelope.id !== 'string' || !DELIVERY_ID.test(envelope.id)
    || typeof envelope.token !== 'string' || !TOKEN.test(envelope.token) || !validId(envelope.providerMessageId)) {
    return { ok: false, error: t(cfg.language, 'managerRefused') };
  }
  return invokeManager(cfg, 'delivery-ack', envelope, data => exactObject(data, ['ok']) && data.ok === true);
}

export async function runManagerDeliveryHealth(cfg, envelope) {
  if (!validControlEnvelope(cfg, envelope)) return { ok: false, error: t(cfg.language, 'managerRefused') };
  return invokeManager(cfg, 'delivery-health', envelope, data => exactObject(data, ['ok', 'unknownDeliveries'])
    && data.ok === true && Number.isSafeInteger(data.unknownDeliveries) && data.unknownDeliveries >= 0);
}

async function invokeManager(cfg, subcommand, envelope, validate) {
  const fail = key => ({ ok: false, error: t(cfg.language, key) });
  if (process.platform === 'win32') return fail('managerFailed');
  try {
    const cwd = path.join(cfg.stateDir, 'manager-workdir');
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    return await new Promise(resolve => {
      let child, timer, cleanupTimer, settled = false, failure = '', bytes = 0;
      const chunks = [];
      const signalGroup = signal => {
        if (child?.pid) { try { process.kill(-child.pid, signal); } catch { /* group already exited */ } }
      };
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(cleanupTimer);
        signalGroup('SIGKILL');
        child?.stdin.destroy();
        child?.stdout.destroy();
        resolve(value);
      };
      const stop = key => {
        if (settled) return;
        failure ||= key;
        signalGroup('SIGTERM');
        cleanupTimer ||= setTimeout(() => finish(fail(failure)), 250);
      };
      const result = code => {
        if (failure) return fail(failure);
        if (code !== 0) return fail('managerFailed');
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          return validate(data) ? data : fail('managerOutputInvalid');
        } catch { return fail('managerOutputInvalid'); }
      };
      try {
        child = spawn(cfg.manager.command, [...cfg.manager.args, subcommand], {
          cwd, env: managerEnv(), shell: false, detached: true, stdio: ['pipe', 'pipe', 'ignore'],
        });
        child.stdin.on('error', () => stop('managerFailed'));
        child.stdout.on('data', chunk => {
          if (settled || failure) return;
          bytes += chunk.length;
          if (bytes > MAX_OUTPUT) { stop('managerOutputInvalid'); return; }
          chunks.push(chunk);
        });
        child.on('error', () => finish(fail('managerFailed')));
        child.on('exit', code => {
          if (settled) return;
          // A child can exit while descendants hold stdout open. Bound that wait too.
          signalGroup('SIGTERM');
          cleanupTimer ||= setTimeout(() => finish(result(code)), 250);
        });
        child.on('close', code => { if (!settled) finish(result(code)); });
        timer = setTimeout(() => stop('managerTimedOut'), cfg.manager.timeoutMs);
        child.stdin.end(JSON.stringify(envelope));
      } catch { finish(fail('managerFailed')); }
    });
  } catch { return fail('managerFailed'); }
}
