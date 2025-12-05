import { Hono } from 'hono';
import type { AppType, Task } from '../types/index.ts';
import { getAuth } from '../lib/auth.ts';
import { findAll, findById, insert, update, softDelete, count } from '../lib/db.ts';
import { getEncryptionKey, encryptFields, decryptFields } from '../lib/encryption.ts';
import { validate, createTaskSchema, updateTaskSchema } from '../lib/validation.ts';
import { NotFoundError, AppError } from '../lib/errors.ts';
import {
  calculateNextOccurrence,
  shouldContinueRecurrence,
  validateRRule,
  describeRRule
} from '../lib/recurrence.ts';

const ENCRYPTED_FIELDS = ['title', 'description'];

const tasks = new Hono<AppType>();

/**
 * Spawn next instance of a recurring task
 */
async function spawnNextRecurringTask(
  db: D1Database,
  kv: KVNamespace,
  parentTask: Task,
  tenantId: string
): Promise<string | null> {
  // Validate recurrence rule
  if (!parentTask.recurrence_rule) {
    throw new AppError('Task does not have a recurrence rule', 400);
  }

  const validation = validateRRule(parentTask.recurrence_rule);
  if (!validation.valid) {
    throw new AppError(`Invalid recurrence rule: ${validation.error}`, 400);
  }

  // Determine the parent ID (use recurrence_parent_id if this is already a child, otherwise use this task's ID)
  const parentId = parentTask.recurrence_parent_id || parentTask.id;

  // Count existing spawned instances to check COUNT limit
  const spawnedCount = await count(db, 'tasks', {
    tenantId,
    where: 'recurrence_parent_id = ?',
    whereBindings: [parentId],
  });

  // Check if we should continue recurring
  if (!shouldContinueRecurrence(parentTask.recurrence_rule, spawnedCount)) {
    return null; // Recurrence exhausted
  }

  // Calculate next due date
  const currentDueDate = parentTask.due_date || new Date().toISOString().split('T')[0];
  const nextDueDate = calculateNextOccurrence(currentDueDate, parentTask.recurrence_rule);

  if (!nextDueDate) {
    return null; // No more occurrences (UNTIL exceeded)
  }

  // Create new task instance
  const key = await getEncryptionKey(kv, tenantId);
  const newTaskId = crypto.randomUUID();

  const newTask: Partial<Task> = {
    id: newTaskId,
    tenant_id: tenantId,
    user_id: parentTask.user_id,
    title: parentTask.title, // Will be encrypted
    description: parentTask.description, // Will be encrypted
    parent_task_id: null, // Spawned tasks are not subtasks
    project_id: parentTask.project_id,
    domain: parentTask.domain,
    area: parentTask.area,
    contexts: parentTask.contexts,
    tags: parentTask.tags,
    due_date: nextDueDate.split('T')[0], // Extract date part
    due_time: parentTask.due_time,
    start_date: null, // Reset start date
    completed_at: null,
    time_estimate_minutes: parentTask.time_estimate_minutes,
    actual_time_minutes: null,
    recurrence_rule: parentTask.recurrence_rule, // Inherit recurrence rule
    recurrence_parent_id: parentId, // Link to parent
    urgency: parentTask.urgency,
    importance: parentTask.importance,
    energy_required: parentTask.energy_required,
    status: 'scheduled', // New instances start as scheduled
    assigned_by_id: parentTask.assigned_by_id,
    assigned_by_name: parentTask.assigned_by_name,
    delegated_to_id: parentTask.delegated_to_id,
    delegated_to_name: parentTask.delegated_to_name,
    waiting_on: null, // Reset waiting state
    waiting_since: null,
    source_type: 'recurring',
    source_inbox_item_id: null,
    source_reference: parentTask.id, // Reference to the completed task
    calendar_event_id: null,
    calendar_source: null,
  };

  const encrypted = await encryptFields(newTask, ENCRYPTED_FIELDS, key);
  await insert(db, 'tasks', encrypted);

  return newTaskId;
}

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
  const isBeingCompleted = validated.status === 'completed' && existing.status !== 'completed';
  if (isBeingCompleted) {
    validated.completed_at = new Date().toISOString();
  }

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const encrypted = await encryptFields(validated, ENCRYPTED_FIELDS, key);

  const updated = await update(c.env.DB, 'tasks', id, encrypted, { tenantId });

  if (!updated) {
    throw new AppError('Failed to update task', 500);
  }

  // Auto-spawn next recurring task if this task is being completed and has a recurrence rule
  let spawnedTaskId: string | null = null;
  if (isBeingCompleted && existing.recurrence_rule) {
    try {
      // Get the updated task with decrypted fields for spawning
      const updatedTask = await findById<Task>(c.env.DB, 'tasks', id, { tenantId });
      if (updatedTask) {
        const decrypted = await decryptFields(updatedTask, ENCRYPTED_FIELDS, key);
        spawnedTaskId = await spawnNextRecurringTask(c.env.DB, c.env.KV, decrypted, tenantId);
      }
    } catch (error) {
      // Log error but don't fail the update
      console.error('Failed to spawn recurring task:', error);
    }
  }

  return c.json({
    success: true,
    spawned_task_id: spawnedTaskId,
  });
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

