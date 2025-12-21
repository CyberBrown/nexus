// Task Dispatcher - Scheduled job to poll for tasks and route to executors
// Runs on a cron schedule to check for tasks ready to execute

import type { Env, Task } from '../types/index.ts';
import { getEncryptionKey, decryptFields } from '../lib/encryption.ts';

const ENCRYPTED_FIELDS = ['title', 'description'];

// Executor types that can handle tasks
export type ExecutorType = 'claude-code' | 'claude-ai' | 'de-agent' | 'human';

// Task tag patterns and their executor mappings
const EXECUTOR_PATTERNS: Array<{ pattern: RegExp; executor: ExecutorType }> = [
  // Literal executor names (highest priority - check first)
  { pattern: /^\[claude-code\]/i, executor: 'claude-code' },
  { pattern: /^\[claude-ai\]/i, executor: 'claude-ai' },
  { pattern: /^\[de-agent\]/i, executor: 'de-agent' },

  // Shorthand tags
  { pattern: /^\[CC\]/i, executor: 'claude-code' },
  { pattern: /^\[AI\]/i, executor: 'claude-ai' },
  { pattern: /^\[DE\]/i, executor: 'de-agent' },
  { pattern: /^\[HUMAN\]/i, executor: 'human' },
  { pattern: /^\[BLOCKED\]/i, executor: 'human' },

  // Code-related tasks -> Claude Code
  { pattern: /^\[implement\]/i, executor: 'claude-code' },
  { pattern: /^\[deploy\]/i, executor: 'claude-code' },
  { pattern: /^\[fix\]/i, executor: 'claude-code' },
  { pattern: /^\[refactor\]/i, executor: 'claude-code' },
  { pattern: /^\[test\]/i, executor: 'claude-code' },
  { pattern: /^\[debug\]/i, executor: 'claude-code' },
  { pattern: /^\[code\]/i, executor: 'claude-code' },

  // Research/design tasks -> Claude AI or DE
  { pattern: /^\[research\]/i, executor: 'claude-ai' },
  { pattern: /^\[design\]/i, executor: 'claude-ai' },
  { pattern: /^\[document\]/i, executor: 'claude-ai' },
  { pattern: /^\[analyze\]/i, executor: 'claude-ai' },
  { pattern: /^\[plan\]/i, executor: 'claude-ai' },
  { pattern: /^\[write\]/i, executor: 'claude-ai' },

  // Human-required tasks
  { pattern: /^\[human\]/i, executor: 'human' },
  { pattern: /^\[review\]/i, executor: 'human' },
  { pattern: /^\[approve\]/i, executor: 'human' },
  { pattern: /^\[decide\]/i, executor: 'human' },
  { pattern: /^\[call\]/i, executor: 'human' },
  { pattern: /^\[meeting\]/i, executor: 'human' },
];

/**
 * Determine the executor type for a task based on its title
 */
export function determineExecutorType(title: string): ExecutorType {
  for (const { pattern, executor } of EXECUTOR_PATTERNS) {
    if (pattern.test(title)) {
      return executor;
    }
  }

  // Default: tasks without tags go to human for triage
  return 'human';
}

/**
 * Calculate priority score from task urgency and importance
 * Higher score = higher priority
 */
function calculatePriority(task: Task): number {
  const urgency = task.urgency || 3;
  const importance = task.importance || 3;
  // Eisenhower matrix style: urgency * importance
  return urgency * importance;
}

interface QueueEntry {
  id: string;
  task_id: string;
  executor_type: ExecutorType;
  status: string;
}

/**
 * Check if a task is already queued or being executed
 */
async function isTaskQueued(db: D1Database, taskId: string): Promise<boolean> {
  const existing = await db.prepare(`
    SELECT id FROM execution_queue
    WHERE task_id = ? AND status IN ('queued', 'claimed', 'dispatched')
    LIMIT 1
  `).bind(taskId).first<QueueEntry>();

  return existing !== null;
}

/**
 * Add a task to the execution queue
 */
async function queueTask(
  db: D1Database,
  task: Task,
  executorType: ExecutorType,
  tenantId: string
): Promise<string> {
  const id = crypto.randomUUID();
  const priority = calculatePriority(task);
  const now = new Date().toISOString();

  // Build context for the executor
  const context = JSON.stringify({
    task_title: task.title,
    task_description: task.description,
    project_id: task.project_id,
    domain: task.domain,
    due_date: task.due_date,
    energy_required: task.energy_required,
    source_type: task.source_type,
    source_reference: task.source_reference,
  });

  await db.prepare(`
    INSERT INTO execution_queue (
      id, tenant_id, user_id, task_id, executor_type, status,
      priority, queued_at, context, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
  `).bind(
    id,
    tenantId,
    task.user_id,
    task.id,
    executorType,
    priority,
    now,
    context,
    now,
    now
  ).run();

  // Log the dispatch
  await logDispatch(db, tenantId, id, task.id, executorType, 'queued', {
    priority,
    task_title: task.title,
  });

  return id;
}

