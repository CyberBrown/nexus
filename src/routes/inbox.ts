import { Hono } from 'hono';
import type { AppType, InboxItem, CreateInboxItemInput, UpdateInboxItemInput } from '../types/index.ts';
import { getAuth } from '../lib/auth.ts';
import { findAll, findById, insert, update, softDelete } from '../lib/db.ts';
import { getEncryptionKey, encryptFields, decryptFields } from '../lib/encryption.ts';

const ENCRYPTED_FIELDS = ['raw_content', 'processed_content'];

const inbox = new Hono<AppType>();

// List inbox items
inbox.get('/', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const status = c.req.query('status');

  try {
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
  } catch (error) {
    console.error('Error listing inbox items:', error);
    return c.json({ success: false, error: 'Failed to list inbox items' }, 500);
  }
});

// Get single inbox item
inbox.get('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  try {
    const item = await findById<InboxItem>(c.env.DB, 'inbox_items', id, { tenantId });

    if (!item || item.user_id !== userId) {
      return c.json({ success: false, error: 'Inbox item not found' }, 404);
    }

    const key = await getEncryptionKey(c.env.KV, tenantId);
    const decrypted = await decryptFields(item, ENCRYPTED_FIELDS, key);

    return c.json({ success: true, data: decrypted });
  } catch (error) {
    console.error('Error getting inbox item:', error);
    return c.json({ success: false, error: 'Failed to get inbox item' }, 500);
  }
});

// Create inbox item
inbox.post('/', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const body = await c.req.json<CreateInboxItemInput>();
    const key = await getEncryptionKey(c.env.KV, tenantId);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const item: Partial<InboxItem> = {
      id,
      tenant_id: tenantId,
      user_id: userId,
      source_type: body.source_type,
      source_id: body.source_id ?? null,
      source_platform: body.source_platform ?? null,
      raw_content: body.raw_content,
      processed_content: body.processed_content ?? null,
      ai_classification: body.ai_classification ?? null,
      confidence_score: body.confidence_score ?? null,
      status: body.status ?? 'pending',
      promoted_to_type: null,
      promoted_to_id: null,
      user_overrides: body.user_overrides ?? null,
      captured_at: body.captured_at ?? now,
      processed_at: body.processed_at ?? null,
    };

    const encrypted = await encryptFields(item, ENCRYPTED_FIELDS, key);
    await insert(c.env.DB, 'inbox_items', encrypted);

    return c.json({ success: true, data: { id } }, 201);
  } catch (error) {
    console.error('Error creating inbox item:', error);
    return c.json({ success: false, error: 'Failed to create inbox item' }, 500);
  }
});

// Update inbox item
inbox.patch('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  try {
    // Verify ownership
    const existing = await findById<InboxItem>(c.env.DB, 'inbox_items', id, { tenantId });
    if (!existing || existing.user_id !== userId) {
      return c.json({ success: false, error: 'Inbox item not found' }, 404);
    }

    const body = await c.req.json<UpdateInboxItemInput>();
    const key = await getEncryptionKey(c.env.KV, tenantId);
    const encrypted = await encryptFields(body, ENCRYPTED_FIELDS, key);

    const updated = await update(c.env.DB, 'inbox_items', id, encrypted, { tenantId });

    if (!updated) {
      return c.json({ success: false, error: 'Failed to update inbox item' }, 500);
    }

    return c.json({ success: true });
  } catch (error) {
    console.error('Error updating inbox item:', error);
    return c.json({ success: false, error: 'Failed to update inbox item' }, 500);
  }
});

// Delete inbox item (soft delete)
inbox.delete('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  try {
    // Verify ownership
    const existing = await findById<InboxItem>(c.env.DB, 'inbox_items', id, { tenantId });
    if (!existing || existing.user_id !== userId) {
      return c.json({ success: false, error: 'Inbox item not found' }, 404);
    }

    const deleted = await softDelete(c.env.DB, 'inbox_items', id, { tenantId });

    if (!deleted) {
      return c.json({ success: false, error: 'Failed to delete inbox item' }, 500);
    }

    return c.json({ success: true });
  } catch (error) {
    console.error('Error deleting inbox item:', error);
    return c.json({ success: false, error: 'Failed to delete inbox item' }, 500);
  }
});

export default inbox;
