#!/usr/bin/env node
// MCP server for the Google extension. Configure it under claude.mcpServers:
//
//   "google": {
//     "command": "node",
//     "args": ["~/whatsapp-claude-tag/extensions/google/server.mjs"],
//     "env": { "GOOGLE_TOKEN_FILE": "~/.config/whatsapp-claude-tag/google-token.json" }
//   }
//
// The runner adds WCT_JOB_DIR, so the tools know the run's request and timezone.

import fs from 'node:fs';
import path from 'node:path';
import { createMcpHandler, serveStdio } from '../../src/mcp.mjs';
import { createGoogleTools } from './google.mjs';

const jobDir = process.env.WCT_JOB_DIR;
const tokenFile = process.env.GOOGLE_TOKEN_FILE;
if (!jobDir || !tokenFile) {
  process.stderr.write('google extension: WCT_JOB_DIR and GOOGLE_TOKEN_FILE must be set\n');
  process.exit(2);
}
const job = JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf8'));
const tools = createGoogleTools({ tokenFile, calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary', job, jobDir });
serveStdio(createMcpHandler({ name: 'google', version: '0.1.0', tools }));
