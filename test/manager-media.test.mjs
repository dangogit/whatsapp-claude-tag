import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeConfig } from '../src/config.mjs';
import { EvolutionClient } from '../src/evolution.mjs';
import { managerAttachmentsValid, managerMediaRecord, prepareManagerAttachment, MANAGER_MEDIA_LIMITS } from '../src/manager-media.mjs';
import { OWNER, tmpDir } from './helpers.mjs';

const scope = { account: { name: 'business', instance: 'biz' }, actorId: OWNER };
const config = () => normalizeConfig({ stateDir: tmpDir(), accounts: [{ name: 'business', instance: 'biz' }] }, { EVOLUTION_API_KEY: 'test' });
const record = (type, mimetype, extra = {}) => ({ key: { id: 'MEDIA', remoteJid: OWNER, fromMe: false },
  message: { [type]: { mimetype, ...extra } } });
const provider = (bytes, mimetype) => ({ calls: [], async getMediaBase64(instance, key, limits) {
  this.calls.push({ instance, key, limits }); return { base64: bytes.toString('base64'), mimetype };
} });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const commandAvailable = name => { try { execFileSync(name, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } };
const ffmpeg = commandAvailable('ffmpeg');

test('TXT and CSV are decoded locally, exact provider key is pinned and receipts stay private', async () => {
  for (const mimetype of ['text/plain', 'text/csv']) {
    const cfg = config(), rec = record('documentMessage', mimetype, { fileName: '../../private\u202e.txt' });
    const client = provider(Buffer.from('שם,ערך\nדוגמה,42'), mimetype);
    const item = await prepareManagerAttachment(cfg, client, scope, rec, { current: true });
    assert.equal(item.status, 'ready'); assert.match(item.text, /דוגמה,42/);
    assert.equal(item.name, 'private.txt'); assert.equal(item.commandEligible, false);
    assert.equal(client.calls[0].instance, 'biz'); assert.deepEqual(client.calls[0].key, rec.key);
    assert.ok(client.calls[0].limits.maxBytes < 22 * 1024 * 1024);
    assert.doesNotMatch(JSON.stringify(item), /\/Users|\/tmp|\.\.\//);
    const dir = path.join(cfg.stateDir, 'manager-media', 'records', item.id);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, 'source')).mode & 0o777, 0o600);
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'attachment.json'))).receipt;
    assert.deepEqual(receipt, { account: scope.account, actorId: OWNER, key: rec.key });
    assert.deepEqual(await prepareManagerAttachment(cfg, client, scope, rec, { current: true }), item);
    assert.equal(client.calls.length, 1, 'identical retries reuse immutable preparation');
    rec.message.documentMessage.fileLength = 123;
    await assert.rejects(prepareManagerAttachment(cfg, client, scope, rec), /identity conflict/);
  }
});

test('reject oversized declarations before download and malformed, mismatched or binary content', async () => {
  const cases = [
    ['size_limit', record('documentMessage', 'text/plain', { fileLength: MANAGER_MEDIA_LIMITS.bytes + 1 }), Buffer.from('ok'), 'text/plain'],
    ['invalid_content', record('documentMessage', 'text/plain'), Buffer.from([0xff, 0xfe]), 'text/plain'],
    ['invalid_content', record('documentMessage', 'text/plain'), Buffer.from('a\0b'), 'text/plain'],
    ['mime_mismatch', record('imageMessage', 'image/png'), Buffer.from('%PDF-1.4\n'), 'image/png'],
    ['text_limit', record('documentMessage', 'text/plain'), Buffer.alloc(MANAGER_MEDIA_LIMITS.textBytes + 1, 'a'), 'text/plain'],
    ['empty_content', record('documentMessage', 'text/plain'), Buffer.from('  '), 'text/plain'],
    ['invalid_content', record('documentMessage', 'text/plain', { fileSha256: Buffer.alloc(32).toString('base64') }), Buffer.from('wrong digest'), 'text/plain'],
  ];
  for (const [reason, rec, bytes, type] of cases) {
    const client = provider(bytes, type), item = await prepareManagerAttachment(config(), client, scope, rec);
    assert.equal(item.status, 'failed'); assert.equal(item.reason, reason);
    assert.equal(item.text, undefined); assert.equal(item.images, undefined); assert.equal(item.commandEligible, false);
    if (reason === 'size_limit') assert.equal(client.calls.length, 0);
  }
  const c = { async getMediaBase64() { return { base64: '%%%%', mimetype: 'text/plain' }; } };
  assert.equal((await prepareManagerAttachment(config(), c, scope, record('documentMessage', 'text/plain'))).reason, 'invalid_content');
});

