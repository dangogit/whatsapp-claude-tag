// Google Calendar tools, plus an address lookup in Gmail, for whatsapp-claude-tag runs.
//
// Credentials: an OAuth "authorized_user" JSON file (client_id, client_secret, refresh_token)
// with the calendar scope, and gmail.readonly for find_email. Only these calls are made:
// calendar events list and insert, and Gmail message search and header reads. Nothing here
// sends, changes or deletes mail, even if the token's scopes would allow it.
//
// Inviting someone is an outward action, so attendees go through the same rule as WhatsApp
// recipients: an address the owner wrote, an address the owner said "yes" to, or the single
// address the owner has sent mail to under a name the owner wrote.

import fs from 'node:fs';
import path from 'node:path';
import { authorizedText, namedIn } from '../../src/policy.mjs';
import { appendAction } from '../../src/store.mjs';

const CAL = 'https://www.googleapis.com/calendar/v3';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

// Offset of `tz` from UTC at a given instant, in ms.
function tzOffset(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
}

// "2026-10-25T17:00" in `tz` -> epoch ms.
export function localToMs(local, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!m) throw new Error(`"${local}" is not a local time like 2026-10-25T17:00`);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const first = guess - tzOffset(guess, tz);
  return guess - tzOffset(first, tz);
}

// epoch ms -> "2026-10-25T17:00" in `tz`.
export function msToLocal(ms, tz) {
  return new Date(ms).toLocaleString('sv-SE', { timeZone: tz }).slice(0, 16).replace(' ', 'T');
}

