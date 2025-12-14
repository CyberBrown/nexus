import { Hono } from 'hono';
import type { AppType, Note } from '../types/index.ts';
import { getAuth } from '../lib/auth.ts';
import { findAll, findById, insert, update, softDelete } from '../lib/db.ts';
import { getEncryptionKey, encryptFields, decryptFields } from '../lib/encryption.ts';
import { validate, createNoteSchema, updateNoteSchema } from '../lib/validation.ts';
import { NotFoundError } from '../lib/errors.ts';

const ENCRYPTED_FIELDS = ['title', 'content'];

const notes = new Hono<AppType>();

// List notes
notes.get('/', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const category = c.req.query('category');
  const archived = c.req.query('archived');
  const pinned = c.req.query('pinned');
  const search = c.req.query('search');
  const source_type = c.req.query('source_type');

  let items = await findAll<Note>(c.env.DB, 'notes', {
    tenantId,
    orderBy: 'pinned DESC, created_at DESC',
  });

  // Filter by user
  items = items.filter((item) => item.user_id === userId);

  // Optional filters
  if (category) {
    items = items.filter((item) => item.category === category);
  }
  if (archived === 'true') {
    items = items.filter((item) => item.archived_at !== null);
  } else if (archived === 'false' || !archived) {
    // Default: exclude archived
    items = items.filter((item) => item.archived_at === null);
  }
  if (pinned === 'true') {
    items = items.filter((item) => item.pinned === 1);
  }
  if (source_type) {
    items = items.filter((item) => item.source_type === source_type);
  }

  // Decrypt sensitive fields
  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decryptedItems = await Promise.all(
    items.map((item) => decryptFields(item, ENCRYPTED_FIELDS, key))
  );

  // Search filter (after decryption)
  let filteredItems = decryptedItems;
  if (search) {
    const searchLower = search.toLowerCase();
    filteredItems = decryptedItems.filter(
      (item) =>
        (item.title && item.title.toLowerCase().includes(searchLower)) ||
        (item.content && item.content.toLowerCase().includes(searchLower))
    );
  }

  return c.json({ success: true, data: filteredItems });
});

// Get single note
notes.get('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const item = await findById<Note>(c.env.DB, 'notes', id, { tenantId });

  if (!item || item.user_id !== userId) {
    throw new NotFoundError('Note', id);
  }

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decrypted = await decryptFields(item, ENCRYPTED_FIELDS, key);

  return c.json({ success: true, data: decrypted });
});

// Create note
notes.post('/', async (c) => {
  const { tenantId, userId } = getAuth(c);

  const body = await c.req.json();
  const validated = validate(createNoteSchema, body);

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const id = crypto.randomUUID();

  const note: Partial<Note> = {
    id,
    tenant_id: tenantId,
    user_id: userId,
    title: validated.title,
    content: validated.content ?? null,
    category: validated.category ?? 'general',
    tags: validated.tags ?? null,
    source_type: validated.source_type ?? null,
    source_reference: validated.source_reference ?? null,
    source_context: validated.source_context ?? null,
    pinned: validated.pinned ? 1 : 0,
    archived_at: null,
  };

  const encrypted = await encryptFields(note, ENCRYPTED_FIELDS, key);
  await insert(c.env.DB, 'notes', encrypted);

  return c.json({ success: true, data: { id } }, 201);
});

// Update note
notes.patch('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const existing = await findById<Note>(c.env.DB, 'notes', id, { tenantId });

  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Note', id);
  }

  const body = await c.req.json();
  const validated = validate(updateNoteSchema, body);

  const key = await getEncryptionKey(c.env.KV, tenantId);

  const updates: Partial<Note> = {};

  if (validated.title !== undefined) updates.title = validated.title;
  if (validated.content !== undefined) updates.content = validated.content;
  if (validated.category !== undefined) updates.category = validated.category;
  if (validated.tags !== undefined) updates.tags = validated.tags;
  if (validated.source_type !== undefined) updates.source_type = validated.source_type;
  if (validated.source_reference !== undefined) updates.source_reference = validated.source_reference;
  if (validated.source_context !== undefined) updates.source_context = validated.source_context;
  if (validated.pinned !== undefined) updates.pinned = validated.pinned ? 1 : 0;
  if (validated.archived_at !== undefined) updates.archived_at = validated.archived_at;

  if (Object.keys(updates).length > 0) {
    const encrypted = await encryptFields(updates, ENCRYPTED_FIELDS, key);
    await update(c.env.DB, 'notes', id, encrypted, { tenantId });
  }

  return c.json({ success: true, data: { id } });
});

// Delete note (soft delete)
notes.delete('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const existing = await findById<Note>(c.env.DB, 'notes', id, { tenantId });

  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Note', id);
  }

  await softDelete(c.env.DB, 'notes', id, { tenantId });

  return c.json({ success: true, data: { id } });
});

// Archive note
notes.post('/:id/archive', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const existing = await findById<Note>(c.env.DB, 'notes', id, { tenantId });

  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Note', id);
  }

  await update(c.env.DB, 'notes', id, { archived_at: new Date().toISOString() }, { tenantId });

  return c.json({ success: true, data: { id, archived: true } });
});

// Unarchive note
notes.post('/:id/unarchive', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const existing = await findById<Note>(c.env.DB, 'notes', id, { tenantId });

  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Note', id);
  }

  await update(c.env.DB, 'notes', id, { archived_at: null }, { tenantId });

  return c.json({ success: true, data: { id, archived: false } });
});

// Pin/unpin note
notes.post('/:id/pin', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const existing = await findById<Note>(c.env.DB, 'notes', id, { tenantId });

  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Note', id);
  }

  const newPinned = existing.pinned === 1 ? 0 : 1;
  await update(c.env.DB, 'notes', id, { pinned: newPinned }, { tenantId });

  return c.json({ success: true, data: { id, pinned: newPinned === 1 } });
});

export default notes;
