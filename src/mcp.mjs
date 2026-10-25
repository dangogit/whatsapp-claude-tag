// A minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), tools only.
// Small enough to read in one sitting, and no SDK dependency to audit.

import readline from 'node:readline';

export function createMcpHandler({ name, version, tools }) {
  const byName = new Map(tools.map(t => [t.name, t]));

  return async function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return msg?.id !== undefined ? error(msg.id, -32600, 'invalid request') : null;
    }
    const isNotification = msg.id === undefined || msg.id === null;
    switch (msg.method) {
      case 'initialize':
        return result(msg.id, {
          protocolVersion: msg.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name, version },
        });
      case 'ping':
        return result(msg.id, {});
      case 'tools/list':
        return result(msg.id, {
          tools: tools.map(({ name: n, description, inputSchema }) => ({ name: n, description, inputSchema })),
        });
      case 'tools/call': {
        const tool = byName.get(msg.params?.name);
        if (!tool) return error(msg.id, -32602, `unknown tool ${msg.params?.name}`);
        try {
          const out = await tool.handler(msg.params?.arguments || {});
          // a handler may return MCP content blocks (an image the model should see) instead of text
          if (out && typeof out === 'object' && Array.isArray(out.content)) return result(msg.id, { content: out.content });
          return result(msg.id, { content: [{ type: 'text', text: String(out) }] });
        } catch (err) {
          return result(msg.id, { content: [{ type: 'text', text: String(err?.message || err) }], isError: true });
        }
      }
      default:
        return isNotification ? null : error(msg.id, -32601, `method not found: ${msg.method}`);
    }
  };
}

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function serveStdio(handle, { input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', async line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      output.write(`${JSON.stringify(error(null, -32700, 'parse error'))}\n`);
      return;
    }
    const reply = await handle(msg);
    if (reply) output.write(`${JSON.stringify(reply)}\n`);
  });
  return rl;
}
