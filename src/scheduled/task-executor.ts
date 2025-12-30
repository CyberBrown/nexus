// Task Executor - Queue management only
// Nexus is now a pure queue manager - external executors poll the queue via MCP tools
//
// Executor types:
// - 'ai': Full AI autonomy (external executors like Claude Code, Claude AI)
// - 'human-ai': Human leads with AI assist
// - 'human': Human only
//
// External executors use:
// - nexus_check_queue: Poll for queued tasks
// - nexus_claim_queue_task: Claim a task to work on
// - nexus_complete_queue_task: Report completion

import type { Env, Task } from '../types/index.ts';
import { getEncryptionKey, decryptField } from '../lib/encryption.ts';
import { isOAuthError, sendOAuthExpirationAlert, sendQuarantineAlert } from '../lib/notifications.ts';
import {
  type ExecutorType,
  hasUnmetDependencies,
  determineExecutorType,
  queueTask,
} from './task-dispatcher.ts';

// ========================================
// Types
// ========================================

/**
 * Override options for task execution
 * Passed from MCP tool to override context values
 */
export interface ExecuteOverrideOptions {
  repo?: string;
  branch?: string;
  commit_message?: string;
}

interface QueueEntry {
  id: string;
  tenant_id: string;
  user_id: string;
  task_id: string;
  executor_type: ExecutorType;
  status: string;
  priority: number;
  context: string | null;
  queued_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
  retry_count: number;
  max_retries: number;
}

interface ExecutionStats {
  processed: number;
  completed: number;
  failed: number;
  skipped: number;
  errors: string[];
}

// ========================================
// Helper Functions
// ========================================

/**
 * Claim a queue entry for execution
 */
async function claimEntry(
  db: D1Database,
  entry: QueueEntry,
  claimedBy: string
): Promise<boolean> {
  const now = new Date().toISOString();

  // Atomic claim - only succeed if still queued
  const result = await db.prepare(`
    UPDATE execution_queue
    SET status = 'claimed', claimed_at = ?, claimed_by = ?, updated_at = ?
    WHERE id = ? AND status = 'queued'
  `).bind(now, claimedBy, now, entry.id).run();

  if (!result.meta.changes || result.meta.changes === 0) {
    return false; // Someone else claimed it
  }

  // Log the claim
  await db.prepare(`
    INSERT INTO dispatch_log (id, tenant_id, queue_entry_id, task_id, executor_type, action, details, created_at)
    VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?)
  `).bind(
    crypto.randomUUID(),
    entry.tenant_id,
    entry.id,
    entry.task_id,
    entry.executor_type,
    JSON.stringify({ claimed_by: claimedBy, source: 'task_executor' }),
    now
  ).run();

  return true;
}

/**
 * Mark queue entry as completed and promote dependent tasks
 */
async function completeEntry(
  env: Env,
  entry: QueueEntry,
  result: string
): Promise<{ promoted: number; dispatched: number }> {
  const now = new Date().toISOString();

  await env.DB.prepare(`
    UPDATE execution_queue
    SET status = 'completed', completed_at = ?, result = ?, updated_at = ?
    WHERE id = ?
  `).bind(now, result, now, entry.id).run();

  // Update the task status to completed
  await env.DB.prepare(`
    UPDATE tasks
    SET status = 'completed', completed_at = ?, updated_at = ?
    WHERE id = ?
  `).bind(now, now, entry.task_id).run();

  // Log completion
  await env.DB.prepare(`
    INSERT INTO dispatch_log (id, tenant_id, queue_entry_id, task_id, executor_type, action, details, created_at)
    VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)
  `).bind(
    crypto.randomUUID(),
    entry.tenant_id,
    entry.id,
    entry.task_id,
    entry.executor_type,
    JSON.stringify({ result: result.substring(0, 500), source: 'task_executor' }),
    now
  ).run();

  // Promote dependent tasks that are now unblocked
  const promotionResult = await promoteDependentTasks(env, entry.task_id, entry.tenant_id);
  if (promotionResult.promoted > 0) {
    console.log(`Promoted ${promotionResult.promoted} dependent tasks (${promotionResult.dispatched} auto-dispatched)`);
  }

  return promotionResult;
}

/**
 * Mark queue entry as failed
 * Detects OAuth errors and immediately quarantines with notification (no retries)
 */
