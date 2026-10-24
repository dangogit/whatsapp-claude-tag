#!/usr/bin/env node
// Creates an Evolution instance (if missing) and pairs it with your phone by QR.
//
//   node deploy/evolution/pair.mjs --instance personal [--url http://127.0.0.1:8080] [--env-file deploy/evolution/.env]
//
// The API key comes from EVOLUTION_API_KEY, or from AUTHENTICATION_API_KEY in --env-file.
// The QR is written to qr-<instance>.png next to this script and opened when possible.
// On the phone: WhatsApp > Settings > Linked devices > Link a device, then scan it.
// Exits 0 once the instance is "open", 1 on error, 2 when pairing timed out.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from '../../src/config.mjs';
import { EvolutionClient } from '../../src/evolution.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WAIT_MS = 3 * 60 * 1000;
const QR_REFRESH_MS = 20 * 1000;

function parseArgs(argv) {
  const args = { url: 'http://127.0.0.1:8080', instance: '', envFile: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--url') args.url = argv[++i];
    else if (a === '--instance') args.instance = argv[++i];
    else if (a === '--env-file') args.envFile = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(args.instance || '')) throw new Error('--instance <name> is required (letters, digits, - and _)');
  return args;
}

function apiKey(args) {
  if (process.env.EVOLUTION_API_KEY) return process.env.EVOLUTION_API_KEY;
  const file = args.envFile || path.join(HERE, '.env');
  if (fs.existsSync(file)) return readEnvFile(file).AUTHENTICATION_API_KEY || '';
  return '';
}

// Set WCT_NO_OPEN=1 on a headless server and copy the PNG over yourself.
function openFile(file) {
  if (process.env.WCT_NO_OPEN === '1') return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    const child = spawn(cmd, [file], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* no viewer: the path is printed anyway */ }
}

async function exists(client, instance) {
  const list = await client.request('GET', '/instance/fetchInstances');
  return (Array.isArray(list) ? list : []).some(i => i?.name === instance || i?.instance?.instanceName === instance);
}

async function writeQr(client, instance) {
  const data = await client.request('GET', `/instance/connect/${encodeURIComponent(instance)}`);
  const b64 = String(data?.base64 || '').replace(/^data:image\/png;base64,/, '');
  if (!b64) return '';
  const file = path.join(HERE, `qr-${instance}.png`);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const key = apiKey(args);
  if (!key) throw new Error('no API key: set EVOLUTION_API_KEY or pass --env-file with AUTHENTICATION_API_KEY');
  const client = new EvolutionClient({ url: args.url, apiKey: key });

  if (await exists(client, args.instance)) {
    console.log(`instance ${args.instance} exists`);
  } else {
    await client.request('POST', '/instance/create', { instanceName: args.instance, integration: 'WHATSAPP-BAILEYS', qrcode: true });
    console.log(`created instance ${args.instance}`);
  }
  if (await client.connectionState(args.instance) === 'open') {
    console.log(`${args.instance} is already connected`);
    return 0;
  }

  const deadline = Date.now() + WAIT_MS;
  let lastQr = 0;
  let opened = false;
  while (Date.now() < deadline) {
    if (Date.now() - lastQr > QR_REFRESH_MS) {
      const file = await writeQr(client, args.instance);
      if (file) {
        lastQr = Date.now();
        console.log(`QR written to ${file}. Scan it: WhatsApp > Settings > Linked devices > Link a device.`);
        if (!opened) { openFile(file); opened = true; }
      } else {
        console.log('no QR yet (is Redis running?), retrying');
      }
    }
    await new Promise(r => setTimeout(r, 3000));
    const state = await client.connectionState(args.instance);
    if (state === 'open') {
      fs.rmSync(path.join(HERE, `qr-${args.instance}.png`), { force: true });
      console.log(`${args.instance} is connected`);
      return 0;
    }
  }
  console.log(`not connected after ${WAIT_MS / 60000} minutes; run this again for a fresh QR`);
  return 2;
}

main().then(code => { process.exitCode = code; }, err => {
  console.error(`pair: ${err.message}`);
  process.exitCode = 1;
});
