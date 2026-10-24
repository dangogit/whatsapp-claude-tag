#!/usr/bin/env node
// whatsapp-claude-tag [run|check|pair] [--config <file>] [--account <name>]

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { defaultConfigPath, expandHome, loadConfig } from './config.mjs';
import { BaileysClient, pairedOwner } from './baileys.mjs';
import { EvolutionClient } from './evolution.mjs';
import { RpcClient } from './rpc.mjs';
import { runService } from './service.mjs';
import { acquireLock } from './store.mjs';
import { baileysAccounts, rpcSocketPath } from './transport.mjs';

function log(level, fields) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, ...fields })}\n`);
}

function parseArgs(argv) {
  const args = { command: 'run', config: '', account: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config') args.config = argv[++i] || '';
    else if (a === '--account') args.account = argv[++i] || '';
    else if (a === '-h' || a === '--help') args.command = 'help';
    else if (!a.startsWith('-')) args.command = a;
    else throw new Error(`unknown option ${a}`);
  }
  return args;
}

// Baileys: ask the running watcher, or else only read the saved pairing. Opening a
// socket here would fight the watcher's, and an unpaired one would start pairing.
async function baileysStatus(cfg, account, rpc) {
  try {
    const state = await rpc.connectionState(account.instance);
    return { state, owner: account.ownerChat || await rpc.ownerJid(account.instance) };
  } catch (err) {
    if (!/not running/.test(err.message)) throw err;
  }
  const authDir = baileysAccounts(cfg).find(a => a.instance === account.instance).authDir;
  const owner = pairedOwner(authDir);
  return { state: owner ? 'paired, watcher not running' : 'not paired (run: whatsapp-claude-tag pair)', owner, idleOk: !!owner };
}

async function check(cfg) {
  let failed = false;
  const baileys = cfg.transport === 'baileys';
  const client = baileys ? new RpcClient(rpcSocketPath(cfg)) : new EvolutionClient({ url: cfg.evolution.url, apiKey: cfg.evolution.apiKey });
  if (baileys) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    const sqliteOk = major > 22 || (major === 22 && minor >= 13);
    failed ||= !sqliteOk;
    console.log(`${sqliteOk ? 'ok  ' : 'FAIL'} node ${process.version}${sqliteOk ? '' : ': the baileys transport needs 22.13 or newer'}`);
  }
  for (const account of cfg.accounts) {
    try {
      const { state, owner, idleOk } = baileys
        ? await baileysStatus(cfg, account, client)
        : { state: await client.connectionState(account.instance), owner: account.ownerChat || await client.ownerJid(account.instance) };
      const ok = (state === 'open' || idleOk) && owner;
      failed ||= !ok;
      const what = baileys ? `baileys ${account.instance}` : `instance ${account.instance}`;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${account.name}: ${what} is ${state}, owner ${owner || 'unknown'}`);
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
  await runService(cfg, { log });
  process.exit(0);
}

// Links this tool as a WhatsApp device: prints the QR, waits for the scan, exits.
async function pair(cfg, accountName) {
  if (cfg.transport !== 'baileys') throw new Error('pair is for transport "baileys"; Evolution pairs in its own manager');
  const account = accountName ? cfg.accounts.find(a => a.name === accountName) : cfg.accounts[0];
  if (!account) throw new Error(`no account named ${accountName}`);
  const spec = baileysAccounts(cfg).find(a => a.instance === account.instance);
  const already = pairedOwner(spec.authDir);
  if (already) {
    console.log(`${account.name} is already paired as ${already}. To pair again, unlink the device on the phone and delete ${spec.authDir}.`);
    return 0;
  }
  let qrcode;
  try {
    qrcode = (await import('qrcode-terminal')).default;
  } catch {
    throw new Error('pair needs the optional dependency qrcode-terminal: run `npm install` in the checkout');
  }
  // The watcher would hold a second socket on the same credentials.
  const releaseLock = acquireLock(cfg.stateDir);
  const client = new BaileysClient([{ instance: account.instance, authDir: spec.authDir }], {
    pairing: true,
    log: (level, fields) => { if (level !== 'info') log(level, fields); },
    onQr: (_instance, qr) => {
      console.log(`\nScan with WhatsApp on the phone of "${account.name}": Settings > Linked devices > Link a device.\n`);
      qrcode.generate(qr, { small: true });
    },
  });
  try {
    await client.start();
    await Promise.race([
      client.waitOpen(account.instance),
      new Promise((_, reject) => setTimeout(() => reject(new Error('no scan within 3 minutes')), 180_000).unref()),
    ]);
    // Let the first credential and key writes reach the auth directory.
    await new Promise(r => setTimeout(r, 3000));
    console.log(`paired ${account.name} as ${await client.ownerJid(account.instance)}. Now start: whatsapp-claude-tag run`);
    return 0;
  } finally {
    client.close();
    releaseLock();
  }
}

const HELP = `whatsapp-claude-tag: tag @claude in any WhatsApp chat from your own phone.

Usage:
  whatsapp-claude-tag run   [--config <file>]   watch and act (default)
  whatsapp-claude-tag check [--config <file>]   verify WhatsApp and Claude Code
  whatsapp-claude-tag pair  [--config <file>] [--account <name>]
                                                link a device by QR (transport "baileys")

Config: ${defaultConfigPath()} (or WCT_CONFIG). See config.example.json.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') { console.log(HELP); return 0; }
  // The per-run MCP server reads the same file, so pass the choice down through the env.
  if (args.config) process.env.WCT_CONFIG = path.resolve(expandHome(args.config));
  const cfg = loadConfig(process.env.WCT_CONFIG || undefined);
  if (args.command === 'check') return check(cfg);
  // Baileys can leave timers behind after the socket closes; pairing is done, so exit.
  if (args.command === 'pair') process.exit(await pair(cfg, args.account));
  if (args.command === 'run') { await run(cfg); return 0; }
  throw new Error(`unknown command ${args.command}`);
}

main().then(code => { if (code) process.exitCode = code; }, err => {
  log('error', { event: 'fatal', error: err.message });
  process.exit(1);
});