async function failEntry(
  db: D1Database,
  entry: QueueEntry & { title?: string },
  error: string
): Promise<void> {
  const now = new Date().toISOString();
  const newRetryCount = entry.retry_count + 1;

  // Check if this is an OAuth error - these should quarantine immediately (no retries)
  if (isOAuthError(error)) {
    console.log(`OAuth error detected for task ${entry.task_id}, quarantining immediately`);

    const quarantineReason = `OAuth/authentication error: ${error.slice(0, 200)}`;

    // Immediately quarantine - no point retrying OAuth errors
    await db.prepare(`
      UPDATE execution_queue
      SET status = 'quarantine',
          error = ?,
          quarantine_reason = ?,
          quarantined_at = ?,
          retry_count = ?,
          updated_at = ?
      WHERE id = ?
    `).bind(error, quarantineReason, now, newRetryCount, now, entry.id).run();

    // Update task status to 'waiting' so it's visible but not re-dispatched
    await db.prepare(`
      UPDATE tasks
      SET status = 'waiting',
          updated_at = ?
      WHERE id = ?
    `).bind(now, entry.task_id).run();

    await db.prepare(`
      INSERT INTO dispatch_log (id, tenant_id, queue_entry_id, task_id, executor_type, action, details, created_at)
      VALUES (?, ?, ?, ?, ?, 'quarantined', ?, ?)
    `).bind(
      crypto.randomUUID(),
      entry.tenant_id,
      entry.id,
      entry.task_id,
      entry.executor_type,
      JSON.stringify({ error, reason: 'oauth_error', quarantine_reason: quarantineReason }),
      now
    ).run();

    // Send phone notification
    await sendOAuthExpirationAlert(
      entry.task_id,
      entry.title || 'Unknown task',
      error,
      entry.executor_type
    );

    return;
  }

  // Check if this is a routing error - these indicate configuration issues
  // Log extensively but still allow retries (might be transient)
  if (isRoutingError(error)) {
    console.error(
      `POSSIBLE ROUTING ISSUE for task ${entry.task_id}: ${error}. ` +
      `If sandbox-executor is trying both runners, the call may be bypassing PrimeWorkflow. ` +
      `Verify Nexus is calling /execute not /workflows/* endpoints. ` +
      `See Nexus note 8915b506 for correct architecture.`
    );
  }

  // If we have retries left, requeue instead of failing
  if (newRetryCount < entry.max_retries) {
    await db.prepare(`
      UPDATE execution_queue
      SET status = 'queued', error = ?, retry_count = ?, claimed_at = NULL, claimed_by = NULL, updated_at = ?
      WHERE id = ?
    `).bind(error, newRetryCount, now, entry.id).run();

    await db.prepare(`
      INSERT INTO dispatch_log (id, tenant_id, queue_entry_id, task_id, executor_type, action, details, created_at)
      VALUES (?, ?, ?, ?, ?, 'retry_queued', ?, ?)
    `).bind(
      crypto.randomUUID(),
      entry.tenant_id,
      entry.id,
      entry.task_id,
      entry.executor_type,
      JSON.stringify({ error, retry_count: newRetryCount, max_retries: entry.max_retries }),
      now
    ).run();
  } else {
    // No more retries - quarantine with notification
    const quarantineReason = `Max attempts (${newRetryCount}) exceeded: ${error.slice(0, 200)}`;

    await db.prepare(`
      UPDATE execution_queue
      SET status = 'quarantine',
          error = ?,
          quarantine_reason = ?,
          quarantined_at = ?,
          retry_count = ?,
          updated_at = ?
      WHERE id = ?
    `).bind(error, quarantineReason, now, newRetryCount, now, entry.id).run();

    // Update task status to 'waiting' so it's visible but not re-dispatched
    await db.prepare(`
      UPDATE tasks
      SET status = 'waiting',
          updated_at = ?
      WHERE id = ?
    `).bind(now, entry.task_id).run();

    await db.prepare(`
      INSERT INTO dispatch_log (id, tenant_id, queue_entry_id, task_id, executor_type, action, details, created_at)
      VALUES (?, ?, ?, ?, ?, 'quarantined', ?, ?)
    `).bind(
      crypto.randomUUID(),
      entry.tenant_id,
      entry.id,
      entry.task_id,
      entry.executor_type,
      JSON.stringify({ error, retry_count: newRetryCount, exhausted_retries: true, quarantine_reason: quarantineReason }),
      now
    ).run();

    // Send notification for quarantined task
    await sendQuarantineAlert(
      entry.task_id,
      entry.title || 'Unknown task',
      quarantineReason,
      newRetryCount
    );
  }
}


/**
 * Promote dependent tasks when a task completes
 * Finds tasks that depend on the completed task and queues them if all deps are now met
 */
