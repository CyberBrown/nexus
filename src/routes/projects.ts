import { Hono } from 'hono';
import type { AppType, Project } from '../types/index.ts';
import { getAuth } from '../lib/auth.ts';
import { findAll, findById, insert, update, softDelete } from '../lib/db.ts';
import { getEncryptionKey, encryptFields, decryptFields } from '../lib/encryption.ts';
import { validate, createProjectSchema, updateProjectSchema } from '../lib/validation.ts';
import { NotFoundError, AppError } from '../lib/errors.ts';

const ENCRYPTED_FIELDS = ['name', 'description', 'objective'];

const projects = new Hono<AppType>();

// List projects
projects.get('/', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const status = c.req.query('status');

  let items = await findAll<Project>(c.env.DB, 'projects', {
    tenantId,
    orderBy: 'created_at DESC',
  });

  // Filter by user
  items = items.filter((item) => item.user_id === userId);

  // Optional status filter
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

// Get single project
projects.get('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const item = await findById<Project>(c.env.DB, 'projects', id, { tenantId });

  if (!item || item.user_id !== userId) {
    throw new NotFoundError('Project', id);
  }

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decrypted = await decryptFields(item, ENCRYPTED_FIELDS, key);

  return c.json({ success: true, data: decrypted });
});

// Create project
projects.post('/', async (c) => {
  const { tenantId, userId } = getAuth(c);

  const body = await c.req.json();
  const validated = validate(createProjectSchema, body);

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const id = crypto.randomUUID();

  const project: Partial<Project> = {
    id,
    tenant_id: tenantId,
    user_id: userId,
    name: validated.name,
    description: validated.description ?? null,
    objective: validated.objective ?? null,
    domain: validated.domain ?? 'personal',
    area: validated.area ?? null,
    tags: validated.tags ?? null,
    status: validated.status ?? 'planning',
    health: validated.health ?? 'on_track',
    target_date: validated.target_date ?? null,
    started_at: validated.started_at ?? null,
    completed_at: null,
    parent_project_id: validated.parent_project_id ?? null,
    external_id: validated.external_id ?? null,
    external_source: validated.external_source ?? null,
  };

  const encrypted = await encryptFields(project, ENCRYPTED_FIELDS, key);
  await insert(c.env.DB, 'projects', encrypted);

  return c.json({ success: true, data: { id } }, 201);
});

// Update project
projects.patch('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  // Verify ownership
  const existing = await findById<Project>(c.env.DB, 'projects', id, { tenantId });
  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Project', id);
  }

  const body = await c.req.json();
  const validated = validate(updateProjectSchema, body);

  // Handle project completion
  if (validated.status === 'completed' && existing.status !== 'completed') {
    validated.completed_at = new Date().toISOString();
  }

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const encrypted = await encryptFields(validated, ENCRYPTED_FIELDS, key);

  const updated = await update(c.env.DB, 'projects', id, encrypted, { tenantId });

  if (!updated) {
    throw new AppError('Failed to update project', 500);
  }

  return c.json({ success: true });
});

// Delete project (soft delete)
projects.delete('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  // Verify ownership
  const existing = await findById<Project>(c.env.DB, 'projects', id, { tenantId });
  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Project', id);
  }

  const deleted = await softDelete(c.env.DB, 'projects', id, { tenantId });

  if (!deleted) {
    throw new AppError('Failed to delete project', 500);
  }

  return c.json({ success: true });
});

export default projects;
