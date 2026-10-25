import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LANGUAGES } from './strings.mjs';

export function expandHome(p) {
  if (typeof p !== 'string') return p;
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function defaultConfigPath() {
  return process.env.WCT_CONFIG || path.join(os.homedir(), '.config', 'whatsapp-claude-tag', 'config.json');
}

export const TRANSPORTS = ['evolution', 'baileys'];

const DEFAULTS = {
  transport: 'evolution',
  baileys: { authDir: '', keepDays: 30 },
  evolution: { url: 'http://127.0.0.1:8080', apiKeyEnv: 'EVOLUTION_API_KEY', envFile: '' },
  accounts: [],
  triggers: ['claude'],
  pollMs: 2000,
  stateDir: '~/.local/state/whatsapp-claude-tag',
  timezone: '',
  language: 'en',
  replyPrefix: '',
  claude: {
    bin: 'claude',
    model: 'sonnet',
    timeoutMs: 5 * 60 * 1000,
    fullAccess: false,
    webFetch: false,
    mcpServers: {},
    configDir: '',
  },
};

// Reads KEY=value lines; quotes are stripped, nothing is evaluated.
export function readEnvFile(file) {
  const out = {};
  const text = fs.readFileSync(expandHome(file), 'utf8');
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

// claude.mcpServers: { name: { command, args?, env? } } extra MCP servers (extensions).
// Paths may start with ~. Env values are plain settings such as a token FILE path, never a secret:
// the whole block ends up on the claude command line.
export function normalizeExtensions(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config.claude.mcpServers must be an object of { name: { command, args, env } }');
  const out = {};
  for (const [name, srv] of Object.entries(raw)) {
    if (!/^[a-z0-9_-]{1,32}$/.test(name) || name === 'whatsapp') throw new Error(`invalid extension name "${name}" (lowercase letters, digits, - and _, not "whatsapp")`);
    if (!srv || typeof srv.command !== 'string' || !srv.command) throw new Error(`extension "${name}" needs a command`);
    const args = srv.args ?? [];
    if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) throw new Error(`extension "${name}" args must be a list of strings`);
    const env = srv.env ?? {};
    if (typeof env !== 'object' || Array.isArray(env) || !Object.values(env).every(v => typeof v === 'string')) throw new Error(`extension "${name}" env must map names to strings`);
    out[name] = { command: expandHome(srv.command), args: args.map(expandHome), env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, expandHome(v)])) };
  }
  return out;
}

export function normalizeConfig(raw, env = process.env) {
  if (!raw || typeof raw !== 'object') throw new Error('config must be a JSON object');
  const cfg = {
    ...DEFAULTS,
    ...raw,
    evolution: { ...DEFAULTS.evolution, ...(raw.evolution || {}) },
    baileys: { ...DEFAULTS.baileys, ...(raw.baileys || {}) },
    claude: { ...DEFAULTS.claude, ...(raw.claude || {}) },
  };

  if (!TRANSPORTS.includes(cfg.transport)) throw new Error(`config.transport must be one of ${TRANSPORTS.join(', ')}`);
  const baileys = cfg.transport === 'baileys';
  if (!Array.isArray(cfg.accounts) || !cfg.accounts.length) {
    throw new Error(`config.accounts must list at least one ${baileys ? '{ name }' : '{ name, instance }'}`);
  }
  const names = new Set();
  cfg.accounts = cfg.accounts.map((a, i) => {
    if (!a || typeof a !== 'object') throw new Error(`config.accounts[${i}] must be an object`);
    // With Baileys the instance names the account's auth directory, so it defaults to the name.
    const instance = typeof a.instance === 'string' && a.instance ? a.instance : baileys && typeof a.name === 'string' ? a.name : '';
    if (!instance) throw new Error(`config.accounts[${i}].instance is required`);
    if (baileys && !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(instance)) throw new Error(`invalid account instance "${instance}"`);
    const name = typeof a.name === 'string' && a.name ? a.name : instance;
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name)) throw new Error(`invalid account name "${name}"`);
    if (names.has(name)) throw new Error(`duplicate account name "${name}"`);
    names.add(name);
    return { name, instance, ownerChat: typeof a.ownerChat === 'string' ? a.ownerChat : '' };
  });
  if (baileys && new Set(cfg.accounts.map(a => a.instance)).size !== cfg.accounts.length) {
    throw new Error('config.accounts must not share an instance');
  }

  if (!Array.isArray(cfg.triggers) || !cfg.triggers.every(t => typeof t === 'string' && t.trim())) {
    throw new Error('config.triggers must be a list of names, for example ["claude"]');
  }
  if (!Number.isInteger(cfg.pollMs) || cfg.pollMs < 500) throw new Error('config.pollMs must be an integer >= 500');
  if (!Number.isInteger(cfg.claude.timeoutMs) || cfg.claude.timeoutMs < 10_000) {
    throw new Error('config.claude.timeoutMs must be an integer >= 10000');
  }
  if (!LANGUAGES.includes(cfg.language)) throw new Error(`config.language must be one of ${LANGUAGES.join(', ')}`);
  if (typeof cfg.replyPrefix !== 'string') throw new Error('config.replyPrefix must be a string');
  cfg.claude.fullAccess = cfg.claude.fullAccess === true;
  cfg.claude.webFetch = cfg.claude.webFetch === true;
  cfg.claude.mcpServers = normalizeExtensions(cfg.claude.mcpServers);
  cfg.stateDir = expandHome(cfg.stateDir);
  cfg.claude.bin = expandHome(cfg.claude.bin);
  cfg.claude.configDir = expandHome(cfg.claude.configDir || path.join(cfg.stateDir, 'claude-home'));
  cfg.timezone = cfg.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (baileys) {
    if (!Number.isInteger(cfg.baileys.keepDays) || cfg.baileys.keepDays < 1) {
      throw new Error('config.baileys.keepDays must be an integer >= 1');
    }
    cfg.baileys.authDir = expandHome(cfg.baileys.authDir || path.join(cfg.stateDir, 'baileys'));
    return cfg;
  }

  let apiKey = env[cfg.evolution.apiKeyEnv] || '';
  if (!apiKey && cfg.evolution.envFile) {
    apiKey = readEnvFile(cfg.evolution.envFile)[cfg.evolution.apiKeyEnv] || '';
  }
  if (!apiKey) {
    throw new Error(`no Evolution API key: set ${cfg.evolution.apiKeyEnv} or config.evolution.envFile`);
  }
  // Kept off the object that gets logged or written into job files.
  Object.defineProperty(cfg.evolution, 'apiKey', { value: apiKey, enumerable: false });
  return cfg;
}

export function loadConfig(file = defaultConfigPath(), env = process.env) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(expandHome(file), 'utf8'));
  } catch (err) {
    throw new Error(`cannot read config ${file}: ${err.message}`);
  }
  return normalizeConfig(raw, env);
}