export async function promoteDependentTasks(
  env: Env,
  completedTaskId: string,
  tenantId: string
): Promise<{ promoted: number; dispatched: number }> {
  const now = new Date().toISOString();
  let promoted = 0;

  // Find tasks that depend on the completed task
  const dependents = await env.DB.prepare(`
    SELECT DISTINCT td.task_id
    FROM task_dependencies td
    JOIN tasks t ON td.task_id = t.id
    WHERE td.tenant_id = ?
      AND td.depends_on_task_id = ?
      AND td.dependency_type = 'blocks'
      AND t.status = 'next'
      AND t.deleted_at IS NULL
  `).bind(tenantId, completedTaskId).all<{ task_id: string }>();

  if (!dependents.results || dependents.results.length === 0) {
    return { promoted, dispatched };
  }

  console.log(`Found ${dependents.results.length} tasks depending on completed task ${completedTaskId}`);

  // Get encryption key for decrypting task titles
  const encryptionKey = await getEncryptionKey(env.KV, tenantId);

  for (const dep of dependents.results) {
    // Check if ALL dependencies are now met
    const stillBlocked = await hasUnmetDependencies(env.DB, dep.task_id, tenantId);
    if (stillBlocked) {
      console.log(`Task ${dep.task_id} still has unmet dependencies, not promoting`);
      continue;
    }

    console.log(`Task ${dep.task_id} unblocked by completion of ${completedTaskId}`);
    promoted++;

    // Get the full task to queue it
    const task = await env.DB.prepare(`
      SELECT * FROM tasks WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).bind(dep.task_id, tenantId).first<Task>();

    if (!task) {
      console.warn(`Task ${dep.task_id} not found, skipping`);
      continue;
    }

    // Decrypt title for executor routing
    let title = task.title;
    try {
      title = await decryptField(task.title, encryptionKey);
    } catch {
      // Title might already be decrypted
    }

    // Determine executor type
    const executorType = determineExecutorType(title);

    // Check circuit breaker - prevent runaway retry loops
    const { checkCircuitBreaker, tripCircuitBreaker } = await import('./task-dispatcher.ts');
    const circuitBreaker = await checkCircuitBreaker(env.DB, dep.task_id);
    if (circuitBreaker.tripped) {
      await tripCircuitBreaker(env.DB, dep.task_id, tenantId, circuitBreaker.reason!);
      console.log(`Circuit breaker tripped for dependent task ${dep.task_id}, cancelling`);
      continue;
    }

    // Queue the task
    const queueId = await queueTask(env.DB, { ...task, title }, executorType, tenantId);
    console.log(`Queued unblocked task ${dep.task_id} as ${executorType} (queue_id: ${queueId})`);

    // Log the dependency promotion
    await env.DB.prepare(`
      INSERT INTO dispatch_log (id, tenant_id, queue_entry_id, task_id, executor_type, action, details, created_at)
      VALUES (?, ?, ?, ?, ?, 'dependency_promoted', ?, ?)
    `).bind(
      crypto.randomUUID(),
      tenantId,
      queueId,
      dep.task_id,
      executorType,
      JSON.stringify({
        unblocked_by: completedTaskId,
      }),
      now
    ).run();
  }

  return { promoted, dispatched: 0 };
}


// ========================================
// Main Executor Function
// ========================================

/**
 * Execute queued tasks - NO-OP
 *
 * Nexus is now a pure queue manager. External executors (Claude Code, Claude AI via MCP, humans)
 * poll the queue using nexus_check_queue and claim tasks using nexus_claim_queue_task.
 *
 * This function is kept for backward compatibility but does nothing.
 * The cron should only call dispatchTasks() to queue tasks with status='next'.
 */
export async function executeTasks(_env: Env): Promise<ExecutionStats> {
  console.log('executeTasks called - Nexus is now queue-only, external executors poll the queue');

  return {
    processed: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };
}

/**
 * Execute a single task by queue entry ID - DEPRECATED
 *
 * Nexus is now a pure queue manager and does NOT execute tasks.
 * External executors should:
 * 1. Poll the queue: nexus_check_queue({ executor_type: 'ai' })
 * 2. Claim a task: nexus_claim_queue_task({ queue_id, executor_id })
 * 3. Get context: nexus_trigger_task({ task_id })
 * 4. Do the work
 * 5. Report back: nexus_complete_queue_task({ queue_id, result })
 *
 * This function is kept for backward compatibility but returns an error.
 */
export async function executeQueueEntry(
  _env: Env,
  _queueId: string,
  _tenantId: string,
  _overrideOptions?: ExecuteOverrideOptions
): Promise<{ success: boolean; result?: string; error?: string }> {
  return {
    success: false,
    error: 'Nexus is now queue-only. External executors should poll the queue using nexus_check_queue, claim tasks with nexus_claim_queue_task, and report results with nexus_complete_queue_task.',
  };
}
