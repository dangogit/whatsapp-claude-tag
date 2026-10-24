// jid -> display name for one account, with an on-disk group cache.

import fs from 'node:fs';
import path from 'node:path';
import { isGroupJid, userPart } from './text.mjs';

const GROUP_TTL_MS = 6 * 3600 * 1000;

export async function loadGroups(client, instance, cacheDir, { refresh = false } = {}) {
  const file = path.join(cacheDir, `groups-${instance}.json`);
  if (!refresh) {
    try {
      if (Date.now() - fs.statSync(file).mtimeMs < GROUP_TTL_MS) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* no usable cache */ }
  }
  try {
    const groups = await client.fetchGroups(instance);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(groups));
    return groups;
  } catch (err) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw err; }
  }
}

// Groups win over contacts: Evolution also keeps a contact row per group JID
// carrying some member's pushName, which would otherwise label the group.
export async function buildDirectory(client, instance, cacheDir) {
  const names = new Map();
  for (const g of await loadGroups(client, instance, cacheDir)) names.set(g.id, g.subject || g.id);
  for (const c of await client.findContacts(instance)) {
    const jid = c.remoteJid || c.id;
    if (!jid || names.has(jid)) continue;
    const name = (c.pushName || c.name || '').trim();
    if (name && !/^\d+$/.test(name)) names.set(jid, name);
  }
  return names;
}

export function searchDirectory(names, query, max = 12) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const all = [...names.entries()].map(([jid, name]) => ({ jid, name, group: isGroupJid(jid) }));
  const exact = all.filter(c => c.name.toLowerCase() === q);
  if (exact.length) return exact.slice(0, max);
  const digits = q.replace(/\D/g, '');
  return all
    .filter(c => c.name.toLowerCase().includes(q) || (digits.length >= 7 && userPart(c.jid).endsWith(digits.slice(-9))))
    .slice(0, max);
}

// Who wrote a record. Group authors arrive as LIDs and pushName is often numeric.
export function senderName(rec, names) {
  const key = rec?.key || {};
  if (key.fromMe) return 'me';
  const participant = key.participant || key.participantAlt || '';
  const fromDir = participant && names.get(participant);
  if (fromDir) return fromDir;
  const push = String(rec?.pushName || '').trim();
  if (push && !/^\d+$/.test(push)) return push;
  if (participant) return `+${userPart(participant).slice(-6)}`;
  return names.get(key.remoteJid) || 'them';
}
