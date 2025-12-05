import { Hono } from 'hono';
import type { AppType, Commitment } from '../types/index.ts';
import { getAuth } from '../lib/auth.ts';
import { findAll, findById, insert, update, softDelete } from '../lib/db.ts';
import { getEncryptionKey, encryptFields, decryptFields } from '../lib/encryption.ts';
import { validate, createCommitmentSchema, updateCommitmentSchema } from '../lib/validation.ts';
import { NotFoundError, AppError } from '../lib/errors.ts';

const ENCRYPTED_FIELDS = ['description'];

const commitments = new Hono<AppType>();

// List commitments
commitments.get('/', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const direction = c.req.query('direction') as 'waiting_for' | 'owed_to' | undefined;
  const status = c.req.query('status') as 'open' | 'fulfilled' | 'cancelled' | undefined;
  const personId = c.req.query('person_id');

  let items = await findAll<Commitment>(c.env.DB, 'commitments', {
    tenantId,
    orderBy: 'requested_at DESC',
  });

  // Filter by user
  items = items.filter((item) => item.user_id === userId);

  // Optional filters
  if (direction) {
    items = items.filter((item) => item.direction === direction);
  }
  if (status) {
    items = items.filter((item) => item.status === status);
  }
  if (personId) {
    items = items.filter((item) => item.person_id === personId);
  }

  // Decrypt sensitive fields
  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decryptedItems = await Promise.all(
    items.map((item) => decryptFields(item, ENCRYPTED_FIELDS, key))
  );

  return c.json({ success: true, data: decryptedItems });
});

// Get single commitment
commitments.get('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const item = await findById<Commitment>(c.env.DB, 'commitments', id, { tenantId });

  if (!item || item.user_id !== userId) {
    throw new NotFoundError('Commitment', id);
  }

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decrypted = await decryptFields(item, ENCRYPTED_FIELDS, key);

  return c.json({ success: true, data: decrypted });
});

// Create commitment
commitments.post('/', async (c) => {
  const { tenantId, userId } = getAuth(c);

  const body = await c.req.json();
  const validated = validate(createCommitmentSchema, body);

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const commitment: Partial<Commitment> = {
    id,
    tenant_id: tenantId,
    user_id: userId,
    direction: validated.direction,
    person_id: validated.person_id ?? null,
    person_name: validated.person_name ?? null,
    description: validated.description,
    context_type: validated.context_type ?? null,
    context_reference: validated.context_reference ?? null,
    requested_at: validated.requested_at ?? now,
    due_date: validated.due_date ?? null,
    reminded_at: null,
    reminder_count: 0,
    status: 'open',
    fulfilled_at: null,
    task_id: validated.task_id ?? null,
  };

  const encrypted = await encryptFields(commitment, ENCRYPTED_FIELDS, key);
  await insert(c.env.DB, 'commitments', encrypted);

  return c.json({ success: true, data: { id } }, 201);
});

// Update commitment
commitments.patch('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  // Verify ownership
  const existing = await findById<Commitment>(c.env.DB, 'commitments', id, { tenantId });
  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Commitment', id);
  }

  const body = await c.req.json();
  const validated = validate(updateCommitmentSchema, body);

  // Handle fulfillment
  if (validated.status === 'fulfilled' && existing.status !== 'fulfilled') {
    validated.fulfilled_at = new Date().toISOString();
  }

  // Track reminders
  if (validated.reminded_at && validated.reminded_at !== existing.reminded_at) {
    (validated as Record<string, unknown>).reminder_count = (existing.reminder_count || 0) + 1;
  }

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const encrypted = await encryptFields(validated, ENCRYPTED_FIELDS, key);

  const updated = await update(c.env.DB, 'commitments', id, encrypted, { tenantId });

  if (!updated) {
    throw new AppError('Failed to update commitment', 500);
  }

  return c.json({ success: true });
});

// Fulfill commitment (convenience endpoint)
commitments.post('/:id/fulfill', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  // Verify ownership
  const existing = await findById<Commitment>(c.env.DB, 'commitments', id, { tenantId });
  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Commitment', id);
  }

  if (existing.status !== 'open') {
    throw new AppError('Commitment is not open', 400);
  }

  const updated = await update(c.env.DB, 'commitments', id, {
    status: 'fulfilled',
    fulfilled_at: new Date().toISOString(),
  }, { tenantId });

  if (!updated) {
    throw new AppError('Failed to fulfill commitment', 500);
  }

  return c.json({ success: true });
});

// Cancel commitment (convenience endpoint)
commitments.post('/:id/cancel', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  // Verify ownership
  const existing = await findById<Commitment>(c.env.DB, 'commitments', id, { tenantId });
  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Commitment', id);
  }

  if (existing.status !== 'open') {
    throw new AppError('Commitment is not open', 400);
  }

  const updated = await update(c.env.DB, 'commitments', id, {
    status: 'cancelled',
  }, { tenantId });

  if (!updated) {
    throw new AppError('Failed to cancel commitment', 500);
  }

  return c.json({ success: true });
});

// Delete commitment (soft delete)
commitments.delete('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  // Verify ownership
  const existing = await findById<Commitment>(c.env.DB, 'commitments', id, { tenantId });
  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Commitment', id);
  }

  const deleted = await softDelete(c.env.DB, 'commitments', id, { tenantId });

  if (!deleted) {
    throw new AppError('Failed to delete commitment', 500);
  }

  return c.json({ success: true });
});

export default commitments;
