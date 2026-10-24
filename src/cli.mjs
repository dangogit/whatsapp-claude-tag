#!/usr/bin/env node
// whatsapp-claude-tag [run|check] [--config <file>]

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { defaultConfigPath, expandHome, loadConfig } from './config.mjs';
import { EvolutionClient } from './evolution.mjs';
import { runClaude } from './runner.mjs';
import { AccountStore } from './store.mjs';
import { buildTriggerRegex } from './trigger.mjs';
import { AccountWatcher } from './watcher.mjs';

function log(level, fields) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, ...fields })}\n`);
}

function parseArgs(argv) {
  const args = { command: 'run', config: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config') args.config = argv[++i] || '';
    else if (a === '-h' || a === '--help') args.command = 'help';
    else if (!a.startsWith('-')) args.command = a;
    else throw new Error(`unknown option ${a}`);
  }
  return args;
}

async function check(cfg) {
  let failed = false;
  const client = new EvolutionClient({ url: cfg.evolution.url, apiKey: cfg.evolution.apiKey });
  for (const account of cfg.accounts) {
    try {
      const state = await client.connectionState(account.instance);
      const owner = account.ownerChat || await client.ownerJid(account.instance);
      const ok = state === 'open' && owner;
      failed ||= !ok;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${account.name}: instance ${account.instance} is ${state}, owner ${owner || 'unknown'}`);
    } catch (err) {
      failed = true;
      console.log(`FAIL ${account.name}: ${err.message}`);
    }
  }
  const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg.claude.configDir };
  const version = spawnSync(cfg.claude.bin, ['--version'], { env, encoding: 'utf8' });
  const auth = spawnSync(cfg.claude.bin, ['auth', 'status'], { env, encoding: 'utf8' });
  let loggedIn = false;
  try { loggedIn = JSON.parse(auth.stdout).loggedIn === true; } catch { /* not JSON */ }
  failed ||= version.status !== 0 || !loggedIn;
  console.log(`${version.status === 0 ? 'ok  ' : 'FAIL'} claude: ${(version.stdout || version.stderr || 'not found').trim()}`);
  console.log(`${loggedIn ? 'ok  ' : 'FAIL'} claude auth: ${loggedIn ? 'logged in' : 'not logged in (set CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`, or ANTHROPIC_API_KEY)'}`);
  console.log(`     triggers: ${cfg.triggers.map(n => `@${n}`).join(', ')}  access: ${cfg.claude.fullAccess ? 'full' : 'whatsapp + web'}`);
  return failed ? 1 : 0;
}

async function run(cfg) {
  const client = new EvolutionClient({ url: cfg.evolution.url, apiKey: cfg.evolution.apiKey });
  const regex = buildTriggerRegex(cfg.triggers);
  const watchers = [];
  for (const account of cfg.accounts) {
    const w = new AccountWatcher({
      cfg, account, client, regex, log, runJob: runClaude,
      store: new AccountStore(cfg.stateDir, account.name),
    });
    await w.init();
    watchers.push(w);
    log('info', { account: account.name, event: 'watching', instance: account.instance, ownerChat: w.ownerChat });
  }

  let stopping = false;
  const stop = sig => {
    if (stopping) process.exit(1);
    stopping = true;
    log('info', { event: 'stopping', signal: sig });
    Promise.all(watchers.map(w => w.queue)).finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  const failures = new Map();
  while (!stopping) {
    await Promise.all(watchers.map(async w => {
      try {
        await w.poll();
        if (failures.get(w.account.name)) log('info', { account: w.account.name, event: 'poll-recovered' });
        failures.set(w.account.name, 0);
      } catch (err) {
        const n = (failures.get(w.account.name) || 0) + 1;
        failures.set(w.account.name, n);
        // Log the first failure and then every 30th, so an outage does not flood the log.
        if (n === 1 || n % 30 === 0) log('error', { account: w.account.name, event: 'poll-failed', count: n, error: err.message });
      }
    }));
    await new Promise(r => setTimeout(r, cfg.pollMs));
  }
}

const HELP = `whatsapp-claude-tag: tag @claude in any WhatsApp chat from your own phone.

Usage:
  whatsapp-claude-tag run   [--config <file>]   watch and act (default)
  whatsapp-claude-tag check [--config <file>]   verify Evolution and Claude Code

Config: ${defaultConfigPath()} (or WCT_CONFIG). See config.example.json.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') { console.log(HELP); return 0; }
  // The per-run MCP server reads the same file, so pass the choice down through the env.
  if (args.config) process.env.WCT_CONFIG = path.resolve(expandHome(args.config));
  const cfg = loadConfig(process.env.WCT_CONFIG || undefined);
  if (args.command === 'check') return check(cfg);
  if (args.command === 'run') { await run(cfg); return 0; }
  throw new Error(`unknown command ${args.command}`);
}

main().then(code => { if (code) process.exitCode = code; }, err => {
  log('error', { event: 'fatal', error: err.message });
  process.exit(1);
});
