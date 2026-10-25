import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createGoogleTools, localToMs, msToLocal, parseAddresses } from '../extensions/google/google.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { namedIn } from '../src/policy.mjs';
import { claudeArgs, systemPrompt } from '../src/runner.mjs';
import { readActions } from '../src/store.mjs';
import { tmpDir } from './helpers.mjs';

const TZ = 'Asia/Jerusalem';
const NOW = Date.UTC(2026, 9, 25, 7, 0);

function fakeGoogle({ messages = {}, events = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const u = new URL(url);
    const ok = body => ({ ok: true, status: 200, json: async () => body });
    if (u.hostname === 'oauth2.googleapis.com') return ok({ access_token: 'AT', expires_in: 3600 });
    if (u.pathname.endsWith('/events') && opts.method === 'POST') {
      const b = JSON.parse(opts.body);
      return ok({ id: 'ev1', summary: b.summary, start: { dateTime: `${b.start.dateTime}+02:00` }, end: { dateTime: `${b.end.dateTime}+02:00` }, attendees: b.attendees, htmlLink: 'https://cal/ev1' });
    }
    if (u.pathname.endsWith('/events')) return ok({ items: events });
    if (u.pathname.endsWith('/messages')) return ok({ messages: Object.keys(messages).map(id => ({ id })) });
    const id = u.pathname.split('/').pop();
    return ok({ payload: { headers: messages[id] || [] } });
  };
  return { fetchImpl, calls };
}

