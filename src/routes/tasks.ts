import { Hono } from 'hono';
import type { AppType, Task } from '../types/index.ts';
import { getAuth } from '../lib/auth.ts';
import { findAll, findById, insert, update, softDelete } from '../lib/db.ts';
import { getEncryptionKey, encryptFields, decryptFields } from '../lib/encryption.ts';
import { validate, createTaskSchema, updateTaskSchema } from '../lib/validation.ts';
import { NotFoundError, AppError } from '../lib/errors.ts';

const ENCRYPTED_FIELDS = ['title', 'description'];

const tasks = new Hono<AppType>();

// List tasks
tasks.get('/', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const status = c.req.query('status');
  const projectId = c.req.query('project_id');

  let items = await findAll<Task>(c.env.DB, 'tasks', {
    tenantId,
    orderBy: 'created_at DESC',
  });

  // Filter by user
  items = items.filter((item) => item.user_id === userId);

  // Optional filters
  if (status) {
    items = items.filter((item) => item.status === status);
  }
  if (projectId) {
    items = items.filter((item) => item.project_id === projectId);
  }

  // Decrypt sensitive fields
  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decryptedItems = await Promise.all(
    items.map((item) => decryptFields(item, ENCRYPTED_FIELDS, key))
  );

  return c.json({ success: true, data: decryptedItems });
});

// Get single task
tasks.get('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const item = await findById<Task>(c.env.DB, 'tasks', id, { tenantId });

  if (!item || item.user_id !== userId) {
    throw new NotFoundError('Task', id);
  }

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decrypted = await decryptFields(item, ENCRYPTED_FIELDS, key);

  return c.json({ success: true, data: decrypted });
});

// Create task
tasks.post('/', async (c) => {
  const { tenantId, userId } = getAuth(c);

  const body = await c.req.json();
  const validated = validate(createTaskSchema, body);

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const id = crypto.randomUUID();

  const task: Partial<Task> = {
    id,
    tenant_id: tenantId,
    user_id: userId,
    title: validated.title,
    description: validated.description ?? null,
    parent_task_id: validated.parent_task_id ?? null,
    project_id: validated.project_id ?? null,
    domain: validated.domain ?? 'personal',
    area: validated.area ?? null,
    contexts: validated.contexts ?? null,
    tags: validated.tags ?? null,
    due_date: validated.due_date ?? null,
    due_time: validated.due_time ?? null,
    start_date: validated.start_date ?? null,
    completed_at: null,
    time_estimate_minutes: validated.time_estimate_minutes ?? null,
    actual_time_minutes: null,
    recurrence_rule: validated.recurrence_rule ?? null,
    recurrence_parent_id: validated.recurrence_parent_id ?? null,
    urgency: validated.urgency ?? 3,
    importance: validated.importance ?? 3,
    energy_required: validated.energy_required ?? 'medium',
    status: validated.status ?? 'inbox',
    assigned_by_id: validated.assigned_by_id ?? null,
    assigned_by_name: validated.assigned_by_name ?? null,
    delegated_to_id: validated.delegated_to_id ?? null,
    delegated_to_name: validated.delegated_to_name ?? null,
    waiting_on: validated.waiting_on ?? null,
    waiting_since: validated.waiting_since ?? null,
    source_type: validated.source_type ?? null,
    source_inbox_item_id: validated.source_inbox_item_id ?? null,
    source_reference: validated.source_reference ?? null,
    calendar_event_id: validated.calendar_event_id ?? null,
    calendar_source: validated.calendar_source ?? null,
  };

  const encrypted = await encryptFields(task, ENCRYPTED_FIELDS, key);
  await insert(c.env.DB, 'tasks', encrypted);

  return c.json({ success: true, data: { id } }, 201);
});

// Update task
tasks.patch('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  // Verify ownership
  const existing = await findById<Task>(c.env.DB, 'tasks', id, { tenantId });
  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Task', id);
  }

  const body = await c.req.json();
  const validated = validate(updateTaskSchema, body);

  // Handle task completion
  if (validated.status === 'completed' && existing.status !== 'completed') {
    validated.completed_at = new Date().toISOString();
  }

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const encrypted = await encryptFields(validated, ENCRYPTED_FIELDS, key);

  const updated = await update(c.env.DB, 'tasks', id, encrypted, { tenantId });

  if (!updated) {
    throw new AppError('Failed to update task', 500);
  }

  return c.json({ success: true });
});

// Delete task (soft delete)
tasks.delete('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  // Verify ownership
  const existing = await findById<Task>(c.env.DB, 'tasks', id, { tenantId });
  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Task', id);
  }

  const deleted = await softDelete(c.env.DB, 'tasks', id, { tenantId });

  if (!deleted) {
    throw new AppError('Failed to delete task', 500);
  }

  return c.json({ success: true });
});

export default tasks;
