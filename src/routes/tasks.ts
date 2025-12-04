import { Hono } from 'hono';
import type { AppType, Task, CreateTaskInput, UpdateTaskInput } from '../types/index.ts';
import { getAuth } from '../lib/auth.ts';
import { findAll, findById, insert, update, softDelete } from '../lib/db.ts';
import { getEncryptionKey, encryptFields, decryptFields } from '../lib/encryption.ts';

const ENCRYPTED_FIELDS = ['title', 'description'];

const tasks = new Hono<AppType>();

// List tasks
tasks.get('/', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const status = c.req.query('status');
  const projectId = c.req.query('project_id');

  try {
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
  } catch (error) {
    console.error('Error listing tasks:', error);
    return c.json({ success: false, error: 'Failed to list tasks' }, 500);
  }
});

// Get single task
tasks.get('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  try {
    const item = await findById<Task>(c.env.DB, 'tasks', id, { tenantId });

    if (!item || item.user_id !== userId) {
      return c.json({ success: false, error: 'Task not found' }, 404);
    }

    const key = await getEncryptionKey(c.env.KV, tenantId);
    const decrypted = await decryptFields(item, ENCRYPTED_FIELDS, key);

    return c.json({ success: true, data: decrypted });
  } catch (error) {
    console.error('Error getting task:', error);
    return c.json({ success: false, error: 'Failed to get task' }, 500);
  }
});

// Create task
tasks.post('/', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const body = await c.req.json<CreateTaskInput>();
    const key = await getEncryptionKey(c.env.KV, tenantId);

    const id = crypto.randomUUID();

    const task: Partial<Task> = {
      id,
      tenant_id: tenantId,
      user_id: userId,
      title: body.title,
      description: body.description ?? null,
      parent_task_id: body.parent_task_id ?? null,
      project_id: body.project_id ?? null,
      domain: body.domain ?? 'personal',
      area: body.area ?? null,
      contexts: body.contexts ?? null,
      tags: body.tags ?? null,
      due_date: body.due_date ?? null,
      due_time: body.due_time ?? null,
      start_date: body.start_date ?? null,
      completed_at: null,
      time_estimate_minutes: body.time_estimate_minutes ?? null,
      actual_time_minutes: null,
      recurrence_rule: body.recurrence_rule ?? null,
      recurrence_parent_id: body.recurrence_parent_id ?? null,
      urgency: body.urgency ?? 3,
      importance: body.importance ?? 3,
      energy_required: body.energy_required ?? 'medium',
      status: body.status ?? 'inbox',
      assigned_by_id: body.assigned_by_id ?? null,
      assigned_by_name: body.assigned_by_name ?? null,
      delegated_to_id: body.delegated_to_id ?? null,
      delegated_to_name: body.delegated_to_name ?? null,
      waiting_on: body.waiting_on ?? null,
      waiting_since: body.waiting_since ?? null,
      source_type: body.source_type ?? null,
      source_inbox_item_id: body.source_inbox_item_id ?? null,
      source_reference: body.source_reference ?? null,
      calendar_event_id: body.calendar_event_id ?? null,
      calendar_source: body.calendar_source ?? null,
    };

    const encrypted = await encryptFields(task, ENCRYPTED_FIELDS, key);
    await insert(c.env.DB, 'tasks', encrypted);

    return c.json({ success: true, data: { id } }, 201);
  } catch (error) {
    console.error('Error creating task:', error);
    return c.json({ success: false, error: 'Failed to create task' }, 500);
  }
});

// Update task
tasks.patch('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  try {
    // Verify ownership
    const existing = await findById<Task>(c.env.DB, 'tasks', id, { tenantId });
    if (!existing || existing.user_id !== userId) {
      return c.json({ success: false, error: 'Task not found' }, 404);
    }

    const body = await c.req.json<UpdateTaskInput>();

    // Handle task completion
    if (body.status === 'completed' && existing.status !== 'completed') {
      body.completed_at = new Date().toISOString();
    }

    const key = await getEncryptionKey(c.env.KV, tenantId);
    const encrypted = await encryptFields(body, ENCRYPTED_FIELDS, key);

    const updated = await update(c.env.DB, 'tasks', id, encrypted, { tenantId });

    if (!updated) {
      return c.json({ success: false, error: 'Failed to update task' }, 500);
    }

    return c.json({ success: true });
  } catch (error) {
    console.error('Error updating task:', error);
    return c.json({ success: false, error: 'Failed to update task' }, 500);
  }
});

// Delete task (soft delete)
tasks.delete('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  try {
    // Verify ownership
    const existing = await findById<Task>(c.env.DB, 'tasks', id, { tenantId });
    if (!existing || existing.user_id !== userId) {
      return c.json({ success: false, error: 'Task not found' }, 404);
    }

    const deleted = await softDelete(c.env.DB, 'tasks', id, { tenantId });

    if (!deleted) {
      return c.json({ success: false, error: 'Failed to delete task' }, 500);
    }

    return c.json({ success: true });
  } catch (error) {
    console.error('Error deleting task:', error);
    return c.json({ success: false, error: 'Failed to delete task' }, 500);
  }
});

export default tasks;
