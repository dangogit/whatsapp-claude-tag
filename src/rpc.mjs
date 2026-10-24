// The watcher holds the only Baileys socket; per-run MCP servers call it over a Unix
// socket in the state directory (owner-only permissions), with the same method names
// as EvolutionClient. Policy stays in tools.mjs, in the MCP server, as with Evolution.

import fs from 'node:fs';
import http from 'node:http';

const METHODS = ['findMessages', 'findContacts', 'fetchGroups', 'ownerJid', 'connectionState', 'sendText', 'deleteForEveryone'];
const MAX_BODY = 1 << 20;
const TIMEOUTS = { fetchGroups: 180_000, sendText: 60_000, deleteForEveryone: 60_000 };

export function serveRpc(client, socketPath) {
  // The caller holds the state-dir lock, so a leftover socket is from a dead watcher.
  fs.rmSync(socketPath, { force: true });
  const server = http.createServer((req, res) => {
    let size = 0;
    const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(d);
    });
    req.on('end', async () => {
      let out;
      try {
        const { method, args } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (req.method !== 'POST' || !METHODS.includes(method) || !Array.isArray(args)) throw new Error('bad request');
        out = { ok: true, result: await client[method](...args) };
      } catch (err) {
        out = { ok: false, error: err.message };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600);
      resolve({ close: () => new Promise(r => server.close(() => { fs.rmSync(socketPath, { force: true }); r(); })) });
    });
  });
}

export class RpcClient {
  constructor(socketPath) {
    this.socketPath = socketPath;
    for (const m of METHODS) this[m] = (...args) => this.call(m, args);
  }

  call(method, args) {
    const body = JSON.stringify({ method, args });
    return new Promise((resolve, reject) => {
      const req = http.request({
        // A fresh connection per call: a kept-alive one goes stale when the watcher restarts.
        socketPath: this.socketPath, path: '/', method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: TIMEOUTS[method] || 30_000,
      }, res => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          try {
            const out = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (out.ok) resolve(out.result);
            else reject(new Error(out.error || 'whatsapp transport error'));
          } catch (err) { reject(err); }
        });
      });
      req.on('timeout', () => req.destroy(new Error(`whatsapp transport ${method} timed out`)));
      req.on('error', err => reject(err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
        ? new Error('the whatsapp-claude-tag watcher is not running (no transport socket)') : err));
      req.end(body);
    });
  }
}
