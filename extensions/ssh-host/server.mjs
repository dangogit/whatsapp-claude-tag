#!/usr/bin/env node
// MCP server for the ssh-host extension. Configure it under claude.mcpServers:
//
//   "laptop": {
//     "command": "node",
//     "args": ["~/whatsapp-claude-tag/extensions/ssh-host/server.mjs"],
//     "env": { "SSH_HOST": "me@my-laptop", "SSH_KEY": "~/.ssh/id_wct_laptop", "HOST_LABEL": "my laptop" }
//   }
//
// The key must be installed on the other machine with the forced command from install-gate.sh.

import fs from 'node:fs';
import path from 'node:path';
import { createMcpHandler, serveStdio } from '../../src/mcp.mjs';
import { createHostTools } from './host.mjs';

const jobDir = process.env.WCT_JOB_DIR;
if (!jobDir || !process.env.SSH_HOST) {
  process.stderr.write('ssh-host extension: WCT_JOB_DIR and SSH_HOST must be set\n');
  process.exit(2);
}
const job = JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf8'));
const tools = createHostTools({
  host: process.env.SSH_HOST, key: process.env.SSH_KEY, port: process.env.SSH_PORT,
  label: process.env.HOST_LABEL, job, jobDir,
});
serveStdio(createMcpHandler({ name: 'ssh-host', version: '0.1.0', tools }));