test('unsupported video and download/tool errors are explicit and never leak raw errors', async () => {
  let downloaded = false;
  const client = { async getMediaBase64() { downloaded = true; throw new Error('/private/token secret diagnostic'); } };
  const video = await prepareManagerAttachment(config(), client, scope, record('videoMessage', 'video/mp4'));
  assert.equal(video.status, 'unsupported'); assert.equal(video.reason, 'unsupported_type'); assert.equal(downloaded, false);
  const failed = await prepareManagerAttachment(config(), client, scope, record('documentMessage', 'text/plain'));
  assert.equal(failed.reason, 'download_failed'); assert.doesNotMatch(JSON.stringify(failed), /secret|private|token/);
});

test('forwarding metadata on any wrapper prevents owner voice command status', () => {
  const rec = record('audioMessage', 'audio/ogg', { ptt: true });
  assert.equal(managerMediaRecord(rec).ownVoice, true);
  rec.contextInfo = { forwardingScore: 1 }; assert.equal(managerMediaRecord(rec).ownVoice, false);
  delete rec.contextInfo;
  rec.message.audioMessage.contextInfo = { isForwarded: true }; assert.equal(managerMediaRecord(rec).ownVoice, false);
  delete rec.message.audioMessage.contextInfo;
  rec.message = { ephemeralMessage: { contextInfo: { isForwarded: true }, message: rec.message } };
  assert.equal(managerMediaRecord(rec).ownVoice, false);
});

test('optional envelope is strict, bounded, path-free and rejects command authority on quote/audio failures', async () => {
  const item = await prepareManagerAttachment(config(), provider(Buffer.from('notes'), 'text/plain'), scope, record('documentMessage', 'text/plain'));
  const valid = { schemaVersion: 1, items: [item] };
  assert.equal(managerAttachmentsValid(valid, 'MEDIA'), true);
  for (const mutate of [v => { v.path = '/secret'; }, v => { v.items[0].path = '/secret'; }, v => { v.items[0].commandEligible = true; },
    v => { v.items[0].text = 'a'.repeat(24577); }, v => { v.items.push(v.items[0]); }, v => { v.items[0].reason = 'error'; },
    v => { v.items[0].id = [v.items[0].id]; }, v => { delete v.items[0].sha256; }]) {
    const changed = structuredClone(valid); mutate(changed); assert.equal(managerAttachmentsValid(changed, 'MEDIA'), false);
  }
});

test('Evolution bounds streamed media response and sends the complete original key', async () => {
  let body, pulled = 0;
  const client = new EvolutionClient({ url: 'http://localhost', apiKey: 'test', fetchImpl: async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, body: (async function* () { for (let i = 0; i < 10; i++) { pulled++; yield Buffer.alloc(20, 32); } })() };
  } });
  const rec = record('imageMessage', 'image/png');
  await assert.rejects(client.getMediaBase64('biz', rec.key, { maxBytes: 32 }), /exceeds limit/);
  assert.equal(pulled, 2); assert.deepEqual(body.message.key, rec.key);
});

test('actual local ffmpeg creates a bounded private PNG reference and rejects cache tampering', { skip: !ffmpeg }, async () => {
  const cfg = config(), image = path.join(cfg.stateDir, 'fixture.png');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', image]);
  const rec = record('imageMessage', 'image/png'), client = provider(fs.readFileSync(image), 'image/png');
  const item = await prepareManagerAttachment(cfg, client, scope, rec, { current: true });
  assert.equal(item.status, 'ready', item.reason); assert.equal(item.images.length, 1); assert.equal(item.text, undefined);
  const blob = item.images[0], file = path.join(cfg.stateDir, 'manager-media', 'blobs', `${blob.id}.png`);
  assert.equal(blob.sha256, sha(fs.readFileSync(file))); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, 'tampered');
  await assert.rejects(prepareManagerAttachment(cfg, client, scope, rec), /blob changed/);
});

