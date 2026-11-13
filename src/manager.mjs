// Optional trusted local adapter. Requests never become command-line arguments.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { writeJsonAtomic } from './store.mjs';
import { t } from './strings.mjs';

const MAX_OUTPUT = 64 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const USER_JID = /^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/;

export function managerUserJid(value) {
  if (typeof value !== 'string' || !value) return '';
  const jid = value.includes('@') ? value : `${value}@s.whatsapp.net`;
  return USER_JID.test(jid) ? jid.replace(/:\d+@/, '@') : '';
}

export function managerTrigger(cfg, name) {
  return cfg.manager?.enabled === true && cfg.manager.triggers.includes(String(name).replace(/^@/, '').toLowerCase());
}

export function managerEnvelope(cfg, job) {
  const key = job.trigger?.key;
  const owner = managerUserJid(job.authenticatedOwnerChat);
  const account = cfg.accounts.find(a => a.name === job.account?.name && a.instance === job.account?.instance);
  if (!managerTrigger(cfg, job.triggerName) || job.backend !== 'manager' || key?.fromMe !== true
    || !job.chat?.isOwnerChat || job.chat.isGroup || !USER_JID.test(key.remoteJid)
    || !owner || managerUserJid(job.ownerChat) !== owner
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
  const fail = key => ({ ok: false, error: t(cfg.language, key) });
  let envelope;
  try { envelope = managerEnvelope(cfg, job); } catch { return fail('managerRefused'); }
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
          if (data?.ok !== true || typeof data.reply !== 'string' || !data.reply.trim() || data.reply.length > 16_000
            || typeof data.conversationId !== 'string' || !ID.test(data.conversationId)
            || !Array.isArray(data.taskIds) || data.taskIds.length > 100
            || !data.taskIds.every(id => typeof id === 'string' && ID.test(id))) return fail('managerOutputInvalid');
          // Persist only the validated response, never stderr or malformed stdout.
          writeJsonAtomic(path.join(jobDir, 'manager.json'), {
            ok: true, reply: data.reply, conversationId: data.conversationId, taskIds: data.taskIds,
          });
          return { ok: true, result: data.reply.trim(), conversationId: data.conversationId, taskIds: data.taskIds };
        } catch { return fail('managerOutputInvalid'); }
      };
      try {
        child = spawn(cfg.manager.command, cfg.manager.args, {
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
