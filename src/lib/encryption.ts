// AES-256-GCM encryption for sensitive fields
// Key stored in KV, referenced by tenant

export async function getEncryptionKey(kv: KVNamespace, tenantId: string): Promise<CryptoKey> {
  const keyData = await kv.get(`tenant:${tenantId}:key`, 'arrayBuffer');
  if (!keyData) {
    throw new Error('Encryption key not found for tenant');
  }

  return crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptField(value: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(value);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);

  return btoa(String.fromCharCode(...combined));
}

export async function decryptField(encrypted: string, key: CryptoKey): Promise<string> {
  const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  return new TextDecoder().decode(decrypted);
}

export async function generateTenantKey(kv: KVNamespace, tenantId: string): Promise<void> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  await kv.put(`tenant:${tenantId}:key`, key);
}

// Helper to encrypt multiple fields at once
export async function encryptFields<T extends object>(
  obj: T,
  fieldsToEncrypt: string[],
  key: CryptoKey
): Promise<T> {
  const result = { ...obj } as Record<string, unknown>;
  for (const field of fieldsToEncrypt) {
    const value = result[field];
    if (typeof value === 'string' && value) {
      result[field] = await encryptField(value, key);
    }
  }
  return result as T;
}

// Helper to decrypt multiple fields at once
export async function decryptFields<T extends object>(
  obj: T,
  fieldsToDecrypt: string[],
  key: CryptoKey
): Promise<T> {
  const result = { ...obj } as Record<string, unknown>;
  for (const field of fieldsToDecrypt) {
    const value = result[field];
    if (typeof value === 'string' && value) {
      try {
        result[field] = await decryptField(value, key);
      } catch {
        // If decryption fails, keep original value (might be unencrypted)
      }
    }
  }
  return result as T;
}
