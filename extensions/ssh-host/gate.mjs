#!/usr/bin/env node
// The only program the whatsapp-claude-tag key may run on this machine.
//
// Install it as a forced command in ~/.ssh/authorized_keys (see install-gate.sh), so the
// key gets no shell, no port forwarding and no other command: just these operations.
//
//   projects                      git repositories under the projects root
//   status  {project}             branch, short status and the last commits
//   ask     {project, question}   Claude Code answers about the project: it can read files
//                                 inside the project and nothing else
//   task    {project, instruction} Claude Code edits files inside a NEW worktree on a new
//                                 branch; the gate commits the result. Never pushes or merges.
//
// Claude Code here gets no shell at all: running a test or a git command would be running code
// the agent can write. Reads and edits are limited to the project directory by permission rules.
//
// The request arrives in SSH_ORIGINAL_COMMAND as "<op> <base64url JSON>".
// Settings (set in the forced command): WCT_ROOT (projects root, default ~/projects),
// WCT_CLAUDE (claude binary), WCT_TOKEN_CMD (prints a Claude Code OAuth token; optional).

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_OUT = 8000;
const SKIP = new Set(['node_modules', '.trash', '.git', 'worktrees', '_docs', '.claude']);

export function parseRequest(raw) {
  const m = /^(projects|status|ask|task)(?: ([A-Za-z0-9_-]+={0,2}))?$/.exec(String(raw || '').trim());
  if (!m) throw new Error('unknown request');
  let args = {};
  if (m[2]) {
    try { args = JSON.parse(Buffer.from(m[2], 'base64url').toString('utf8')); } catch { throw new Error('bad arguments'); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('bad arguments');
  }
  return { op: m[1], args };
}

// Git repositories up to two levels under root ("luma", "public/whatsapp-claude-tag").
export function listProjects(root) {
  const out = [];
  const isRepo = d => fs.existsSync(path.join(d, '.git'));
  for (const a of safeDir(root)) {
    const pa = path.join(root, a);
    if (isRepo(pa)) { out.push(a); continue; }
    for (const b of safeDir(pa)) if (isRepo(path.join(pa, b))) out.push(`${a}/${b}`);
  }
  return out.sort();
}

function safeDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
      .map(e => e.name);
  } catch { return []; }
}

// Exact relative path, or a unique last segment. Always inside root.
export function resolveProject(root, name) {
  const want = String(name || '').trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!want || want.includes('..')) throw new Error('project name required');
  const all = listProjects(root);
  const exact = all.filter(p => p.toLowerCase() === want);
  const byBase = all.filter(p => p.split('/').pop().toLowerCase() === want);
  const hits = exact.length ? exact : byBase;
  if (hits.length !== 1) throw new Error(hits.length ? `"${name}" matches ${hits.join(', ')}` : `no project "${name}"`);
  const dir = fs.realpathSync(path.join(root, hits[0]));
  if (!dir.startsWith(fs.realpathSync(root) + path.sep)) throw new Error('project outside the root');
  return { rel: hits[0], dir };
}

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 20_000 }).trim();

