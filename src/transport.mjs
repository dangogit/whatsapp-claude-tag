// Picks the WhatsApp client by config.transport. Both expose the methods of
// EvolutionClient; Baileys keeps its socket in the watcher and serves runs over rpc.mjs.

import path from 'node:path';
import { BaileysClient, pairedOwner } from './baileys.mjs';
import { EvolutionClient } from './evolution.mjs';
import { RpcClient, serveRpc } from './rpc.mjs';

export function rpcSocketPath(cfg) {
  const file = path.join(cfg.stateDir, 'baileys.sock');
  // Unix socket paths are capped at 104 bytes on macOS (108 on Linux).
  if (Buffer.byteLength(file) > 103) throw new Error(`config.stateDir is too long for a Unix socket path: ${file}`);
  return file;
}

export function baileysAccounts(cfg) {
  return cfg.accounts.map(a => ({
    instance: a.instance,
    authDir: path.join(cfg.baileys.authDir, a.instance),
    dbFile: path.join(cfg.stateDir, a.name, 'messages.sqlite'),
  }));
}

// For the watcher: the client plus whatever must be closed on exit.
export async function openTransport(cfg, { log, makeSocket } = {}) {
  if (cfg.transport !== 'baileys') {
    return { client: new EvolutionClient({ url: cfg.evolution.url, apiKey: cfg.evolution.apiKey }), close: async () => {} };
  }
  const accounts = baileysAccounts(cfg);
  // Checked before connecting: an unpaired socket would only show a QR nobody sees.
  // A test socket (makeSocket) has no credentials on disk.
  const unpaired = makeSocket ? [] : cfg.accounts.filter((a, i) => !pairedOwner(accounts[i].authDir));
  if (unpaired.length) {
    throw new Error(`not paired: ${unpaired.map(a => a.name).join(', ')}. Run: whatsapp-claude-tag pair --account ${unpaired[0].name}`);
  }
  const client = new BaileysClient(accounts, { log, makeSocket, keepDays: cfg.baileys.keepDays });
  await client.start();
  const rpc = await serveRpc(client, rpcSocketPath(cfg));
  return { client, close: async () => { await rpc.close(); client.close(); } };
}

// For a per-run MCP server, which must not open a second WhatsApp socket.
export function toolClient(cfg) {
  if (cfg.transport === 'baileys') return new RpcClient(rpcSocketPath(cfg));
  return new EvolutionClient({ url: cfg.evolution.url, apiKey: cfg.evolution.apiKey });
}
