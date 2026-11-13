// Import provider-observed conversation context. These rows are never commands or
// evidence that the manager performed an action.
import { managerControlEnvelope, runManagerConversationSync, managerUserJid } from './manager.mjs';
import { messageText, quotedId, timestampOf } from './text.mjs';
import { mediaKind } from './media.mjs';
import { managerMediaIdentity } from './manager-media.mjs';

const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const DATABASE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PAGE_SIZE = 100;
const MAX_PAGES = 1000;
const HISTORICAL_DUPLICATE_SKEW_MS = 2000;

function sameContent(left, right) {
  return left.id === right.id && left.role === right.role && left.body === right.body && left.quotedId === right.quotedId;
}

export function managerBody(rec) {
  const text = messageText(rec);
  const kind = mediaKind(rec);
  const types = Object.keys(rec?.message || {});
  const ignored = types.length > 0 && types.every(type => ['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'messageContextInfo'].includes(type));
  const unsupported = !text || Boolean(kind && /^\[(?:image|video|audio|document|sticker)\]$/.test(text));
  return { body: unsupported ? `[WhatsApp ${ignored ? 'protocol or reaction event' : kind || 'unsupported message'}; content not read]` : text, unsupported, ignored };
}

export function managerEntry(rec) {
  const id = rec?.key?.id;
  const ts = timestampOf(rec);
  const body = managerBody(rec).body;
  const quote = quotedId(rec);
  if (!ENTRY_ID.test(id) || !Number.isFinite(ts) || ts <= 0 || !['boolean'].includes(typeof rec.key.fromMe)
    || (quote && !ENTRY_ID.test(quote)) || Buffer.byteLength(body) > 32768) throw new Error('invalid manager history record');
  return { id, role: rec.key.fromMe ? 'assistant' : 'user', body, at: new Date(ts * 1000).toISOString(), ...(quote ? { quotedId: quote } : {}) };
}

export function peerKeyMatches(key, actorId, aliases = []) {
  if (!key || key.participant || key.participantAlt || typeof key.fromMe !== 'boolean') return false;
  const remote = managerUserJid(key.remoteJid);
  const alt = key.remoteJidAlt ? managerUserJid(key.remoteJidAlt) : '';
  if (!remote || (key.remoteJidAlt && !alt)) return false;
  const allowed = [actorId, ...aliases];
  // The provider's alternate phone identity proves a LID binding. Conflicting
  // phone or LID identifiers are refused even when one side happens to match.
  if (remote === actorId) return !alt || alt === actorId || alt.endsWith('@lid');
  if (remote.endsWith('@lid') && alt === actorId) return true;
  return allowed.includes(remote) && (!alt || allowed.includes(alt));
}

export async function readManagerHistory(client, instance, scope, aliases, current, selectedRecords) {
  if (typeof client.findMessagePage !== 'function') throw new Error('complete manager history unavailable');
  const streams = [];
  const seen = new Map();
  const originals = new Map();
  const observations = new Map(), databaseRows = new Map();
  const activation = Date.parse(scope.enabledSince);
  for (const jid of [...new Set([scope.actorId, ...aliases])]) {
    let expectedTotal, expectedPages;
    const rows = [];
    const streamDatabaseIds = new Set(), streamMessageIds = new Set();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await client.findMessagePage(instance, { key: { remoteJid: jid, ...(jid === scope.actorId ? { remoteJidAlt: scope.actorId } : {}) } }, PAGE_SIZE, page);
      const { records, total, pages, currentPage } = result || {};
      if (!Array.isArray(records) || !Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(pages) || pages < 0
        || currentPage !== page || pages !== Math.ceil(total / PAGE_SIZE)
        || (expectedTotal !== undefined && (total !== expectedTotal || pages !== expectedPages))
        || records.length !== Math.min(PAGE_SIZE, Math.max(0, total - (page - 1) * PAGE_SIZE))) {
        throw new Error('incomplete manager history pagination');
      }
      expectedTotal = total; expectedPages = pages;
      for (const rec of records) {
        if (!peerKeyMatches(rec?.key, scope.actorId, aliases)
          || ![managerUserJid(rec.key.remoteJid), managerUserJid(rec.key.remoteJidAlt)].includes(jid)) {
          throw new Error('manager history crossed chat scope');
        }
        const entry = managerEntry(rec);
        if (originals.has(entry.id) && managerMediaIdentity(originals.get(entry.id)) !== managerMediaIdentity(rec)) throw new Error('conflicting manager history media');
        if (!originals.has(entry.id)) originals.set(entry.id, rec);
        const databaseId = typeof rec.id === 'string' && DATABASE_ID.test(rec.id) ? rec.id : null;
        if (databaseId && streamDatabaseIds.has(databaseId)) throw new Error('duplicate manager history page record');
        const databaseEntry = databaseId && databaseRows.get(databaseId);
        if (databaseEntry && JSON.stringify(databaseEntry) !== JSON.stringify(entry)) throw new Error('conflicting manager history database row');
        const prior = seen.get(entry.id);
        const observation = observations.get(entry.id);
        if (streamMessageIds.has(entry.id) && (!databaseId || observation.missingDatabaseId)) throw new Error('duplicate manager history page record');
        if (prior && JSON.stringify(prior) !== JSON.stringify(entry) && !databaseEntry) {
          const at = Date.parse(entry.at), firstAt = Math.min(observation.firstAt, at), lastAt = Math.max(observation.lastAt, at);
          // Evolution can store two historical copies with identical content but
          // slightly different timestamps. Reconcile only separately identified
          // database rows before activation, never a changed or current request.
          if (!databaseId || observation.missingDatabaseId || observation.databaseIds.has(databaseId)
            || !sameContent(prior, entry) || !Number.isFinite(activation) || lastAt >= activation
            || lastAt - firstAt > HISTORICAL_DUPLICATE_SKEW_MS) throw new Error('conflicting manager history id');
          seen.set(entry.id, { ...prior, at: new Date(firstAt).toISOString() });
          observation.firstAt = firstAt; observation.lastAt = lastAt;
        } else if (!prior) {
          seen.set(entry.id, entry);
          observations.set(entry.id, { firstAt: Date.parse(entry.at), lastAt: Date.parse(entry.at), databaseIds: new Set(), missingDatabaseId: false });
        }
        const provenance = observations.get(entry.id);
        if (databaseId) {
          streamDatabaseIds.add(databaseId); provenance.databaseIds.add(databaseId); databaseRows.set(databaseId, entry);
        } else provenance.missingDatabaseId = true;
        streamMessageIds.add(entry.id);
        if (rows.length && timestampOf(rows.at(-1)) < timestampOf(rec)) throw new Error('unordered manager history');
        rows.push(rec);
      }
      if (page >= pages) break;
      if (page === MAX_PAGES) throw new Error('manager history page limit exceeded');
    }
    streams.push(rows);
  }
  const currentEntry = managerEntry(current);
  if (JSON.stringify(seen.get(currentEntry.id)) !== JSON.stringify(currentEntry)) throw new Error('current message missing from manager history');
  if (managerMediaIdentity(originals.get(currentEntry.id)) !== managerMediaIdentity(current)) throw new Error('current manager media changed');
  const cutoff = timestampOf(current);
  const before = new Map(), after = new Map();
  for (const id of seen.keys()) { before.set(id, new Set()); after.set(id, new Set()); }
  for (const stream of streams) {
    // Keep only observations at the canonical timestamp. This preserves actual
    // provider order around the earlier copy instead of moving a later copy.
    const rows = stream.filter(row => seen.get(row.key.id).at === managerEntry(row).at);
    for (let i = 1; i < rows.length; i++) {
      const newer = rows[i - 1], older = rows[i];
      if (newer.key.id === older.key.id || timestampOf(newer) !== timestampOf(older)) continue;
      before.get(newer.key.id).add(older.key.id);
      after.get(older.key.id).add(newer.key.id);
    }
  }
  const reachable = (edges, start) => {
    const found = new Set(), queue = [start];
    while (queue.length) for (const id of edges.get(queue.pop()) || []) if (!found.has(id)) { found.add(id); queue.push(id); }
    return found;
  };
  const earlier = reachable(before, currentEntry.id), later = reachable(after, currentEntry.id);
  const accepted = new Map();
  for (const [id, entry] of seen) {
    const ts = Date.parse(entry.at) / 1000;
    if (ts > cutoff || (ts === cutoff && later.has(id))) continue;
    if (ts === cutoff && id !== currentEntry.id && !earlier.has(id)) throw new Error('ambiguous history boundary across aliases');
    accepted.set(id, entry);
  }
  // Merge the provider-observed orders. A graph links records shared by the PN
  // and LID queries without inventing chronology from lexical provider ids.
  const order = new Map(), pending = new Map([...before].map(([id, ids]) => [id, ids.size]));
  const ready = [...pending].filter(([, count]) => !count).map(([id]) => id);
  while (ready.length) {
    const id = ready.pop(); order.set(id, order.size);
    for (const next of after.get(id)) { pending.set(next, pending.get(next) - 1); if (!pending.get(next)) ready.push(next); }
  }
  if (order.size !== seen.size) throw new Error('inconsistent provider history order');
  const entries = [...accepted.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || order.get(a.id) - order.get(b.id));
  if (entries.at(-1)?.id !== currentEntry.id) throw new Error('unproven history boundary');
  // Only the explicitly current/quoted records are eligible for preparation.
  // Old history is never downloaded or transcribed as a side effect of import.
  if (selectedRecords) await selectedRecords([current, ...(accepted.has(quotedId(current)) && quotedId(current) !== currentEntry.id
    ? [originals.get(quotedId(current))] : [])]);
  return entries;
}

export async function syncManagerHistory(cfg, scope, conversationId, throughId, entries, invoke = runManagerConversationSync) {
  const base = { ...managerControlEnvelope(cfg, scope, conversationId), throughId };
  const batches = [];
  let batch = [];
  for (const entry of entries) {
    const next = [...batch, entry];
    if (next.length > 100 || Buffer.byteLength(JSON.stringify({ ...base, entries: next, complete: false })) > 65536) {
      if (!batch.length) throw new Error('manager history entry exceeds envelope');
      batches.push(batch); batch = [];
    }
    batch.push(entry);
  }
  if (batch.length) batches.push(batch);
  if (!batches.length || entries.at(-1)?.id !== throughId) throw new Error('manager history has no current entry');
  for (let i = 0; i < batches.length; i++) {
    const result = await invoke(cfg, { ...base, entries: batches[i], complete: i === batches.length - 1 });
    if (!result.ok) throw new Error('manager history sync failed');
  }
}
