import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeConfig } from '../src/config.mjs';
import { managerEnvelope, runOperationsManager } from '../src/manager.mjs';
import { OWNER, tmpDir } from './helpers.mjs';

function config(manager = {}) {
  return normalizeConfig({ accounts: [{ name: 'personal', instance: 'inst' }], stateDir: tmpDir(),
    manager: { enabled: true, command: process.execPath, ...manager } }, { EVOLUTION_API_KEY: 'private-key' });
}
const JOB = {
  id: 'J1', backend: 'manager', triggerName: 'manager',
  account: { name: 'personal', instance: 'inst' }, ownerChat: OWNER, ownerJids: [OWNER],
  chat: { isOwnerChat: true, isGroup: false },
  trigger: { key: { id: 'J1', fromMe: true, remoteJid: OWNER }, request: 'בדוק את המשימה', quoted: 'untrusted' },
};
const RESPONSE = { ok: true, reply: 'קיבלתי', conversationId: 'conversation-1', taskIds: ['task-1'] };
const readInput = "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{";
function runScript(script, job = JOB, extra = {}) {
  const cfg = config({ args: ['-e', script], ...extra });
  const dir = path.join(cfg.stateDir, 'job');
  fs.mkdirSync(dir);
  return { cfg, dir, run: () => runOperationsManager(cfg, job, dir) };
}

test('manager config is opt-in, validates command and never overlaps Claude triggers', () => {
  const base = { accounts: [{ name: 'personal', instance: 'inst' }] };
  assert.equal(normalizeConfig(base, { EVOLUTION_API_KEY: 'k' }).manager.enabled, false);
  for (const manager of [true, [], { enabled: 'true' }, { enabled: true }, { command: 'node' },
    { command: '/bad\0path' }, { args: 'x' }, { args: [1] }, { args: ['\0'] }, { timeoutMs: 1 },
    { timeoutMs: 300001 }, { triggers: [] }, { triggers: ['bad name'] }, { triggers: ['@'] }]) {
    assert.throws(() => normalizeConfig({ ...base, manager }, { EVOLUTION_API_KEY: 'k' }), /config.manager/);
  }
  assert.throws(() => config({ triggers: ['@ClAuDe'] }), /overlap/);
  assert.deepEqual(config({ triggers: ['@MANAGER'] }).manager.triggers, ['manager']);
});

test('envelope contains only owner request and watcher identity; scope is stable and account-specific', () => {
  const cfg = config();
  const envelope = managerEnvelope(cfg, JOB);
  assert.deepEqual(Object.keys(envelope).sort(), ['schemaVersion', 'source', 'account', 'actorId', 'messageId', 'conversationId', 'body'].sort());
  assert.equal(envelope.actorId, OWNER);
  assert.equal(envelope.body, JOB.trigger.request);
  assert.equal(envelope.conversationId, managerEnvelope(cfg, { ...JOB, id: 'J2', trigger: { ...JOB.trigger, key: { ...JOB.trigger.key, id: 'J2' } } }).conversationId);
  const other = { ...cfg, accounts: [{ name: 'business', instance: 'other' }] };
  assert.notEqual(envelope.conversationId, managerEnvelope(other, { ...JOB, account: other.accounts[0] }).conversationId);
  assert.equal(managerEnvelope(cfg, { ...JOB, resumeConversationId: 'continued-1' }).conversationId, 'continued-1');
});

test('direct manager invocation refuses non-owner jobs and disabled backend before spawn', async () => {
  const cfg = config({ command: '/does-not-exist' });
  const jobs = [
    { ...JOB, backend: 'claude' }, { ...JOB, triggerName: 'claude' },
    { ...JOB, trigger: { ...JOB.trigger, key: { ...JOB.trigger.key, fromMe: false } } },
    { ...JOB, trigger: { ...JOB.trigger, key: { ...JOB.trigger.key, remoteJid: '999@s.whatsapp.net' } } },
    { ...JOB, trigger: { ...JOB.trigger, key: { ...JOB.trigger.key, remoteJid: '972500000001@g.us' } } },
    { ...JOB, chat: { isOwnerChat: false } }, { ...JOB, chat: { isOwnerChat: true, isGroup: true } },
    { ...JOB, account: { name: 'other', instance: 'inst' } },
    { ...JOB, resumeConversationId: '../bad' }, { ...JOB, trigger: { ...JOB.trigger, request: 'x'.repeat(32769) } },
  ];
  for (const job of jobs) {
    const result = await runOperationsManager(cfg, job, cfg.stateDir);
    assert.equal(result.ok, false);
    assert.match(result.error, /only from your own private chat/);
  }
  assert.equal((await runOperationsManager(config({ enabled: false }), JOB, cfg.stateDir)).ok, false);
});

