#!/usr/bin/env node
// Started by Claude Code for one run. Reads the job written by the watcher.

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { buildDirectory } from './directory.mjs';
import { EvolutionClient } from './evolution.mjs';
import { createMcpHandler, serveStdio } from './mcp.mjs';
import { AccountStore } from './store.mjs';
import { createTools } from './tools.mjs';

const jobDir = process.env.WCT_JOB_DIR;
if (!jobDir) {
  process.stderr.write('WCT_JOB_DIR is not set\n');
  process.exit(2);
}
const cfg = loadConfig(process.env.WCT_CONFIG || undefined);
const job = JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf8'));
const client = new EvolutionClient({ url: cfg.evolution.url, apiKey: cfg.evolution.apiKey });
const store = new AccountStore(cfg.stateDir, job.account.name);

let names;
const getNames = async () => {
  names ||= await buildDirectory(client, job.account.instance, path.join(cfg.stateDir, 'cache'));
  return names;
};

const tools = createTools({ client, store, job, jobDir, getNames });
serveStdio(createMcpHandler({ name: 'whatsapp', version: '0.1.0', tools }));
