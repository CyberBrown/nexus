import { Hono } from 'hono';
import type { AppType, InboxItem } from '../types/index.ts';
import { getAuth } from '../lib/auth.ts';
import { findAll, findById, insert, update, softDelete } from '../lib/db.ts';
import { getEncryptionKey, encryptFields, decryptFields } from '../lib/encryption.ts';
import { validate, createInboxItemSchema, updateInboxItemSchema } from '../lib/validation.ts';
import { NotFoundError, AppError } from '../lib/errors.ts';

const ENCRYPTED_FIELDS = ['raw_content', 'processed_content'];

const inbox = new Hono<AppType>();

// List inbox items
inbox.get('/', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const status = c.req.query('status');

  let items = await findAll<InboxItem>(c.env.DB, 'inbox_items', {
    tenantId,
    orderBy: 'captured_at DESC',
  });

  // Filter by user and optionally by status
  items = items.filter((item) => item.user_id === userId);
  if (status) {
    items = items.filter((item) => item.status === status);
  }

  // Decrypt sensitive fields
  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decryptedItems = await Promise.all(
    items.map((item) => decryptFields(item, ENCRYPTED_FIELDS, key))
  );

  return c.json({ success: true, data: decryptedItems });
});

// Get single inbox item
inbox.get('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const item = await findById<InboxItem>(c.env.DB, 'inbox_items', id, { tenantId });

  if (!item || item.user_id !== userId) {
    throw new NotFoundError('Inbox item', id);
  }

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decrypted = await decryptFields(item, ENCRYPTED_FIELDS, key);

  return c.json({ success: true, data: decrypted });
});

// Create inbox item
inbox.post('/', async (c) => {
  const { tenantId, userId } = getAuth(c);

  const body = await c.req.json();
  const validated = validate(createInboxItemSchema, body);

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const item: Partial<InboxItem> = {
    id,
    tenant_id: tenantId,
    user_id: userId,
    source_type: validated.source_type,
    source_id: validated.source_id ?? null,
    source_platform: validated.source_platform ?? null,
    raw_content: validated.raw_content,
    processed_content: null,
    ai_classification: null,
    confidence_score: null,
    status: 'pending',
    promoted_to_type: null,
    promoted_to_id: null,
    user_overrides: null,
    captured_at: validated.captured_at ?? now,
    processed_at: null,
  };

  const encrypted = await encryptFields(item, ENCRYPTED_FIELDS, key);
  await insert(c.env.DB, 'inbox_items', encrypted);

  return c.json({ success: true, data: { id } }, 201);
});

// Update inbox item
inbox.patch('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  // Verify ownership
  const existing = await findById<InboxItem>(c.env.DB, 'inbox_items', id, { tenantId });
  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Inbox item', id);
  }

  const body = await c.req.json();
  const validated = validate(updateInboxItemSchema, body);

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const encrypted = await encryptFields(validated, ENCRYPTED_FIELDS, key);

  const updated = await update(c.env.DB, 'inbox_items', id, encrypted, { tenantId });

  if (!updated) {
    throw new AppError('Failed to update inbox item', 500);
  }

  return c.json({ success: true });
});

// Delete inbox item (soft delete)
inbox.delete('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  // Verify ownership
  const existing = await findById<InboxItem>(c.env.DB, 'inbox_items', id, { tenantId });
  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Inbox item', id);
  }

  const deleted = await softDelete(c.env.DB, 'inbox_items', id, { tenantId });

  if (!deleted) {
    throw new AppError('Failed to delete inbox item', 500);
  }

  return c.json({ success: true });
});

export default inbox;
