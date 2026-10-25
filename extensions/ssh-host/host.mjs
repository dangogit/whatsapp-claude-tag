// Tools that act on another machine of the owner's (a laptop) through the SSH gate.
// The gate on that machine decides what is possible; this side decides when: a project
// is only touched when the owner named it in the request.

import { execFile } from 'node:child_process';
import { authorizedText } from '../../src/policy.mjs';
import { appendAction } from '../../src/store.mjs';

const words = s => String(s || '').toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// The whole last segment of the project must appear in the text, as one token
// ("whatsapp-claude-tag") or as all its words in order ("whatsapp claude tag").
// One word of it ("whatsapp") is not enough.
export function projectNamed(project, text) {
  const want = words(String(project).split('/').pop());
  const have = words(text);
  if (!want.length) return false;
  for (let i = 0; i + want.length <= have.length; i += 1) {
    if (want.every((w, k) => have[i + k] === w)) return true;
  }
  return false;
}

// One ssh call: the gate receives "<op> <base64url JSON>" as SSH_ORIGINAL_COMMAND.
export function sshArgs({ host, key, port }, op, args) {
  const payload = args ? ` ${Buffer.from(JSON.stringify(args)).toString('base64url')}` : '';
  return [
    ...(key ? ['-i', key, '-o', 'IdentitiesOnly=yes'] : []),
    ...(port ? ['-p', String(port)] : []),
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30', '-T',
    host, `${op}${payload}`,
  ];
}

function defaultExec(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('ssh', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim();
      if (out.startsWith('error:')) return reject(new Error(out.slice(6).trim()));
      if (err) return reject(new Error(err.killed ? 'the machine did not answer in time' : (String(stderr || '').trim().split('\n').pop() || err.message)));
      resolve(out);
    });
  });
}

// deps: { host, key, port, label, job, jobDir, exec }
export function createHostTools(deps) {
  const { job, jobDir } = deps;
  const label = deps.label || deps.host;
  const exec = deps.exec || defaultExec;
  const call = (op, args, minutes) => exec(sshArgs(deps, op, args), minutes * 60_000);

  // The owner's own words must name the project: chat content cannot point the run at code.
  function checkProject(project) {
    const p = String(project || '').trim();
    if (!p) throw new Error('project is required');
    if (!projectNamed(p, authorizedText(job))) throw new Error(`refused: the owner did not name "${p}" in the request`);
    return p;
  }

  return [
    {
      name: 'host_projects',
      description: `List the git projects on ${label}.`,
      inputSchema: { type: 'object', properties: {} },
      handler: async () => call('projects', null, 1),
    },
    {
      name: 'host_status',
      description: `Branch, uncommitted changes and recent commits of a project on ${label}. The owner must have named the project.`,
      inputSchema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
      handler: async ({ project }) => call('status', { project: checkProject(project) }, 1),
    },
    {
      name: 'host_ask',
      description: `Ask Claude Code on ${label} a question about a project. It reads the project's files (and is given its recent commits) and changes nothing. The owner must have named the project.`,
      inputSchema: { type: 'object', properties: { project: { type: 'string' }, question: { type: 'string' } }, required: ['project', 'question'] },
      handler: async ({ project, question }) => call('ask', { project: checkProject(project), question: String(question || '') }, 6),
    },
    {
      name: 'host_task',
      description: `Have Claude Code on ${label} edit files in a project. It works in a new git worktree on a new branch; the change is committed there, tests are not run, nothing is pushed or merged, and the owner reviews the branch. The owner must have named the project and asked for a change.`,
      inputSchema: { type: 'object', properties: { project: { type: 'string' }, instruction: { type: 'string' } }, required: ['project', 'instruction'] },
      async handler({ project, instruction }) {
        const out = await call('task', { project: checkProject(project), instruction: String(instruction || '') }, 16);
        appendAction(jobDir, { type: 'host-task', project });
        return out;
      },
    },
  ];
}
