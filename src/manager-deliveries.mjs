import { managerControlEnvelope, runManagerDeliveries, runManagerDeliveryAck, runManagerDeliveryHealth } from './manager.mjs';
import { canonicalTriggerName, defuseTrigger } from './trigger.mjs';

const POLL_MS = 30_000;
const commands = { deliveries: runManagerDeliveries, ack: runManagerDeliveryAck, health: runManagerDeliveryHealth };

async function identityMatches(w, scope) {
  return w.cfg.manager?.deliveries === true && await w.managerIdentityMatches(scope) && w.cfg.manager?.deliveries === true;
}

function sourceRequest(w, scope, delivery) {
  const request = w.managerDeliveryStore.request(scope, delivery.sourceMessageId);
  return request?.conversationIds.includes(delivery.conversationId) ? request : null;
}

function linkDelivered(w, record, request) {
  if (!w.store.sentIds().has(record.providerMessageId)) w.store.recordSent(record.providerMessageId);
  w.store.linkThread(record.providerMessageId, {
    backend: 'manager', jobId: record.delivery.sourceMessageId,
    triggerName: canonicalTriggerName(request.triggerName, w.cfg.manager.triggers) || w.cfg.manager.triggers[0],
    actorId: record.scope.actorId, conversationId: record.delivery.conversationId,
    taskIds: record.delivery.taskIds, managerScope: record.scope,
  }, { durable: true });
}

async function acknowledge(w, record) {
  const request = sourceRequest(w, record.scope, record.delivery);
  if (!request) return;
  // Rebuild local loop prevention and reply routing after a crash immediately
  // following the provider-id write. Recovery never calls sendText again.
  linkDelivered(w, record, request);
  if (!await identityMatches(w, record.scope)) return;
  const envelope = managerControlEnvelope(w.cfg, record.scope, record.delivery.conversationId);
  const result = await (w.managerCommands || commands).ack(w.cfg, { ...envelope,
    id: record.delivery.id, token: record.delivery.token, providerMessageId: record.providerMessageId });
  if (result.ok) w.managerDeliveryStore.acked(record);
  else w.log('warn', { account: w.account.name, event: 'manager-delivery-ack-pending', delivery: record.delivery.id });
}

export async function managerDeliveryHealth(cfg, store, scope, verifyIdentity, healthCommand = commands.health) {
  const local = store.health();
  let remoteUnknown = 0;
  let available = true;
  try {
    if (!await verifyIdentity(scope)) throw new Error('manager identity unverified');
    for (const conversationId of store.conversations(scope)) {
      if (!await verifyIdentity(scope)) { available = false; break; }
      const result = await healthCommand(cfg, managerControlEnvelope(cfg, scope, conversationId));
      if (!result.ok) { available = false; break; }
      remoteUnknown += result.unknownDeliveries;
    }
  } catch { available = false; }
  return { ...local, remoteUnknown, available,
    ok: available && local.localUnknown === 0 && local.pendingAcks === 0 && local.corrupt === 0 && remoteUnknown === 0 };
}

async function poll(w) {
  const scope = w.managerScope();
  if (!await identityMatches(w, scope)) return;
  const store = w.managerDeliveryStore;
  const invoke = w.managerCommands || commands;
  for (const record of store.pendingAcks(scope)) await acknowledge(w, record);
  for (const conversationId of store.conversations(scope)) {
    if (!await identityMatches(w, scope)) break;
    const result = await invoke.deliveries(w.cfg, managerControlEnvelope(w.cfg, scope, conversationId));
    if (!result.ok) {
      w.log('warn', { account: w.account.name, event: 'manager-deliveries-failed' });
      continue;
    }
    // All reservations reach disk before any send. Only entries created during
    // this call are eligible to send. Existing reserved entries stay unknown.
    const fresh = result.deliveries.map(delivery => store.reserve(scope, delivery)).filter(Boolean);
    for (const record of fresh) {
      const request = sourceRequest(w, scope, record.delivery);
      if (!request || !await identityMatches(w, scope)) {
        w.log('warn', { account: w.account.name, event: 'manager-delivery-scope-refused', delivery: record.delivery.id });
        continue;
      }
      try {
        const key = await w.client.sendText(scope.account.instance, scope.destination, defuseTrigger(record.delivery.body));
        const sent = store.sent(record, key?.id);
        await acknowledge(w, sent);
      } catch {
        // A thrown provider call, missing id, or interrupted persistence cannot
        // prove that no message was sent. Leave the journal for reconciliation.
        w.log('warn', { account: w.account.name, event: 'manager-delivery-unresolved', delivery: record.delivery.id });
      }
    }
  }
  const health = await managerDeliveryHealth(w.cfg, store, scope, s => identityMatches(w, s), invoke.health);
  w.log(health.ok ? 'info' : 'warn', { account: w.account.name, event: 'manager-delivery-health', ...health });
}

export function pollManagerDeliveries(w) {
  if (w.managerDeliveryPolling) return w.managerDeliveryPolling;
  if (w.cfg.manager?.enabled !== true || w.cfg.manager.deliveries !== true
    || (w.nextManagerDeliveryPoll !== undefined && w.now() < w.nextManagerDeliveryPoll)) return Promise.resolve();
  w.nextManagerDeliveryPoll = w.now() + POLL_MS;
  w.managerDeliveryPolling = poll(w).catch(() => {
    w.log('error', { account: w.account.name, event: 'manager-delivery-state-failed' });
  }).finally(() => { w.managerDeliveryPolling = null; });
  return w.managerDeliveryPolling;
}