/**
 * Log a dispatch action for audit trail
 */
async function logDispatch(
  db: D1Database,
  tenantId: string,
  queueEntryId: string | null,
  taskId: string,
  executorType: ExecutorType,
  action: string,
  details: Record<string, unknown>
): Promise<void> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO dispatch_log (id, tenant_id, queue_entry_id, task_id, executor_type, action, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    tenantId,
    queueEntryId,
    taskId,
    executorType,
    action,
    JSON.stringify(details),
    now
  ).run();
}

/**
 * Get tasks ready for execution (status = 'next')
 */
async function getReadyTasks(db: D1Database, tenantId: string): Promise<Task[]> {
  const result = await db.prepare(`
    SELECT * FROM tasks
    WHERE tenant_id = ?
      AND status = 'next'
      AND deleted_at IS NULL
    ORDER BY urgency DESC, importance DESC, created_at ASC
  `).bind(tenantId).all<Task>();

  return result.results || [];
}

/**
 * Main dispatcher function - called by cron trigger
 */
export async function dispatchTasks(env: Env): Promise<{
  processed: number;
  queued: Record<ExecutorType, number>;
  skipped: number;
  errors: number;
}> {
  console.log('Task dispatcher starting...');

  const stats = {
    processed: 0,
    queued: {
      'claude-code': 0,
      'claude-ai': 0,
      'de-agent': 0,
      'human': 0,
    } as Record<ExecutorType, number>,
    skipped: 0,
    errors: 0,
  };

  try {
    // Get all tenants
    const tenants = await env.DB.prepare(`
      SELECT id FROM tenants WHERE deleted_at IS NULL
    `).all<{ id: string }>();

    if (!tenants.results || tenants.results.length === 0) {
      console.log('No tenants found');
      return stats;
    }

    // Process each tenant
    for (const tenant of tenants.results) {
      const tenantId = tenant.id;

      try {
        // Get tasks ready for execution
        const tasks = await getReadyTasks(env.DB, tenantId);
        console.log(`Found ${tasks.length} ready tasks for tenant ${tenantId}`);

        if (tasks.length === 0) {
          continue;
        }

        // Decrypt task titles for routing
        const key = await getEncryptionKey(env.KV, tenantId);

        for (const task of tasks) {
          try {
            stats.processed++;

            // Check if already queued
            if (await isTaskQueued(env.DB, task.id)) {
              console.log(`Task ${task.id} already queued, skipping`);
              stats.skipped++;
              continue;
            }

            // Decrypt title for pattern matching
            const decrypted = await decryptFields(task, ENCRYPTED_FIELDS, key);

            // Determine executor type
            const executorType = determineExecutorType(decrypted.title);
            console.log(`Task "${decrypted.title}" -> ${executorType}`);

            // Queue the task
            await queueTask(env.DB, decrypted, executorType, tenantId);
            stats.queued[executorType]++;

          } catch (taskError) {
            console.error(`Error processing task ${task.id}:`, taskError);
            stats.errors++;
          }
        }
      } catch (tenantError) {
        console.error(`Error processing tenant ${tenantId}:`, tenantError);
        stats.errors++;
      }
    }

    console.log('Task dispatcher complete:', JSON.stringify(stats));
    return stats;

  } catch (error) {
    console.error('Fatal error in task dispatcher:', error);
    throw error;
  }
}

/**
 * Get queue statistics
 */
export async function getQueueStats(db: D1Database, tenantId?: string): Promise<{
  total: number;
  by_status: Record<string, number>;
  by_executor: Record<string, number>;
}> {
  const whereClause = tenantId ? 'WHERE tenant_id = ?' : '';
  const bindings = tenantId ? [tenantId] : [];

  // Total queued
  const total = await db.prepare(`
    SELECT COUNT(*) as count FROM execution_queue ${whereClause}
  `).bind(...bindings).first<{ count: number }>();

  // By status
  const byStatus = await db.prepare(`
    SELECT status, COUNT(*) as count FROM execution_queue
    ${whereClause}
    GROUP BY status
  `).bind(...bindings).all<{ status: string; count: number }>();

  // By executor
  const byExecutor = await db.prepare(`
    SELECT executor_type, COUNT(*) as count FROM execution_queue
    ${whereClause}
    GROUP BY executor_type
  `).bind(...bindings).all<{ executor_type: string; count: number }>();

  return {
    total: total?.count || 0,
    by_status: Object.fromEntries((byStatus.results || []).map(r => [r.status, r.count])),
    by_executor: Object.fromEntries((byExecutor.results || []).map(r => [r.executor_type, r.count])),
  };
}
