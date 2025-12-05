// Scheduled job to spawn recurring tasks automatically
// Runs on a cron schedule to check for tasks that need to be spawned

import type { Env } from '../types/index.ts';
import type { Task } from '../types/index.ts';
import { findAll, insert, count } from '../lib/db.ts';
import { getEncryptionKey, encryptFields, decryptFields } from '../lib/encryption.ts';
import {
  calculateNextOccurrence,
  shouldContinueRecurrence,
  validateRRule,
} from '../lib/recurrence.ts';

const ENCRYPTED_FIELDS = ['title', 'description'];

/**
 * Check if a task is due to spawn a new instance
 * A task is due if:
 * 1. It has a recurrence_rule
 * 2. It's completed OR scheduled
 * 3. The next spawn date is today or earlier
 */
function shouldSpawnTask(task: Task, today: string): boolean {
  if (!task.recurrence_rule) {
    return false;
  }

  // Only spawn from completed tasks or the original parent task
  if (task.status !== 'completed' && task.recurrence_parent_id !== null) {
    return false;
  }

  // If task has a due_date, check if we need to spawn
  if (!task.due_date) {
    return false;
  }

  // Calculate next spawn date
  const nextDate = calculateNextOccurrence(task.due_date, task.recurrence_rule);
  if (!nextDate) {
    return false; // Recurrence exhausted
  }

  // Check if next date is today or earlier
  const nextDateOnly = nextDate.split('T')[0];
  return nextDateOnly <= today;
}

/**
 * Spawn next instance of a recurring task
 */
async function spawnNextInstance(
  db: D1Database,
  kv: KVNamespace,
  task: Task,
  tenantId: string
): Promise<string | null> {
  const validation = validateRRule(task.recurrence_rule!);
  if (!validation.valid) {
    console.error(`Invalid recurrence rule for task ${task.id}: ${validation.error}`);
    return null;
  }

  // Determine parent ID
  const parentId = task.recurrence_parent_id || task.id;

  // Count existing spawned instances
  const spawnedCount = await count(db, 'tasks', {
    tenantId,
    where: 'recurrence_parent_id = ?',
    whereBindings: [parentId],
  });

  // Check if should continue
  if (!shouldContinueRecurrence(task.recurrence_rule!, spawnedCount)) {
    console.log(`Recurrence exhausted for task ${task.id} (COUNT limit reached)`);
    return null;
  }

  // Calculate next due date
  const currentDueDate = task.due_date || new Date().toISOString().split('T')[0];
  const nextDueDate = calculateNextOccurrence(currentDueDate, task.recurrence_rule!);

  if (!nextDueDate) {
    console.log(`Recurrence exhausted for task ${task.id} (UNTIL limit reached)`);
    return null;
  }

  // Create new task instance
  const key = await getEncryptionKey(kv, tenantId);
  const newTaskId = crypto.randomUUID();

  const newTask: Partial<Task> = {
    id: newTaskId,
    tenant_id: tenantId,
    user_id: task.user_id,
    title: task.title,
    description: task.description,
    parent_task_id: null,
    project_id: task.project_id,
    domain: task.domain,
    area: task.area,
    contexts: task.contexts,
    tags: task.tags,
    due_date: nextDueDate.split('T')[0],
    due_time: task.due_time,
    start_date: null,
    completed_at: null,
    time_estimate_minutes: task.time_estimate_minutes,
    actual_time_minutes: null,
    recurrence_rule: task.recurrence_rule,
    recurrence_parent_id: parentId,
    urgency: task.urgency,
    importance: task.importance,
    energy_required: task.energy_required,
    status: 'scheduled',
    assigned_by_id: task.assigned_by_id,
    assigned_by_name: task.assigned_by_name,
    delegated_to_id: task.delegated_to_id,
    delegated_to_name: task.delegated_to_name,
    waiting_on: null,
    waiting_since: null,
    source_type: 'recurring',
    source_inbox_item_id: null,
    source_reference: task.id,
    calendar_event_id: null,
    calendar_source: null,
  };

  const encrypted = await encryptFields(newTask, ENCRYPTED_FIELDS, key);
  await insert(db, 'tasks', encrypted);

  console.log(`Spawned recurring task ${newTaskId} from ${task.id} with due_date ${nextDueDate.split('T')[0]}`);
  return newTaskId;
}

/**
 * Main scheduled job handler
 * Called by Cloudflare Cron Trigger
 */
export async function processRecurringTasks(env: Env): Promise<void> {
  console.log('Starting recurring tasks processing...');

  const today = new Date().toISOString().split('T')[0];
  let totalSpawned = 0;

  try {
    // Get all tenants
    const tenants = await env.DB.prepare(`
      SELECT id FROM tenants WHERE deleted_at IS NULL
    `).all<{ id: string }>();

    if (!tenants.results || tenants.results.length === 0) {
      console.log('No tenants found');
      return;
    }

    // Process each tenant
    for (const tenant of tenants.results) {
      const tenantId = tenant.id;

      // Get all tasks with recurrence rules
      const tasks = await findAll<Task>(env.DB, 'tasks', {
        tenantId,
        orderBy: 'due_date ASC',
      });

      const recurringTasks = tasks.filter((task) =>
        task.recurrence_rule && task.deleted_at === null
      );

      console.log(`Found ${recurringTasks.length} recurring tasks for tenant ${tenantId}`);

      // Decrypt tasks
      const key = await getEncryptionKey(env.KV, tenantId);
      const decryptedTasks = await Promise.all(
        recurringTasks.map((task) => decryptFields(task, ENCRYPTED_FIELDS, key))
      );

      // Process each recurring task
      for (const task of decryptedTasks) {
        try {
          if (shouldSpawnTask(task, today)) {
            const spawnedId = await spawnNextInstance(env.DB, env.KV, task, tenantId);
            if (spawnedId) {
              totalSpawned++;
            }
          }
        } catch (error) {
          console.error(`Error processing task ${task.id}:`, error);
          // Continue with next task
        }
      }
    }

    console.log(`Recurring tasks processing complete. Spawned ${totalSpawned} tasks.`);
  } catch (error) {
    console.error('Fatal error in recurring tasks processing:', error);
    throw error;
  }
}