test('audio decoding checks actual duration and only current own PTT may carry command text', { skip: !ffmpeg }, async () => {
  const cfg = config(), audio = path.join(cfg.stateDir, 'fixture.wav');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.1', audio]);
  cfg.media.whisperModel = path.join(cfg.stateDir, 'model.fixture'); fs.writeFileSync(cfg.media.whisperModel, 'fixture');
  cfg.media.whisperCli = path.join(cfg.stateDir, 'whisper-fixture');
  fs.writeFileSync(cfg.media.whisperCli, '#!/bin/sh\nprintf "Please inspect the project status.\\n"\n', { mode: 0o700 });
  const bytes = fs.readFileSync(audio), client = provider(bytes, 'audio/wav'), rec = record('audioMessage', 'audio/wav', { ptt: true });
  const current = await prepareManagerAttachment(cfg, client, scope, rec, { current: true });
  assert.equal(current.status, 'ready', current.reason); assert.equal(current.commandEligible, true);
  assert.equal(current.text, 'Please inspect the project status.');
  const quote = await prepareManagerAttachment(cfg, client, scope, rec, { current: false });
  assert.equal(quote.commandEligible, false); assert.equal(client.calls.length, 1);
  const forwarded = record('audioMessage', 'audio/wav', { ptt: true, contextInfo: { isForwarded: true } }); forwarded.key.id = 'FORWARDED';
  assert.equal((await prepareManagerAttachment(cfg, client, scope, forwarded, { current: true })).commandEligible, false);
  const long = record('audioMessage', 'audio/wav', { ptt: true }); long.key.id = 'LONG';
  const result = await prepareManagerAttachment(cfg, client, scope, long, { current: true, invoke: async (_cmd, args) => {
    const dest = args.at(-1); fs.writeFileSync(dest, ''); fs.truncateSync(dest, (MANAGER_MEDIA_LIMITS.seconds + 1) * 32000);
  } });
  assert.equal(result.reason, 'duration_limit'); assert.equal(result.commandEligible, false);
});

// Small synthetic PDF with real cross-reference offsets, no customer content.
function pdf(pages, text = '') {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (let page = 0; page < pages; page++) {
    const id = objects.length + 1; kids.push(`${id} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`);
    const stream = text ? `BT /F1 12 Tf 20 100 Td (${text}) Tj ET` : '0 0 0 rg 20 20 100 100 re f';
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  let output = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  output += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
const poppler = (() => { try { execFileSync('pdfinfo', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('actual PDF text extraction, scanned-page rendering and page limit', { skip: !poppler }, async () => {
  for (const [pages, text, expected] of [[1, 'A complete synthetic document for reading.', 'text'], [2, '', 'images'], [13, '', 'page_limit']]) {
    const cfg = config(), rec = record('documentMessage', 'application/pdf', { fileName: 'example.pdf' });
    const item = await prepareManagerAttachment(cfg, provider(pdf(pages, text), 'application/pdf'), scope, rec);
    if (expected === 'page_limit') { assert.equal(item.reason, expected); continue; }
    assert.equal(item.status, 'ready', item.reason);
    if (expected === 'text') { assert.match(item.text, /complete synthetic document/); assert.equal(item.images, undefined); }
    else { assert.equal(item.images.length, 2); assert.equal(item.text, '[Page 1: image 1]\n\n[Page 2: image 2]'); }
  }
});

test('actual DOCX local extraction rejects ZIP traversal, macros and expansion bombs', async () => {
  for (const kind of ['normal', 'traversal', 'macro', 'bomb', 'doctype']) {
    const cfg = config(), file = path.join(cfg.stateDir, 'fixture.docx');
    execFileSync('python3', ['-I', '-c', `import sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('[Content_Types].xml','<Types/>')
 xml='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Example table and paragraph</w:t></w:r></w:p></w:body></w:document>'
 z.writestr('word/document.xml', ('<!DOCTYPE x>' if sys.argv[2]=='doctype' else '')+xml)
 if sys.argv[2]=='traversal': z.writestr('../escape','bad')
 if sys.argv[2]=='macro': z.writestr('word/vbaProject.bin','bad')
 if sys.argv[2]=='bomb': z.writestr('word/large.xml','a'*2000000)
`, file, kind]);
    const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const item = await prepareManagerAttachment(cfg, provider(fs.readFileSync(file), mime), scope, record('documentMessage', mime));
    if (kind === 'normal') { assert.equal(item.status, 'ready', item.reason); assert.equal(item.text, 'Example table and paragraph'); }
    else { assert.equal(item.status, 'failed'); assert.ok(['active_content', 'archive_limit'].includes(item.reason), item.reason); }
    assert.equal(fs.existsSync(path.join(cfg.stateDir, 'escape')), false);
  }
});