export function parseAddresses(header) {
  const out = [];
  for (const part of String(header || '').split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const email = (part.match(EMAIL_RE) || [])[0];
    if (!email) continue;
    const name = part.replace(/<[^>]*>/, '').replace(email, '').replace(/["']/g, '').trim();
    out.push({ email: email.toLowerCase(), name });
  }
  return out;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// deps: { tokenFile, calendarId, job, jobDir, fetchImpl, now }
export function createGoogleTools(deps) {
  const { tokenFile, job, jobDir } = deps;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const now = deps.now || Date.now;
  const calendarId = deps.calendarId || 'primary';
  const tz = job.timezone || 'UTC';
  const foundFile = path.join(jobDir, 'emails.json');
  let access = null;

  async function token() {
    if (access && access.exp > now() + 60_000) return access.value;
    const cred = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    const res = await fetchImpl(cred.token_uri || 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cred.client_id, client_secret: cred.client_secret, refresh_token: cred.refresh_token, grant_type: 'refresh_token' }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new Error(`Google sign-in failed (HTTP ${res.status}): ${data.error || 'no token'}`);
    access = { value: data.access_token, exp: now() + (data.expires_in || 3000) * 1000 };
    return access.value;
  }

  async function api(method, url, body) {
    const res = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${await token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google API ${res.status}: ${data?.error?.message || 'request failed'}`);
    return data;
  }

  // An address is allowed when the owner wrote it, said "yes" to it, or when find_email
  // found exactly one person for a lookup whose every word the owner wrote. The display
  // name in a mail header is chosen by its sender, so it never counts on its own.
  function attendeeAllowed(email) {
    const text = authorizedText(job);
    if ((text.toLowerCase().match(EMAIL_RE) || []).includes(email)) return true;
    const hit = readJson(foundFile, {})[email];
    if (!hit || !hit.unique) return false;
    const words = String(hit.query).split(/\s+/).filter(Boolean);
    return words.length > 0 && words.every(w => namedIn(w, text));
  }

  function eventLine(e) {
    const s = e.start?.dateTime ? msToLocal(Date.parse(e.start.dateTime), tz) : `${e.start?.date} (all day)`;
    const end = e.end?.dateTime ? msToLocal(Date.parse(e.end.dateTime), tz).slice(11) : '';
    const who = (e.attendees || []).map(a => a.email).join(', ');
    return `${s}${end ? `-${end}` : ''}  ${e.summary || '(no title)'}${who ? `  [${who}]` : ''}`;
  }

  return [
    {
      name: 'calendar_list_events',
      description: `List the owner's calendar events in a time range (local times in ${tz}, like 2026-10-25T09:00). Default: from now to the end of tomorrow.`,
      inputSchema: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' } },
      },
      async handler({ from, to } = {}) {
        const t0 = from ? localToMs(from, tz) : now();
        const day = msToLocal(now(), tz).slice(0, 10);
        const t1 = to ? localToMs(to, tz) : localToMs(`${day}T23:59`, tz) + 86_400_000;
        const q = new URLSearchParams({ timeMin: new Date(t0).toISOString(), timeMax: new Date(t1).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '50' });
        const data = await api('GET', `${CAL}/calendars/${encodeURIComponent(calendarId)}/events?${q}`);
        const items = data.items || [];
        return items.length ? items.map(eventLine).join('\n') : 'No events in that range.';
      },
    },
    {
      name: 'calendar_create_event',
      description: `Create an event in the owner's calendar. Times are local (${tz}), like 2026-10-25T17:00. Attendees get an email invitation; only addresses the owner wrote, confirmed, or that find_email returned for a name the owner wrote are accepted.`,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          start: { type: 'string', description: 'Local start time, 2026-10-25T17:00' },
          duration_minutes: { type: 'number', description: 'Default 30' },
          attendees: { type: 'array', items: { type: 'string' }, description: 'Email addresses to invite' },
          description: { type: 'string' },
          location: { type: 'string' },
          video_call: { type: 'boolean', description: 'Add a Google Meet link' },
        },
        required: ['title', 'start'],
      },
      async handler({ title, start, duration_minutes = 30, attendees = [], description, location, video_call = false }) {
        if (!String(title || '').trim()) throw new Error('title is required');
        if (!LOCAL_RE.test(String(start || ''))) throw new Error('start must be a local time like 2026-10-25T17:00');
        const minutes = Math.min(Math.max(Math.round(Number(duration_minutes) || 30), 5), 24 * 60);
        const emails = [...new Set((attendees || []).map(a => String(a).trim().toLowerCase()).filter(Boolean))];
        const bad = emails.filter(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
        if (bad.length) throw new Error(`not an email address: ${bad.join(', ')}`);
        const refused = emails.filter(e => !attendeeAllowed(e));
        if (refused.length) {
          throw new Error(`refused: ${refused.join(', ')} - the owner did not write or confirm this address. Ask the owner in chat "owner" to confirm it, then create the event.`);
        }
        const startMs = localToMs(start, tz);
        const body = {
          summary: String(title).trim(),
          start: { dateTime: `${msToLocal(startMs, tz)}:00`, timeZone: tz },
          end: { dateTime: `${msToLocal(startMs + minutes * 60_000, tz)}:00`, timeZone: tz },
          ...(description ? { description: String(description) } : {}),
          ...(location ? { location: String(location) } : {}),
          ...(emails.length ? { attendees: emails.map(email => ({ email })) } : {}),
          ...(video_call ? { conferenceData: { createRequest: { requestId: `wct-${job.id}-${startMs}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}),
        };
        const q = new URLSearchParams({ sendUpdates: emails.length ? 'all' : 'none', ...(video_call ? { conferenceDataVersion: '1' } : {}) });
        const ev = await api('POST', `${CAL}/calendars/${encodeURIComponent(calendarId)}/events?${q}`, body);
        appendAction(jobDir, { type: 'calendar-event', id: ev.id || '', attendees: emails.length });
        const meet = ev.hangoutLink ? `\nMeet: ${ev.hangoutLink}` : '';
        return `created: ${eventLine(ev)}${emails.length ? `\ninvitations sent to ${emails.join(', ')}` : ''}${meet}\n${ev.htmlLink || ''}`;
      },
    },
    {
      name: 'find_email',
      description: 'Find email addresses for a person by name, among people the owner has sent mail to. Use the name as the owner wrote it; a single match for that name can be invited.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      async handler({ name }) {
        const query = String(name || '').trim();
        // A plain name only: no Gmail operators (from:, OR, -, quotes, braces) that could pull in other people.
        if (!/^[\p{L}][\p{L}'. ]{1,40}$/u.test(query) || /\b(or|and)\b/i.test(query) || query.split(' ').filter(Boolean).length > 3) {
          throw new Error('name must be a plain person name, up to three words');
        }
        const qTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
        // Only mail the owner sent: a stranger can mail the owner under any display name,
        // but the owner chose every address in their own To and Cc lines.
        const list = await api('GET', `${GMAIL}/messages?${new URLSearchParams({ q: `in:sent ${qTokens.map(tk => `"${tk}"`).join(' ')}`, maxResults: '50' })}`);
        const counts = new Map();
        // every word of the query must be a whole word of the display name or of the address' local part
        const matches = a => {
          const words = new Set([...a.name.toLowerCase().split(/[^\p{L}\p{N}]+/u), ...a.email.split('@')[0].split(/[._+-]+/)].filter(Boolean));
          return qTokens.every(tk => words.has(tk));
        };
        for (const m of (list.messages || []).slice(0, 50)) {
          const msg = await api('GET', `${GMAIL}/messages/${m.id}?${new URLSearchParams([['format', 'metadata'], ['metadataHeaders', 'To'], ['metadataHeaders', 'Cc']])}`);
          for (const h of msg.payload?.headers || []) {
            if (!/^(to|cc)$/i.test(h.name)) continue;
            for (const a of parseAddresses(h.value)) {
              if (!matches(a)) continue;
              const c = counts.get(a.email) || { email: a.email, name: a.name, n: 0 };
              c.n += 1; if (!c.name && a.name) c.name = a.name;
              counts.set(a.email, c);
            }
          }
        }
        const hits = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 5);
        if (!hits.length) return `No address found for "${query}". Ask the owner for it.`;
        const found = readJson(foundFile, {});
        for (const h of hits) found[h.email] = { query, name: h.name, unique: hits.length === 1 };
        fs.writeFileSync(foundFile, JSON.stringify(found, null, 2), { mode: 0o600 });
        return hits.map(h => `${h.name || '(no name)'} <${h.email}>  seen ${h.n}x`).join('\n')
          + (hits.length > 1 ? '\nSeveral matches: ask the owner which one before inviting.' : '');
      },
    },
  ];
}
