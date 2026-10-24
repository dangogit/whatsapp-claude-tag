// File-based state shared by the watcher and the per-run MCP server.
//
// Layout under <stateDir>/<account>/:
//   seen.json          ids of messages already handled (bounded)
//   sent.log           ids of messages this tool sent, one per line (loop guard)
//   pending/<id>.json  approval drafts waiting for a reply, keyed by draft message id
//   jobs/<id>/         one directory per run: job.json, actions.jsonl

import fs from 'node:fs';
import path from 'node:path';

const SEEN_MAX = 3000;
const SENT_TAIL = 2000;

export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export class AccountStore {
  constructor(stateDir, account) {
    this.dir = path.join(stateDir, account);
    fs.mkdirSync(path.join(this.dir, 'pending'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(this.dir, 'jobs'), { recursive: true, mode: 0o700 });
    this.seenFile = path.join(this.dir, 'seen.json');
    this.sentFile = path.join(this.dir, 'sent.log');
    this.seen = new Set(readJson(this.seenFile, []));
  }

  hasSeen(id) { return this.seen.has(id); }

  markSeen(ids) {
    let changed = false;
    for (const id of ids) {
      if (id && !this.seen.has(id)) { this.seen.add(id); changed = true; }
    }
    if (!changed) return;
    const list = [...this.seen].slice(-SEEN_MAX);
    this.seen = new Set(list);
    writeJsonAtomic(this.seenFile, list);
  }

  recordSent(id) {
    if (id) fs.appendFileSync(this.sentFile, `${id}\n`, { mode: 0o600 });
  }

  sentIds() {
    try {
      return new Set(fs.readFileSync(this.sentFile, 'utf8').split('\n').filter(Boolean).slice(-SENT_TAIL));
    } catch { return new Set(); }
  }

  addPending(draftId, data) {
    writeJsonAtomic(path.join(this.dir, 'pending', `${safe(draftId)}.json`), { draftId, ...data });
  }

  getPending(draftId) {
    return readJson(path.join(this.dir, 'pending', `${safe(draftId)}.json`), null);
  }

  removePending(draftId) {
    fs.rmSync(path.join(this.dir, 'pending', `${safe(draftId)}.json`), { force: true });
  }

  jobDir(jobId) {
    const dir = path.join(this.dir, 'jobs', safe(jobId));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  // Keep the newest `keep` job directories.
  pruneJobs(keep = 200) {
    const root = path.join(this.dir, 'jobs');
    const dirs = fs.readdirSync(root).map(name => ({ name, t: fs.statSync(path.join(root, name)).mtimeMs }));
    dirs.sort((a, b) => b.t - a.t);
    for (const d of dirs.slice(keep)) fs.rmSync(path.join(root, d.name), { recursive: true, force: true });
  }
}

function safe(id) {
  const s = String(id);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(s)) throw new Error(`unsafe id ${s.slice(0, 40)}`);
  return s;
}

export function appendAction(jobDir, action) {
  fs.appendFileSync(path.join(jobDir, 'actions.jsonl'), `${JSON.stringify({ t: Date.now(), ...action })}\n`, { mode: 0o600 });
}

export function readActions(jobDir) {
  try {
    return fs.readFileSync(path.join(jobDir, 'actions.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}
