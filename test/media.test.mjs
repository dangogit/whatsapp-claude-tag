import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { insideRoots, mediaKind, mimeOf, quotedMediaKind, saveMedia, sendKind, synthesize } from '../src/media.mjs';
import { createMcpHandler } from '../src/mcp.mjs';
import { userPrompt, systemPrompt } from '../src/runner.mjs';
import { AccountStore, readActions } from '../src/store.mjs';
import { createTools } from '../src/tools.mjs';
import { FakeClient, OWNER, tmpDir } from './helpers.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const GROUP = '120363000000000001@g.us';

test('media kinds of a record and of the message it quotes', () => {
  assert.equal(mediaKind({ message: { imageMessage: { caption: 'x' } } }), 'image');
  assert.equal(mediaKind({ message: { ephemeralMessage: { message: { audioMessage: {} } } } }), 'audio');
  assert.equal(mediaKind({ message: { conversation: 'hi' } }), '');
  assert.equal(quotedMediaKind({ contextInfo: { quotedMessage: { videoMessage: {} } } }), 'video');
  assert.equal(sendKind('/a/b.PNG'), 'image');
  assert.equal(sendKind('/a/b.ogg'), 'audio');
  assert.equal(sendKind('/a/b.pdf'), 'document');
  assert.equal(mimeOf('/x/y.jpg'), 'image/jpeg');
});

test('files can be sent only from inside the allowed folders, links resolved', () => {
  const root = tmpDir();
  const other = tmpDir();
  fs.writeFileSync(path.join(root, 'ok.png'), 'x');
  fs.writeFileSync(path.join(other, 'secret.txt'), 'x');
  fs.symlinkSync(path.join(other, 'secret.txt'), path.join(root, 'link.txt'));
  assert.equal(insideRoots(path.join(root, 'ok.png'), [root]), true);
  assert.equal(insideRoots(path.join(other, 'secret.txt'), [root]), false);
  assert.equal(insideRoots(path.join(root, 'link.txt'), [root]), false);
  assert.equal(insideRoots(path.join(root, '../', path.basename(other), 'secret.txt'), [root]), false);
});

class MediaClient extends FakeClient {
  async getMediaBase64(_i, id) { return id === 'IMG' ? { base64: PNG.toString('base64'), mimetype: 'image/png' } : { base64: Buffer.from('%PDF').toString('base64'), mimetype: 'application/pdf', fileName: 'a.pdf' }; }
  async sendMedia(instance, number, m) { this.n += 1; const key = { id: `M${this.n}` }; this.sent.push({ number, media: m, key }); return key; }
  async sendVoice(instance, number, b64) { this.n += 1; const key = { id: `V${this.n}` }; this.sent.push({ number, voice: b64.length, key }); return key; }
}

function setup(trigger = {}) {
  const dir = tmpDir();
  const store = new AccountStore(dir, 'p');
  const jobDir = store.jobDir('J');
  const client = new MediaClient({ messages: [{ key: { id: 'DOC', remoteJid: '972599999999@s.whatsapp.net' }, messageTimestamp: 1, message: { documentMessage: {} } }] });
  const job = {
    id: 'J', account: { name: 'p', instance: 'i' }, ownerChat: OWNER, ownerJids: [OWNER], timezone: 'UTC',
    chat: { jid: GROUP, alt: '', name: 'G', isGroup: true, isOwnerChat: false, sendTo: GROUP },
    trigger: { key: { id: 'T' }, request: 'what is in this picture', ...trigger },
  };
  const tools = createTools({ client, store, job, jobDir, getNames: async () => new Map(), roots: [jobDir], media: {} });
  return { tools: Object.fromEntries(tools.map(t => [t.name, t])), client, jobDir, store };
}

test('get_media shows the quoted image to the model as an image block', async () => {
  const { tools, jobDir } = setup({ quotedMediaId: 'IMG', quotedMediaKind: 'image' });
  const handle = createMcpHandler({ name: 'w', version: '1', tools: Object.values(tools) });
  const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_media', arguments: {} } });
  assert.equal(res.result.content[0].type, 'image');
  assert.equal(res.result.content[0].mimeType, 'image/png');
  assert.ok(fs.existsSync(path.join(jobDir, 'media', 'IMG.png')));
  assert.deepEqual(readActions(jobDir).map(a => a.type), ['media']);
});

test('get_media by id refuses a message from a chat the owner did not name', async () => {
  const { tools } = setup();
  await assert.rejects(tools.get_media.handler({ message_id: 'DOC' }), /refused/);
  await assert.rejects(tools.get_media.handler({ message_id: '../x' }), /refused|no message|bad message id/);
});

test('send_file sends from the run folder only and counts as a send', async () => {
  const { tools, client, jobDir } = setup();
  fs.writeFileSync(path.join(jobDir, 'chart.png'), PNG);
  assert.match(await tools.send_file.handler({ chat: 'current', path: path.join(jobDir, 'chart.png'), caption: '@claude done' }), /sent chart.png/);
  assert.equal(client.sent[0].media.mediatype, 'image');
  assert.equal(client.sent[0].media.caption, '@⁠claude done');
  await assert.rejects(tools.send_file.handler({ chat: 'current', path: '/etc/hosts' }), /refused/);
  assert.deepEqual(readActions(jobDir).map(a => [a.type, a.kind]), [['send', 'file']]);
});

test('saveMedia rejects odd ids and writes a private file', async () => {
  const dir = tmpDir();
  await assert.rejects(saveMedia(new MediaClient(), 'i', '../../x', dir), /bad message id/);
  const got = await saveMedia(new MediaClient(), 'i', 'IMG', dir);
  assert.equal(got.kind, 'image');
  assert.equal((fs.statSync(got.file).mode & 0o777).toString(8), '600');
});

test('prompts tell Claude about attached media and voice requests', () => {
  const job = { triggerName: 'claude', account: { name: 'p' }, chat: { jid: 'x', isOwnerChat: true }, timezone: 'UTC', localTime: '',
    trigger: { request: 'what is this', mediaKind: 'image', voice: true } };
  const p = userPrompt(job);
  assert.match(p, /carries a image: open it with get_media/);
  assert.match(p, /voice note/);
  assert.match(systemPrompt(job, [], { fullAccess: true, note: 'You run on a Mac mini.' }), /full access.*\nYou run on a Mac mini\./s);
  assert.doesNotMatch(systemPrompt(job), /full access/);
});

const hasSay = (() => { try { execFileSync('which', ['say']); execFileSync('which', ['ffmpeg']); return true; } catch { return false; } })();
test('synthesize makes an Opus voice note with the system voice', { skip: !hasSay && 'needs macOS say and ffmpeg' }, async () => {
  const dir = tmpDir();
  const ogg = await synthesize('שלום, זו בדיקה', dir, { tts: 'say', ffmpeg: 'ffmpeg', voiceHebrew: 'Carmit', voiceOther: '' });
  assert.ok(fs.statSync(ogg).size > 1000);
  assert.match(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', ogg], { encoding: 'utf8' }), /opus/);
  await assert.rejects(synthesize('', dir, {}), /empty/);
});
