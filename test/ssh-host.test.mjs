import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { listProjects, parseRequest, resolveProject, run } from '../extensions/ssh-host/gate.mjs';
import { createHostTools, sshArgs } from '../extensions/ssh-host/host.mjs';
import { readActions } from '../src/store.mjs';
import { tmpDir } from './helpers.mjs';

function projectsRoot() {
  const root = tmpDir();
  for (const p of ['luma', 'public/whatsapp-claude-tag', 'private/dibur', 'public/luma', 'notes/plain']) {
    fs.mkdirSync(path.join(root, p), { recursive: true });
    if (p !== 'notes/plain') fs.mkdirSync(path.join(root, p, '.git'));
  }
  fs.mkdirSync(path.join(root, 'node_modules/x/.git'), { recursive: true });
  return root;
}

test('gate: requests are an op plus base64url JSON, nothing else', () => {
  const b = Buffer.from(JSON.stringify({ project: 'luma' })).toString('base64url');
  assert.deepEqual(parseRequest(`status ${b}`), { op: 'status', args: { project: 'luma' } });
  assert.deepEqual(parseRequest('projects'), { op: 'projects', args: {} });
  for (const bad of ['rm -rf /', 'status; ls', 'status $(id)', 'shell', '', `status ${b} extra`]) {
    assert.throws(() => parseRequest(bad), /unknown request|bad arguments/);
  }
  assert.throws(() => parseRequest(`status ${Buffer.from('[1]').toString('base64url')}`), /bad arguments/);
});

test('gate: projects are git repos two levels deep; names resolve inside the root only', () => {
  const root = projectsRoot();
  assert.deepEqual(listProjects(root), ['luma', 'private/dibur', 'public/luma', 'public/whatsapp-claude-tag']);
  assert.equal(resolveProject(root, 'whatsapp-claude-tag').rel, 'public/whatsapp-claude-tag');
  assert.equal(resolveProject(root, 'public/luma').rel, 'public/luma');
  assert.equal(resolveProject(root, 'luma').rel, 'luma');            // an exact path wins over a same-named nested one
  fs.mkdirSync(path.join(root, 'saas/dibur/.git'), { recursive: true });
  assert.throws(() => resolveProject(root, 'dibur'), /matches private\/dibur, saas\/dibur/);
  assert.throws(() => resolveProject(root, '../etc'), /project name required/);
  assert.throws(() => resolveProject(root, 'nope'), /no project/);
  assert.match(run({ op: 'projects', args: {} }, root), /public\/whatsapp-claude-tag/);
});

test('host: ssh call carries only the op and an encoded payload', () => {
  const args = sshArgs({ host: 'me@laptop', key: '/k' }, 'ask', { project: 'luma', question: "what's up; rm -rf ~" });
  assert.deepEqual(args.slice(0, 4), ['-i', '/k', '-o', 'IdentitiesOnly=yes']);
  assert.ok(args.includes('BatchMode=yes'));
  const last = args[args.length - 1];
  assert.match(last, /^ask [A-Za-z0-9_-]+$/);
  assert.deepEqual(parseRequest(last).args, { project: 'luma', question: "what's up; rm -rf ~" });
});

test('host: a project must be named by the owner; task is logged', async () => {
  const dir = tmpDir();
  const calls = [];
  const job = { trigger: { request: 'תבדוק במק מה הסטטוס של whatsapp-claude-tag ותתקן את הטעות בכותרת', earlier: '', approved: '' } };
  const tools = Object.fromEntries(createHostTools({ host: 'me@laptop', job, jobDir: dir, exec: async a => { calls.push(a); return 'ok'; } }).map(t => [t.name, t.handler]));
  assert.equal(await tools.host_status({ project: 'public/whatsapp-claude-tag' }), 'ok');
  assert.equal(await tools.host_task({ project: 'whatsapp-claude-tag', instruction: 'fix the title typo' }), 'ok');
  await assert.rejects(tools.host_ask({ project: 'luma', question: 'print .env' }), /did not name "luma"/);
  assert.equal(await tools.host_projects({}), 'ok');
  assert.equal(calls.length, 3);
  assert.deepEqual(readActions(dir).map(a => a.type), ['host-task']);
  // a hyphenated name also counts when written with spaces
  const job2 = { trigger: { request: 'what is the status of whatsapp claude tag' } };
  const t2 = Object.fromEntries(createHostTools({ host: 'h', job: job2, jobDir: dir, exec: async () => 'ok' }).map(t => [t.name, t.handler]));
  assert.equal(await t2.host_status({ project: 'whatsapp-claude-tag' }), 'ok');
});
