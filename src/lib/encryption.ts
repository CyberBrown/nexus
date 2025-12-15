// Encryption module - DISABLED after data loss incident
// All functions are now pass-through to avoid future key loss issues
// For a single-user system, encryption adds complexity without significant benefit

/**
 * Get encryption key - returns null (encryption disabled)
 * Callers should handle null by skipping encryption/decryption
 */
export async function getEncryptionKey(kv: KVNamespace, tenantId: string): Promise<CryptoKey | null> {
  // Encryption disabled - return null
  return null;
}

/**
 * Encrypt field - pass-through (encryption disabled)
 * Returns the value unchanged
 */
export async function encryptField(value: string, key: CryptoKey | null): Promise<string> {
  // Encryption disabled - return plaintext
  return value;
}

/**
 * Decrypt field - pass-through (encryption disabled)
 * Returns the value unchanged (handles both encrypted and plaintext data)
 */
export async function decryptField(encrypted: string, key: CryptoKey | null): Promise<string> {
  // Encryption disabled - return as-is
  return encrypted;
}

/**
 * Generate tenant key - no-op (encryption disabled)
 */
export async function generateTenantKey(kv: KVNamespace, tenantId: string): Promise<void> {
  // Encryption disabled - no-op
  return;
}

/**
 * Encrypt multiple fields - pass-through (encryption disabled)
 * Returns the object unchanged
 */
export async function encryptFields<T extends object>(
  obj: T,
  fieldsToEncrypt: string[],
  key: CryptoKey | null
): Promise<T> {
  // Encryption disabled - return unchanged
  return obj;
}

/**
 * Decrypt multiple fields - pass-through (encryption disabled)
 * Returns the object unchanged
 */
export async function decryptFields<T extends object>(
  obj: T,
  fieldsToDecrypt: string[],
  key: CryptoKey | null
): Promise<T> {
  // Encryption disabled - return unchanged
  return obj;
}