function setup({ request = 'תזמן לי פגישה', approved = '', earlier = '', messages, events } = {}) {
  const dir = tmpDir();
  const tokenFile = path.join(dir, 'token.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ client_id: 'c', client_secret: 's', refresh_token: 'r' }));
  const job = { id: 'J1', timezone: TZ, trigger: { request, approved, earlier } };
  const g = fakeGoogle({ messages, events });
  const tools = Object.fromEntries(createGoogleTools({ tokenFile, job, jobDir: dir, fetchImpl: g.fetchImpl, now: () => NOW }).map(t => [t.name, t.handler]));
  return { tools, calls: g.calls, dir };
}

test('local time conversion follows the timezone, including the DST change', () => {
  for (const local of ['2026-10-25T17:00', '2026-07-01T09:30', '2026-03-27T02:30']) {
    assert.equal(msToLocal(localToMs(local, TZ), TZ), local === '2026-03-27T02:30' ? '2026-03-27T03:30' : local);
  }
  assert.equal(new Date(localToMs('2026-07-01T09:30', TZ)).toISOString(), '2026-07-01T06:30:00.000Z');
  assert.throws(() => localToMs('tomorrow at five', TZ), /not a local time/);
});

test('address headers parse with and without display names', () => {
  assert.deepEqual(parseAddresses('"Cohen, Ben" <Ben@Example.com>, dana@x.io'), [
    { email: 'ben@example.com', name: 'Cohen, Ben' }, { email: 'dana@x.io', name: '' },
  ]);
});

test('an event without attendees is created on the owner calendar, no invitations', async () => {
  const { tools, calls, dir } = setup();
  const out = await tools.calendar_create_event({ title: 'בדיקה', start: '2026-10-25T17:00', duration_minutes: 10 });
  assert.match(out, /created: 2026-10-25T17:00-17:10  בדיקה/);
  const post = calls.find(c => c.opts.method === 'POST' && c.url.includes('/events'));
  const body = JSON.parse(post.opts.body);
  assert.deepEqual(body.start, { dateTime: '2026-10-25T17:00:00', timeZone: TZ });
  assert.deepEqual(body.end, { dateTime: '2026-10-25T17:10:00', timeZone: TZ });
  assert.equal(new URL(post.url).searchParams.get('sendUpdates'), 'none');
  assert.equal(post.opts.headers.authorization, 'Bearer AT');
  assert.deepEqual(readActions(dir).map(a => a.type), ['calendar-event']);
});

test('attendees: refused unless the owner wrote, confirmed or named them', async () => {
  const s1 = setup({ request: 'שלח לבן זימון לפגישה היום ב17' });
  await assert.rejects(s1.tools.calendar_create_event({ title: 'x', start: '2026-10-25T17:00', attendees: ['evil@x.com'] }), /refused: evil@x.com/);

  const s2 = setup({ request: 'invite ben@example.com at 17:00' });
  assert.match(await s2.tools.calendar_create_event({ title: 'x', start: '2026-10-25T17:00', attendees: ['Ben@Example.com'] }), /invitations sent to ben@example.com/);
  const post = s2.calls.find(c => c.opts.method === 'POST' && c.url.includes('/events'));
  assert.equal(new URL(post.url).searchParams.get('sendUpdates'), 'all');

  const s3 = setup({ request: 'שלח לבן זימון', approved: 'Is it ben@example.com?' });
  assert.match(await s3.tools.calendar_create_event({ title: 'x', start: '2026-10-25T17:00', attendees: ['ben@example.com'] }), /invitations sent/);
});

test('find_email finds sent-to addresses, but only the owner\'s confirmation authorises an invite', async () => {
  const messages = {
    m1: [{ name: 'To', value: 'בן כהן <ben@example.com>' }],
    m2: [{ name: 'Cc', value: 'בן כהן <ben@example.com>, other@x.com' }],
    m3: [{ name: 'From', value: 'בן <stranger@evil.com>' }],   // inbound only: never counted
  };
  const s = setup({ request: 'שלח לבן זימון לפגישה היום ב17 ל10 דקות', messages });
  const out = await s.tools.find_email({ name: 'בן' });
  assert.match(out, /בן כהן <ben@example.com>  seen 2x/);
  assert.match(out, /confirm the address/);
  assert.doesNotMatch(out, /stranger/);
  assert.match(new URL(s.calls.find(c => c.url.includes('/messages?')).url).searchParams.get('q'), /^in:sent /);
  await assert.rejects(s.tools.calendar_create_event({ title: 'פגישה', start: '2026-10-25T17:00', attendees: ['ben@example.com'] }), /Invite ben@example.com\?/);
  const ok = setup({ request: 'כן', earlier: 'שלח לבן זימון', approved: 'ben@example.com', messages });
  assert.match(await ok.tools.calendar_create_event({ title: 'פגישה', start: '2026-10-25T17:00', attendees: ['ben@example.com'] }), /invitations sent/);
});

test('calendar_list_events prints local times and attendees', async () => {
  const s = setup({ events: [{ summary: 'Standup', start: { dateTime: '2026-10-25T09:00:00+02:00' }, end: { dateTime: '2026-10-25T09:15:00+02:00' }, attendees: [{ email: 'a@x.com' }] }] });
  assert.equal(await s.tools.calendar_list_events({}), '2026-10-25T09:00-09:15  Standup  [a@x.com]');
});

test('two-letter names count, but only as whole words', () => {
  assert.equal(namedIn('בן', 'שלח לבן זימון לפגישה'), true);
  assert.equal(namedIn('בן כהן', 'תזמן עם בן'), true);
  assert.equal(namedIn('בן', 'בנים ובנות'), false);
  assert.equal(namedIn('Of Course', 'one of them'), false);
  assert.equal(namedIn('Dan', 'send to dan please'), true);
});

test('extensions: validated, passed to claude with the job dir, and allowed', () => {
  const dir = tmpDir();
  const base = { accounts: [{ name: 'p', instance: 'p' }], stateDir: dir };
  assert.throws(() => normalizeConfig({ ...base, claude: { mcpServers: { whatsapp: { command: 'x' } } } }, { EVOLUTION_API_KEY: 'k' }), /invalid extension name/);
  assert.throws(() => normalizeConfig({ ...base, claude: { mcpServers: { g: { command: 'node', env: { A: 1 } } } } }, { EVOLUTION_API_KEY: 'k' }), /env must map/);
  const cfg = normalizeConfig({ ...base, claude: { mcpServers: { google: { command: 'node', args: ['~/x/server.mjs'], env: { GOOGLE_TOKEN_FILE: '~/t.json' } } } } }, { EVOLUTION_API_KEY: 'k' });
  const job = { id: 'J', triggerName: 'claude', account: { name: 'p' }, chat: { jid: 'x@g.us', isGroup: true, name: 'G' }, trigger: { request: 'r' }, timezone: TZ, localTime: '' };
  const args = claudeArgs(cfg, job, '/jobs/J');
  const mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
  assert.equal(mcp.mcpServers.google.command, process.execPath);
  assert.ok(!mcp.mcpServers.google.args[0].startsWith('~'));
  assert.equal(mcp.mcpServers.google.env.WCT_JOB_DIR, '/jobs/J');
  assert.ok(!mcp.mcpServers.google.env.GOOGLE_TOKEN_FILE.startsWith('~'));
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__whatsapp,mcp__google,WebSearch');
  assert.match(systemPrompt(job, ['google']), /extensions: google.*create the calendar event/s);
  assert.match(systemPrompt(job), /NOT DONE:/);
  assert.doesNotMatch(systemPrompt(job), /extensions:/);
});

test('find_email takes plain names only and matches whole words', async () => {
  const s = setup({ request: 'שלח לבן זימון' });
  for (const bad of ['בן OR from:evil@x.com', 'from:evil', 'בן -x', '"בן"', 'a b c d']) {
    await assert.rejects(s.tools.find_email({ name: bad }), /plain person name/);
  }
  const messages = {
    m1: [{ name: 'To', value: 'Ben Cohen <ben.c@example.com>' }],
    m3: [{ name: 'To', value: 'Benjamin Fox <bfox@example.com>' }],
  };
  const two = setup({ request: 'invite Ben to a meeting', messages });
  const out = await two.tools.find_email({ name: 'Ben' });
  assert.match(out, /ben.c@example.com/);
  assert.doesNotMatch(out, /bfox/);   // whole words: "Ben" is not "Benjamin"
});

test('a two-letter name takes one prefix letter only', () => {
  assert.equal(namedIn('בן', 'שלח לבן'), true);
  assert.equal(namedIn('בן', 'מהבן'), false);
});
