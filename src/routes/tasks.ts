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

  // Calculate next due date (recurrence_rule already validated above)
  const todayIso = new Date().toISOString();
  const currentDueDate = parentTask.due_date || (todayIso.split('T')[0] ?? todayIso);
  const nextDueDate = calculateNextOccurrence(currentDueDate, parentTask.recurrence_rule!);

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

// ========================================
// Task Dispatch Endpoints
// ========================================

// Dispatch a single task to the execution queue
tasks.post('/:id/dispatch', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const taskId = c.req.param('id');

  // Verify ownership
  const task = await findById<Task>(c.env.DB, 'tasks', taskId, { tenantId });
  if (!task || task.user_id !== userId) {
    throw new NotFoundError('Task', taskId);
  }

  // Check if already queued
  const existing = await c.env.DB.prepare(`
    SELECT id, status FROM execution_queue
    WHERE task_id = ? AND status IN ('queued', 'claimed', 'dispatched')
  `).bind(taskId).first<{ id: string; status: string }>();

  if (existing) {
    return c.json({
      success: false,
      error: `Task is already in queue with status '${existing.status}'`,
      queue_id: existing.id,
    }, 409);
  }

  // Get optional executor_type override from body
  const body = await c.req.json().catch(() => ({}));
  let executorType = body.executor_type as string | undefined;

  // Decrypt title for auto-detection
  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decrypted = await decryptFields(task, ENCRYPTED_FIELDS, key);

  // Auto-detect executor type if not provided
  // Key principle: Does a human need to be involved?
  if (!executorType) {
    const patterns: Array<{ pattern: RegExp; executor: string }> = [
      // Literal executor names (highest priority)
      { pattern: /^\[human\]/i, executor: 'human' },
      { pattern: /^\[human-ai\]/i, executor: 'human-ai' },
      { pattern: /^\[ai\]/i, executor: 'ai' },
      // Legacy tags - map to new types
      { pattern: /^\[claude-code\]/i, executor: 'ai' },
      { pattern: /^\[claude-ai\]/i, executor: 'ai' },
      { pattern: /^\[de-agent\]/i, executor: 'ai' },
      { pattern: /^\[CC\]/i, executor: 'ai' },
      { pattern: /^\[DE\]/i, executor: 'ai' },
      { pattern: /^\[BLOCKED\]/i, executor: 'human' },
      // Human-only tasks
      { pattern: /^\[call\]/i, executor: 'human' },
      { pattern: /^\[meeting\]/i, executor: 'human' },
      // Human-AI collaborative tasks
      { pattern: /^\[review\]/i, executor: 'human-ai' },
      { pattern: /^\[approve\]/i, executor: 'human-ai' },
      { pattern: /^\[decide\]/i, executor: 'human-ai' },
      // All AI-executable tasks
      { pattern: /^\[implement\]/i, executor: 'ai' },
      { pattern: /^\[deploy\]/i, executor: 'ai' },
      { pattern: /^\[fix\]/i, executor: 'ai' },
      { pattern: /^\[refactor\]/i, executor: 'ai' },
      { pattern: /^\[test\]/i, executor: 'ai' },
      { pattern: /^\[debug\]/i, executor: 'ai' },
      { pattern: /^\[code\]/i, executor: 'ai' },
      { pattern: /^\[research\]/i, executor: 'ai' },
      { pattern: /^\[design\]/i, executor: 'ai' },
      { pattern: /^\[document\]/i, executor: 'ai' },
      { pattern: /^\[analyze\]/i, executor: 'ai' },
      { pattern: /^\[plan\]/i, executor: 'ai' },
      { pattern: /^\[write\]/i, executor: 'ai' },
    ];

    executorType = 'human'; // default
    for (const { pattern, executor } of patterns) {
      if (pattern.test(decrypted.title)) {
        executorType = executor;
        break;
      }
    }
  }

  // Calculate priority
  const priority = (task.urgency || 3) * (task.importance || 3);
  const now = new Date().toISOString();

  // Build context
  const context = JSON.stringify({
    task_title: decrypted.title,
    task_description: decrypted.description,
    project_id: task.project_id,
    domain: task.domain,
    due_date: task.due_date,
    energy_required: task.energy_required,
    source_type: task.source_type,
    source_reference: task.source_reference,
  });

  // Add to queue
  const queueId = crypto.randomUUID();
  await c.env.DB.prepare(`
    INSERT INTO execution_queue (
      id, tenant_id, user_id, task_id, executor_type, status,
      priority, queued_at, context, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
  `).bind(
    queueId, tenantId, userId, taskId, executorType,
    priority, now, context, now, now
  ).run();

  // Log the dispatch
  const logId = crypto.randomUUID();
  await c.env.DB.prepare(`
    INSERT INTO dispatch_log (id, tenant_id, queue_entry_id, task_id, executor_type, action, details, created_at)
    VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
  `).bind(logId, tenantId, queueId, taskId, executorType, JSON.stringify({ source: 'api_dispatch' }), now).run();

  return c.json({
    success: true,
    data: {
      queue_id: queueId,
      task_id: taskId,
      executor_type: executorType,
      priority: priority,
      queued_at: now,
    },
  }, 201);
});

export default tasks;