// Manually spawn next instance of a recurring task
tasks.post('/:id/spawn-next', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  // Verify ownership
  const existing = await findById<Task>(c.env.DB, 'tasks', id, { tenantId });
  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Task', id);
  }

  if (!existing.recurrence_rule) {
    throw new AppError('Task does not have a recurrence rule', 400);
  }

  // Decrypt the task for spawning
  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decrypted = await decryptFields(existing, ENCRYPTED_FIELDS, key);

  // Spawn next instance
  const spawnedTaskId = await spawnNextRecurringTask(c.env.DB, c.env.KV, decrypted, tenantId);

  if (!spawnedTaskId) {
    return c.json({
      success: false,
      message: 'No more occurrences (recurrence exhausted)',
    }, 400);
  }

  return c.json({
    success: true,
    data: { spawned_task_id: spawnedTaskId },
  }, 201);
});

// Validate recurrence rule
tasks.post('/validate-recurrence', async (c) => {
  const body = await c.req.json();
  const rrule = body.recurrence_rule;

  if (!rrule || typeof rrule !== 'string') {
    throw new AppError('recurrence_rule is required', 400);
  }

  const validation = validateRRule(rrule);

  if (!validation.valid) {
    return c.json({
      success: false,
      valid: false,
      error: validation.error,
    }, 400);
  }

  const description = describeRRule(rrule);

  return c.json({
    success: true,
    valid: true,
    description,
  });
});

// Get recurrence history for a task
tasks.get('/:id/recurrence-history', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  // Verify ownership
  const existing = await findById<Task>(c.env.DB, 'tasks', id, { tenantId });
  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Task', id);
  }

  // Determine the parent ID
  const parentId = existing.recurrence_parent_id || existing.id;

  // Get all tasks in the recurrence chain
  const allTasks = await findAll<Task>(c.env.DB, 'tasks', {
    tenantId,
    orderBy: 'due_date ASC',
  });

  // Filter for recurrence chain
  const chainTasks = allTasks.filter(
    (task) =>
      task.user_id === userId &&
      (task.id === parentId ||
        task.recurrence_parent_id === parentId)
  );

  // Decrypt sensitive fields
  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decryptedTasks = await Promise.all(
    chainTasks.map((task) => decryptFields(task, ENCRYPTED_FIELDS, key))
  );

  return c.json({
    success: true,
    data: {
      parent_id: parentId,
      total_instances: decryptedTasks.length,
      tasks: decryptedTasks,
    },
  });
});

export default tasks;
