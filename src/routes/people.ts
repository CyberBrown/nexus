import { Hono } from 'hono';
import type { AppType, Person } from '../types/index.ts';
import { getAuth } from '../lib/auth.ts';
import { findAll, findById, insert, update, softDelete } from '../lib/db.ts';
import { getEncryptionKey, encryptFields, decryptFields } from '../lib/encryption.ts';
import { validate, createPersonSchema, updatePersonSchema } from '../lib/validation.ts';
import { NotFoundError, AppError } from '../lib/errors.ts';

const ENCRYPTED_FIELDS = ['name', 'email', 'phone', 'notes'];

const people = new Hono<AppType>();

// List people
people.get('/', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const relationship = c.req.query('relationship');
  const organization = c.req.query('organization');

  let items = await findAll<Person>(c.env.DB, 'people', {
    tenantId,
    orderBy: 'created_at DESC',
  });

  // Filter by user
  items = items.filter((item) => item.user_id === userId);

  // Optional filters
  if (relationship) {
    items = items.filter((item) => item.relationship === relationship);
  }
  if (organization) {
    items = items.filter((item) => item.organization === organization);
  }

  // Decrypt sensitive fields
  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decryptedItems = await Promise.all(
    items.map((item) => decryptFields(item, ENCRYPTED_FIELDS, key))
  );

  return c.json({ success: true, data: decryptedItems });
});

// Search people by name
people.get('/search', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const query = c.req.query('q');

  if (!query || query.length < 2) {
    return c.json({ success: true, data: [] });
  }

  let items = await findAll<Person>(c.env.DB, 'people', {
    tenantId,
    orderBy: 'created_at DESC',
  });

  items = items.filter((item) => item.user_id === userId);

  // Decrypt and filter by name match
  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decryptedItems = await Promise.all(
    items.map((item) => decryptFields(item, ENCRYPTED_FIELDS, key))
  );

  const queryLower = query.toLowerCase();
  const filtered = decryptedItems.filter((item) =>
    item.name.toLowerCase().includes(queryLower) ||
    (item.email && item.email.toLowerCase().includes(queryLower)) ||
    (item.organization && item.organization.toLowerCase().includes(queryLower))
  );

  return c.json({ success: true, data: filtered });
});

// Get single person
people.get('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const item = await findById<Person>(c.env.DB, 'people', id, { tenantId });

  if (!item || item.user_id !== userId) {
    throw new NotFoundError('Person', id);
  }

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decrypted = await decryptFields(item, ENCRYPTED_FIELDS, key);

  return c.json({ success: true, data: decrypted });
});

// Create person
people.post('/', async (c) => {
  const { tenantId, userId } = getAuth(c);

  const body = await c.req.json();
  const validated = validate(createPersonSchema, body);

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const id = crypto.randomUUID();

  const person: Partial<Person> = {
    id,
    tenant_id: tenantId,
    user_id: userId,
    name: validated.name,
    email: validated.email ?? null,
    phone: validated.phone ?? null,
    relationship: validated.relationship ?? null,
    organization: validated.organization ?? null,
    role: validated.role ?? null,
    preferred_contact: validated.preferred_contact ?? null,
    google_contact_id: validated.google_contact_id ?? null,
    notes: validated.notes ?? null,
  };

  const encrypted = await encryptFields(person, ENCRYPTED_FIELDS, key);
  await insert(c.env.DB, 'people', encrypted);

  return c.json({ success: true, data: { id } }, 201);
});

// Update person
people.patch('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  // Verify ownership
  const existing = await findById<Person>(c.env.DB, 'people', id, { tenantId });
  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Person', id);
  }

  const body = await c.req.json();
  const validated = validate(updatePersonSchema, body);

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const encrypted = await encryptFields(validated, ENCRYPTED_FIELDS, key);

  const updated = await update(c.env.DB, 'people', id, encrypted, { tenantId });

  if (!updated) {
    throw new AppError('Failed to update person', 500);
  }

  return c.json({ success: true });
});

// Delete person (soft delete)
people.delete('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  // Verify ownership
  const existing = await findById<Person>(c.env.DB, 'people', id, { tenantId });
  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Person', id);
  }

  const deleted = await softDelete(c.env.DB, 'people', id, { tenantId });

  if (!deleted) {
    throw new AppError('Failed to delete person', 500);
  }

  return c.json({ success: true });
});

export default people;
