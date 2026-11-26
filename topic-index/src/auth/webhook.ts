// ダミーのコネクタの Webhook の署名（HMAC-SHA256、hex）。鍵はトピック索引の設定の webhookSecret。

/** Webhook の署名（HMAC-SHA256、hex）。鍵は本体の Workers secret に置く */
export async function verifyWebhookSignature(body: string, signatureHex: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sig = hexToBytes(signatureHex);
  if (!sig) return false;
  return crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(body));
}

export async function signWebhook(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