function claude(dir, prompt, { tools, allowed, minutes }) {
  const home = path.join(os.homedir(), '.local', 'state', 'wct-gate', 'claude-home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: home };
  if (process.env.WCT_TOKEN_CMD && !env.CLAUDE_CODE_OAUTH_TOKEN) {
    const r = spawnSync('/bin/sh', ['-c', process.env.WCT_TOKEN_CMD], { encoding: 'utf8', timeout: 10_000 });
    const tok = (r.stdout || '').trim();
    if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok;
  }
  const r = spawnSync(process.env.WCT_CLAUDE || 'claude', [
    '-p', '--output-format', 'json', '--model', 'sonnet', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', tools.join(','), '--allowedTools', allowed.join(','), '--permission-mode', 'dontAsk',
    // secrets stay on disk even though Read is allowed: answers go back into WhatsApp
    '--disallowedTools', 'Read(**/.env*)', 'Read(**/*.pem)', 'Read(**/*.key)', 'Read(**/.secrets*)', 'Read(**/id_*)',
    'Edit(.git/**)', 'Edit(**/.git/**)', 'Write(**/.git/**)', 'Edit(.claude/**)', 'Write(.claude/**)',
  ], { cwd: dir, env, input: prompt, encoding: 'utf8', timeout: minutes * 60_000, maxBuffer: 20 * 1024 * 1024 });
  if (r.error) throw new Error(r.error.code === 'ETIMEDOUT' ? `timed out after ${minutes} min` : r.error.message);
  let data;
  try { data = JSON.parse(r.stdout); } catch { throw new Error(`claude exited ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(-300)}`); }
  if (data.is_error) throw new Error(String(data.result || 'claude failed').slice(0, 500));
  return String(data.result || '').trim();
}

const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const READ_ALLOWED = ['Read(./**)', 'Grep', 'Glob'];
const TASK_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write'];
const TASK_ALLOWED = [...READ_ALLOWED, 'Edit(./**)', 'Write(./**)'];
// Commits made by the gate run no hooks: the agent could have written one.
const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false'];

export function run(req, root) {
  const { op, args } = req;
  if (op === 'projects') return listProjects(root).join('\n') || '(no git repositories)';
  const { rel, dir } = resolveProject(root, args.project);
  if (op === 'status') {
    return [`# ${rel}`, git(dir, 'status', '-sb'), '', git(dir, 'log', '-5', '--format=%h %cr  %s')].join('\n');
  }
  if (op === 'ask') {
    const q = String(args.question || '').trim();
    if (!q) throw new Error('question required');
    const context = [`Branch and changes:\n${git(dir, 'status', '-sb')}`, `Recent commits:\n${git(dir, 'log', '-15', '--format=%h %cr  %s')}`].join('\n\n');
    return claude(dir, `${q}\n\n${context}\n\nAnswer briefly, plain text, for a WhatsApp message. You can read files in this project only.`,
      { tools: READ_TOOLS, allowed: READ_ALLOWED, minutes: 5 });
  }
  if (op === 'task') {
    const instruction = String(args.instruction || '').trim();
    if (!instruction) throw new Error('instruction required');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '-');
    const branch = `wct/${stamp}`;
    const wt = path.join(dir, '.claude', 'worktrees', `wct-${stamp}`);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    const base = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(dir, 'worktree', 'add', '-q', '-b', branch, wt, 'HEAD');
    const summary = claude(wt, `${instruction}\n\nEdit files in this directory only (a fresh git worktree on branch ${branch}). `
      + 'You cannot run commands; the change is committed for you after you finish. '
      + 'End with one plain sentence describing the change, it becomes the commit message.',
    { tools: TASK_TOOLS, allowed: TASK_ALLOWED, minutes: 15 });
    git(wt, ...SAFE_GIT, 'add', '-A');
    const changed = git(wt, 'status', '--porcelain');
    if (changed) {
      const msg = (summary.split('\n').map(l => l.trim()).filter(Boolean).pop() || instruction).slice(0, 200);
      git(wt, ...SAFE_GIT, 'commit', '-q', '--no-verify', '-m', `wct: ${msg}`);
    }
    const log = git(wt, 'log', '--format=%h %s', `${base}..HEAD`) || '(no commits)';
    const stat = git(wt, 'diff', '--stat', `${base}...HEAD`) || '(no changes)';
    return [`# ${rel}  branch ${branch} (from ${base}), not pushed, tests not run`, `worktree: ${wt}`, '', summary, '', log, stat].join('\n');
  }
  throw new Error('unknown request');
}

function main() {
  const root = path.resolve(process.env.WCT_ROOT || path.join(os.homedir(), 'projects'));
  try {
    const out = run(parseRequest(process.env.SSH_ORIGINAL_COMMAND), root);
    process.stdout.write(`${out.length > MAX_OUT ? `${out.slice(0, MAX_OUT)}\n...(cut)` : out}\n`);
  } catch (err) {
    process.stdout.write(`error: ${String(err.message || err).slice(0, 600)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) main();
