// Minimal Evolution API v2 client: only the calls this tool needs.

export class EvolutionClient {
  constructor({ url, apiKey, fetchImpl = globalThis.fetch }) {
    if (!url) throw new Error('Evolution url is required');
    if (!apiKey) throw new Error('Evolution apiKey is required');
    this.url = url.replace(/\/+$/, '');
    this.fetch = fetchImpl;
    Object.defineProperty(this, 'apiKey', { value: apiKey, enumerable: false });
  }

  async request(method, path, body, timeoutMs = 30_000) {
    const res = await this.fetch(this.url + path, {
      method,
      headers: { apikey: this.apiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const detail = typeof data === 'string' ? data : JSON.stringify(data);
      throw new Error(`Evolution ${method} ${path} -> HTTP ${res.status}: ${String(detail).slice(0, 300)}`);
    }
    return data;
  }

  // Newest first. Evolution pages with `page` and uses `offset` as the page size.
  async findMessages(instance, where = {}, limit = 50, page = 1) {
    const data = await this.request('POST', `/chat/findMessages/${enc(instance)}`, { where, page, offset: limit });
    const msgs = data?.messages ?? data;
    const records = Array.isArray(msgs?.records) ? msgs.records : Array.isArray(msgs) ? msgs : [];
    return records.slice(0, limit);
  }

  async findContacts(instance) {
    const data = await this.request('POST', `/chat/findContacts/${enc(instance)}`, { where: {} });
    return Array.isArray(data) ? data : [];
  }

  // Slow on numbers with many groups (over a minute for ~150); callers cache it.
  async fetchGroups(instance) {
    const data = await this.request('GET', `/group/fetchAllGroups/${enc(instance)}?getParticipants=false`, null, 180_000);
    const groups = Array.isArray(data) ? data : Array.isArray(data?.groups) ? data.groups : [];
    return groups.map(g => ({ id: g.id || g.jid, subject: g.subject || '' })).filter(g => g.id);
  }

  async ownerJid(instance) {
    const data = await this.request('GET', `/instance/fetchInstances?instanceName=${enc(instance)}`);
    const list = Array.isArray(data) ? data : [data];
    const hit = list.find(i => i?.name === instance || i?.instance?.instanceName === instance) || list[0];
    return hit?.ownerJid || hit?.instance?.owner || '';
  }

  async connectionState(instance) {
    const data = await this.request('GET', `/instance/connectionState/${enc(instance)}`, null, 10_000);
    return data?.instance?.state || 'unknown';
  }

  // Returns the sent message key.
  async sendText(instance, number, text, { quotedId } = {}) {
    const body = { number, text };
    if (quotedId) body.quoted = { key: { id: quotedId } };
    const data = await this.request('POST', `/message/sendText/${enc(instance)}`, body, 60_000);
    return data?.key || {};
  }

  // { base64, mimetype, fileName } of a media message. Evolution fetches it again from WhatsApp.
  // key: a message id, or the full key ({ id, remoteJid, fromMe, participant }) to pin the chat.
  async getMediaBase64(instance, key) {
    const k = typeof key === 'string' ? { id: key } : key;
    return this.request('POST', `/chat/getBase64FromMediaMessage/${enc(instance)}`,
      { message: { key: k }, convertToMp4: false }, 120_000);
  }

  // mediatype: image | video | audio | document. Returns the sent message key.
  async sendMedia(instance, number, { mediatype, mimetype, base64, fileName, caption }) {
    const body = { number, mediatype, mimetype, media: base64, fileName, ...(caption ? { caption } : {}) };
    const data = await this.request('POST', `/message/sendMedia/${enc(instance)}`, body, 120_000);
    return data?.key || {};
  }

  // A voice note (push-to-talk) from Opus/OGG or any audio Evolution can convert.
  async sendVoice(instance, number, base64) {
    const data = await this.request('POST', `/message/sendWhatsAppAudio/${enc(instance)}`, { number, audio: base64 }, 120_000);
    return data?.key || {};
  }

  async deleteForEveryone(instance, key) {
    const body = { id: key.id, remoteJid: key.remoteJid, fromMe: key.fromMe === true };
    if (key.participant) body.participant = key.participant;
    return this.request('DELETE', `/chat/deleteMessageForEveryone/${enc(instance)}`, body);
  }
}

function enc(s) {
  return encodeURIComponent(s);
}