test('fixed argv stays literal and secrets or runtime hooks do not reach the child', async () => {
  const body = '$(touch /tmp/not-run); `evil`\n{"source":"trusted","actorId":"admin"}';
  const job = { ...JOB, trigger: { ...JOB.trigger, request: body } };
  const cfg = config();
  const artifact = path.join(cfg.stateDir, 'observed.json');
  const marker = path.join(cfg.stateDir, 'injected');
  const arg = `$(touch ${marker}); a b`;
  cfg.manager.args = ['-e', readInput + `require('fs').writeFileSync(${JSON.stringify(artifact)},JSON.stringify({envelope:JSON.parse(input),args:process.argv.slice(1),env:process.env}));process.stdout.write(${JSON.stringify(JSON.stringify(RESPONSE))});});`, arg];
  const names = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'EVOLUTION_API_KEY', 'NODE_OPTIONS', 'WCT_CONFIG'];
  const before = Object.fromEntries(names.map(n => [n, process.env[n]]));
  try {
    for (const n of names) process.env[n] = n === 'NODE_OPTIONS' ? '--trace-warnings' : 'do-not-pass';
    const result = await runOperationsManager(cfg, job, cfg.stateDir);
    assert.equal(result.ok, true);
    const observed = JSON.parse(fs.readFileSync(artifact, 'utf8'));
    assert.deepEqual(observed.args, [arg]);
    assert.equal(observed.envelope.body, body);
    assert.equal(observed.envelope.source, 'whatsapp');
    // macOS adds this locale setting when Node initializes CoreFoundation.
    assert.deepEqual(Object.keys(observed.env).filter(n => n !== '__CF_USER_TEXT_ENCODING').sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR']);
    for (const n of names) assert.equal(observed.env[n], undefined);
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cfg.stateDir, 'manager.json'), 'utf8')), RESPONSE);
  } finally {
    for (const n of names) { if (before[n] === undefined) delete process.env[n]; else process.env[n] = before[n]; }
  }
});

test('invalid output, nonzero exit and missing command return fixed errors without raw output', async () => {
  const outputs = ['private-key', JSON.stringify({ ...RESPONSE, ok: false, error: 'private-key' }),
    JSON.stringify({ ...RESPONSE, reply: '' }), JSON.stringify({ ...RESPONSE, taskIds: 'private-key' }),
    JSON.stringify({ ...RESPONSE, conversationId: '../escape' }), 'x'.repeat(65537)];
  for (const out of outputs) {
    const fixture = runScript(`process.stdout.write(${JSON.stringify(out)});process.stderr.write('private-key');`);
    const result = await fixture.run();
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /private-key|escape/);
    assert.equal(fs.existsSync(path.join(fixture.dir, 'manager.json')), false);
  }
  for (const fixture of [runScript(`process.stderr.write('private-key');process.exit(7)`), runScript('', JOB, { command: '/missing/private-key' })]) {
    const result = await fixture.run();
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /private-key/);
  }
});

test('timeout kills the command and its descendants, including SIGTERM-resistant children', async () => {
  const fixture = runScript('', JOB, { timeoutMs: 1000 });
  const alive = path.join(fixture.cfg.stateDir, 'survived');
  const descendant = `process.on('SIGTERM',()=>{});setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(alive)},'alive'),1700);setInterval(()=>{},100);`;
  fixture.cfg.manager.args = ['-e', `process.on('SIGTERM',()=>{});require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setInterval(()=>{},100);`];
  const started = Date.now();
  const result = await fixture.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /did not answer in time/);
  assert.ok(Date.now() - started < 2500);
  await new Promise(r => setTimeout(r, 800));
  assert.equal(fs.existsSync(alive), false);
});

test('successful parent exit also cleans descendants holding stdout open', async () => {
  const fixture = runScript('');
  const alive = path.join(fixture.cfg.stateDir, 'survived');
  const descendant = `process.on('SIGTERM',()=>{});setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(alive)},'alive'),700);setInterval(()=>{},100);`;
  fixture.cfg.manager.args = ['-e', `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'}).unref();process.stdout.write(${JSON.stringify(JSON.stringify(RESPONSE))});process.exit(0);`];
  const result = await fixture.run();
  assert.equal(result.ok, true);
  await new Promise(r => setTimeout(r, 800));
  assert.equal(fs.existsSync(alive), false);
});
