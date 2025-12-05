import { Hono } from 'hono';
import type { AppType, Idea } from '../types/index.ts';
import { getAuth } from '../lib/auth.ts';
import { findAll, findById, insert, update, softDelete } from '../lib/db.ts';
import { getEncryptionKey, encryptFields, decryptFields } from '../lib/encryption.ts';
import { validate, createIdeaSchema, updateIdeaSchema } from '../lib/validation.ts';
import { NotFoundError, AppError } from '../lib/errors.ts';

const ENCRYPTED_FIELDS = ['title', 'description'];

const ideas = new Hono<AppType>();

// List ideas
ideas.get('/', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const category = c.req.query('category');
  const archived = c.req.query('archived');

  let items = await findAll<Idea>(c.env.DB, 'ideas', {
    tenantId,
    orderBy: 'created_at DESC',
  });

  // Filter by user
  items = items.filter((item) => item.user_id === userId);

  // Optional filters
  if (category) {
    items = items.filter((item) => item.category === category);
  }
  if (archived === 'true') {
    items = items.filter((item) => item.archived_at !== null);
  } else if (archived === 'false') {
    items = items.filter((item) => item.archived_at === null);
  }

  // Decrypt sensitive fields
  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decryptedItems = await Promise.all(
    items.map((item) => decryptFields(item, ENCRYPTED_FIELDS, key))
  );

  return c.json({ success: true, data: decryptedItems });
});

// Get single idea
ideas.get('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const item = await findById<Idea>(c.env.DB, 'ideas', id, { tenantId });

  if (!item || item.user_id !== userId) {
    throw new NotFoundError('Idea', id);
  }

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decrypted = await decryptFields(item, ENCRYPTED_FIELDS, key);

  return c.json({ success: true, data: decrypted });
});

// Create idea
ideas.post('/', async (c) => {
  const { tenantId, userId } = getAuth(c);

  const body = await c.req.json();
  const validated = validate(createIdeaSchema, body);

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const id = crypto.randomUUID();

  const idea: Partial<Idea> = {
    id,
    tenant_id: tenantId,
    user_id: userId,
    title: validated.title,
    description: validated.description ?? null,
    category: validated.category ?? 'random',
    domain: validated.domain ?? null,
    tags: validated.tags ?? null,
    excitement_level: validated.excitement_level ?? null,
    feasibility: validated.feasibility ?? null,
    potential_impact: validated.potential_impact ?? null,
    last_reviewed_at: null,
    next_review_at: null,
    review_count: 0,
    promoted_to_project_id: null,
    archived_at: null,
    archive_reason: null,
    source_inbox_item_id: validated.source_inbox_item_id ?? null,
  };

  const encrypted = await encryptFields(idea, ENCRYPTED_FIELDS, key);
  await insert(c.env.DB, 'ideas', encrypted);

  return c.json({ success: true, data: { id } }, 201);
});

// Update idea
ideas.patch('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  // Verify ownership
  const existing = await findById<Idea>(c.env.DB, 'ideas', id, { tenantId });
  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Idea', id);
  }

  const body = await c.req.json();
  const validated = validate(updateIdeaSchema, body);

  // Increment review count if being reviewed
  if (validated.last_reviewed_at && validated.last_reviewed_at !== existing.last_reviewed_at) {
    (validated as Record<string, unknown>).review_count = (existing.review_count || 0) + 1;
  }

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const encrypted = await encryptFields(validated, ENCRYPTED_FIELDS, key);

  const updated = await update(c.env.DB, 'ideas', id, encrypted, { tenantId });

  if (!updated) {
    throw new AppError('Failed to update idea', 500);
  }

  return c.json({ success: true });
});

// Archive idea
ideas.post('/:id/archive', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  // Verify ownership
  const existing = await findById<Idea>(c.env.DB, 'ideas', id, { tenantId });
  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Idea', id);
  }

  const body = await c.req.json<{ reason?: string }>();

  const updated = await update(c.env.DB, 'ideas', id, {
    archived_at: new Date().toISOString(),
    archive_reason: body.reason ?? null,
  }, { tenantId });

  if (!updated) {
    throw new AppError('Failed to archive idea', 500);
  }

  return c.json({ success: true });
});

// Unarchive idea
ideas.post('/:id/unarchive', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  // Verify ownership
  const existing = await findById<Idea>(c.env.DB, 'ideas', id, { tenantId });
  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Idea', id);
  }

  const updated = await update(c.env.DB, 'ideas', id, {
    archived_at: null,
    archive_reason: null,
  }, { tenantId });

  if (!updated) {
    throw new AppError('Failed to unarchive idea', 500);
  }

  return c.json({ success: true });
});

// Delete idea (soft delete)
ideas.delete('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  // Verify ownership
  const existing = await findById<Idea>(c.env.DB, 'ideas', id, { tenantId });
  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Idea', id);
  }

  const deleted = await softDelete(c.env.DB, 'ideas', id, { tenantId });

  if (!deleted) {
    throw new AppError('Failed to delete idea', 500);
  }

  return c.json({ success: true });
});

export default ideas;
