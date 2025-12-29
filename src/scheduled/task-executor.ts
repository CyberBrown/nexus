// Task Executor - Execute queued tasks via DE Intake
// Runs after dispatchTasks() to process queued work items
//
// Simplified executor types:
// - 'ai': Full AI autonomy, auto-dispatch via intake (DE workflow execution)
// - 'human-ai': Human leads with AI assist (human pulls from queue)
// - 'human': Human only, never auto-dispatch
//
// Only 'ai' tasks are auto-executed via intake. No fallback paths.

import type { Env, Task } from '../types/index.ts';
import { getEncryptionKey, decryptField } from '../lib/encryption.ts';
import { createIntakeClient, IntakeClient } from '../lib/intake-client.ts';
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

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  project_id: string | null;
  domain: string;
  due_date: string | null;
  energy_required: string;
  source_type: string | null;
  source_reference: string | null;
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
 * Safely decrypt a field, returning original value if decryption fails
 */
async function safeDecrypt(value: unknown, key: CryptoKey | null): Promise<string> {
  if (!value || typeof value !== 'string') {
    return '';
  }
  try {
    return await decryptField(value, key);
  } catch {
    return value;
  }
}

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
 * Mark queue entry as dispatched to workflow
 * Used when triggering parallel workflows via intake - we don't wait for completion
 */
async function markEntryAsDispatched(
  db: D1Database,
  entry: QueueEntry,
  workflowInstanceId: string
): Promise<void> {
  const now = new Date().toISOString();

  await db.prepare(`
    UPDATE execution_queue
    SET status = 'dispatched', claimed_at = ?, claimed_by = ?, updated_at = ?
    WHERE id = ?
  `).bind(now, `workflow:${workflowInstanceId}`, now, entry.id).run();

  // Log dispatch
  await db.prepare(`
    INSERT INTO dispatch_log (id, tenant_id, queue_entry_id, task_id, executor_type, action, details, created_at)
    VALUES (?, ?, ?, ?, ?, 'dispatched', ?, ?)
  `).bind(
    crypto.randomUUID(),
    entry.tenant_id,
    entry.id,
    entry.task_id,
    entry.executor_type,
    JSON.stringify({ workflow_instance_id: workflowInstanceId, source: 'task_executor_parallel' }),
    now
  ).run();
}

/**
 * Promote dependent tasks when a task completes
 * Finds tasks that depend on the completed task and auto-dispatches them if all deps are now met
 */
export async function promoteDependentTasks(
  env: Env,
  completedTaskId: string,
  tenantId: string
): Promise<{ promoted: number; dispatched: number }> {
  const now = new Date().toISOString();
  let promoted = 0;
  let dispatched = 0;

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
  const intakeClient = createIntakeClient(env);
  const callbackBaseUrl = env.NEXUS_URL || 'https://nexus-mcp.solamp.workers.dev';

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

    // Queue the task
    const queueId = await queueTask(env.DB, { ...task, title }, executorType, tenantId);
    console.log(`Queued unblocked task ${dep.task_id} as ${executorType} (queue_id: ${queueId})`);

    // For 'ai' tasks, trigger workflow immediately
    if (executorType === 'ai' && intakeClient) {
      const intakeAvailable = await intakeClient.healthCheck();
      if (intakeAvailable) {
        // Get the queue entry we just created
        const entry = await env.DB.prepare(`
          SELECT eq.*, t.title, t.description, t.project_id, t.domain,
                 t.due_date, t.energy_required, t.source_type, t.source_reference
          FROM execution_queue eq
          JOIN tasks t ON eq.task_id = t.id
          WHERE eq.id = ? AND eq.tenant_id = ?
        `).bind(queueId, tenantId).first<QueueEntry & TaskRow>();

        if (entry) {
          // Claim and trigger workflow
          const claimed = await claimEntry(env.DB, entry, `dependency-promotion-${Date.now()}`);
          if (claimed) {
            const result = await triggerWorkflowForEntry(intakeClient, entry, encryptionKey, callbackBaseUrl);
            if (result.success && result.workflowInstanceId) {
              await markEntryAsDispatched(env.DB, entry, result.workflowInstanceId);
              dispatched++;
              console.log(`Auto-dispatched unblocked task ${dep.task_id} (workflow: ${result.workflowInstanceId})`);
            } else {
              console.warn(`Failed to dispatch unblocked task ${dep.task_id}: ${result.error}`);
            }
          }
        }
      }
    }

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
        auto_dispatched: dispatched > 0,
      }),
      now
    ).run();
  }

  return { promoted, dispatched };
}

/**
 * Trigger a workflow for a task via intake service
 * Returns immediately after workflow is created - callbacks handle completion
 */
async function triggerWorkflowForEntry(
  intakeClient: IntakeClient,
  entry: QueueEntry & TaskRow,
  encryptionKey: CryptoKey | null,
  callbackBaseUrl: string
): Promise<{ success: boolean; workflowInstanceId?: string; error?: string }> {
  try {
    // Decrypt task fields
    const title = await safeDecrypt(entry.title, encryptionKey);
    const description = await safeDecrypt(entry.description, encryptionKey);

    // Parse context for repo/branch info
    let context: Record<string, unknown> | null = null;
    if (entry.context) {
      try {
        context = JSON.parse(entry.context);
      } catch {
        const decryptedContext = await safeDecrypt(entry.context, encryptionKey);
        if (decryptedContext) {
          try {
            context = JSON.parse(decryptedContext);
          } catch {
            // Ignore parse errors
          }
        }
      }
    }

    // Build task description
    let taskDescription = `## Task: ${title}`;
    if (description) {
      taskDescription += `\n\n## Description\n${description}`;
    }
    if (context) {
      if (context.domain) {
        taskDescription += `\n\n## Domain: ${context.domain}`;
      }
      if (context.source_reference) {
        taskDescription += `\n## Reference: ${context.source_reference}`;
      }
    }

    // Extract repo info from context (for code tasks)
    const repo = context?.repo as string | undefined;
    const repoUrl = repo ? `https://github.com/${repo}` : undefined;

    // Trigger workflow via intake
    const response = await intakeClient.triggerWorkflow({
      query: taskDescription,
      task_type: 'code',
      app_id: 'nexus',
      task_id: entry.task_id,
      prompt: taskDescription,
      repo_url: repoUrl,
      executor: 'claude', // Prefer Claude, workflow will fallover to Gemini if needed
      callback_url: `${callbackBaseUrl}/workflow-callback`,
      metadata: {
        queue_entry_id: entry.id,
        tenant_id: entry.tenant_id,
        executor_type: entry.executor_type,
        title: title,
      },
      timeout_ms: 600000, // 10 minutes for AI tasks
    });

    if (response.success && response.workflow_instance_id) {
      return {
        success: true,
        workflowInstanceId: response.workflow_instance_id,
      };
    } else {
      return {
        success: false,
        error: response.error || response.message || 'Unknown intake error',
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ========================================
// Main Executor Function
// ========================================

/**
 * Execute queued tasks via DE Workflows (intake service)
 *
 * Routes ALL 'ai' tasks through intake service for parallel workflow execution.
 * No fallback to sandbox or DE direct - intake is the single entry point.
 *
 * Features:
 * - Triggers CodeExecutionWorkflow via intake service binding
 * - Workflows run in parallel with automatic fallover (Claude -> Gemini)
 * - Built-in retries, crash recovery, callbacks to Nexus
 * - No batch limit - all tasks triggered immediately
 */
export async function executeTasks(env: Env): Promise<ExecutionStats> {
  console.log('Task executor starting (intake-only mode)...');

  const stats: ExecutionStats = {
    processed: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  // Initialize intake client - this is the ONLY execution path
  const intakeClient = createIntakeClient(env);
  if (!intakeClient) {
    console.error('Intake service not configured - INTAKE service binding missing');
    stats.errors.push('Intake service not configured');
    return stats;
  }

  // Check intake availability - no fallback if unavailable
  const intakeAvailable = await intakeClient.healthCheck();
  if (!intakeAvailable) {
    console.error('Intake service unavailable - cannot execute tasks');
    stats.errors.push('Intake service unavailable');
    return stats;
  }

  console.log('Intake available - parallel workflow execution enabled');

  const executorId = `nexus-executor-${Date.now()}`;

  try {
    // Get all tenants
    const tenants = await env.DB.prepare(`
      SELECT id FROM tenants WHERE deleted_at IS NULL
    `).all<{ id: string }>();

    if (!tenants.results || tenants.results.length === 0) {
      console.log('No tenants found');
      return stats;
    }

    // Only process 'ai' executor type (human and human-ai stay in queue for humans)
    const taskLimit = 100; // High limit for parallel workflow execution

    // Get callback base URL for workflow callbacks
    const callbackBaseUrl = env.NEXUS_URL || 'https://nexus-mcp.solamp.workers.dev';

    // Process each tenant
    for (const tenant of tenants.results) {
      const tenantId = tenant.id;

      try {
        // Get queued 'ai' tasks that can be executed
        const entries = await env.DB.prepare(`
          SELECT eq.*, t.title, t.description, t.project_id, t.domain,
                 t.due_date, t.energy_required, t.source_type, t.source_reference
          FROM execution_queue eq
          JOIN tasks t ON eq.task_id = t.id
          WHERE eq.tenant_id = ?
            AND eq.status = 'queued'
            AND eq.executor_type = 'ai'
          ORDER BY eq.priority DESC, eq.queued_at ASC
          LIMIT ?
        `).bind(tenantId, taskLimit).all<QueueEntry & TaskRow>();

        if (!entries.results || entries.results.length === 0) {
          continue;
        }

        console.log(`Found ${entries.results.length} queued AI tasks for tenant ${tenantId}`);

        // Get encryption key for this tenant
        const encryptionKey = await getEncryptionKey(env.KV, tenantId);

        // Trigger all workflows in parallel via intake
        console.log(`Triggering ${entries.results.length} workflows in parallel via intake`);

        const workflowPromises = entries.results.map(async (entry) => {
          stats.processed++;

          try {
            // Try to claim the entry first
            const claimed = await claimEntry(env.DB, entry, executorId);
            if (!claimed) {
              console.log(`Entry ${entry.id} already claimed, skipping`);
              stats.skipped++;
              return { entry, status: 'skipped' as const };
            }

            console.log(`Triggering workflow for task: ${entry.task_id}`);

            // Trigger workflow via intake
            const result = await triggerWorkflowForEntry(intakeClient, entry, encryptionKey, callbackBaseUrl);

            if (result.success && result.workflowInstanceId) {
              // Mark as dispatched - workflow callbacks will handle completion
              await markEntryAsDispatched(env.DB, entry, result.workflowInstanceId);
              console.log(`Workflow triggered for task ${entry.task_id}: ${result.workflowInstanceId}`);
              return { entry, status: 'dispatched' as const, workflowInstanceId: result.workflowInstanceId };
            } else {
              // Workflow trigger failed - use failEntry for retry logic
              const error = result.error || 'Unknown workflow trigger error';
              await failEntry(env.DB, entry, error);
              stats.failed++;
              stats.errors.push(`Task ${entry.task_id}: ${error}`);
              console.error(`Workflow trigger failed for task ${entry.task_id}:`, error);
              return { entry, status: 'failed' as const, error };
            }
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            console.error(`Error triggering workflow for entry ${entry.id}:`, error);
            try {
              await failEntry(env.DB, entry, error);
            } catch {
              // Ignore failure logging errors
            }
            stats.failed++;
            stats.errors.push(`Entry ${entry.id}: ${error}`);
            return { entry, status: 'error' as const, error };
          }
        });

        // Wait for all workflow triggers to complete
        const workflowResults = await Promise.allSettled(workflowPromises);

        // Count dispatched (successful workflow triggers count as "in progress", not completed)
        let dispatched = 0;
        for (const result of workflowResults) {
          if (result.status === 'fulfilled' && result.value.status === 'dispatched') {
            dispatched++;
          }
        }
        console.log(`Workflow dispatch complete: ${dispatched} dispatched, ${stats.failed} failed`);

      } catch (tenantError) {
        const error = tenantError instanceof Error ? tenantError.message : String(tenantError);
        console.error(`Error processing tenant ${tenantId}:`, error);
        stats.errors.push(`Tenant ${tenantId}: ${error}`);
      }
    }

    console.log('Task executor complete:', JSON.stringify(stats));
    return stats;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Fatal error in task executor:', error);
    stats.errors.push(`Fatal: ${errorMessage}`);
    return stats;
  }
}

/**
 * Execute a single task by queue entry ID
 * Used for manual triggering via MCP tool
 *
 * Routes ALL 'ai' tasks through intake service (DE workflow execution).
 * No fallback to sandbox or DE direct - intake is the single entry point.
 */
export async function executeQueueEntry(
  env: Env,
  queueId: string,
  tenantId: string,
  _overrideOptions?: ExecuteOverrideOptions
): Promise<{ success: boolean; result?: string; error?: string }> {
  const executorId = `nexus-manual-${Date.now()}`;

  // Get the queue entry with task data
  const entry = await env.DB.prepare(`
    SELECT eq.*, t.title, t.description, t.project_id, t.domain,
           t.due_date, t.energy_required, t.source_type, t.source_reference
    FROM execution_queue eq
    JOIN tasks t ON eq.task_id = t.id
    WHERE eq.id = ? AND eq.tenant_id = ?
  `).bind(queueId, tenantId).first<QueueEntry & TaskRow>();

  if (!entry) {
    return { success: false, error: 'Queue entry not found' };
  }

  // Validate executor type - only 'ai' tasks are auto-executable
  if (entry.executor_type !== 'ai') {
    return {
      success: false,
      error: `Cannot execute '${entry.executor_type}' tasks automatically. Only 'ai' tasks are auto-executable. Use the queue to view and manually handle human/human-ai tasks.`,
    };
  }

  // Check status
  if (entry.status !== 'queued' && entry.status !== 'claimed') {
    return {
      success: false,
      error: `Queue entry has status '${entry.status}', expected 'queued' or 'claimed'`,
    };
  }

  // Initialize intake client - this is the ONLY execution path
  const intakeClient = createIntakeClient(env);
  if (!intakeClient) {
    return { success: false, error: 'Intake service not configured - INTAKE service binding missing' };
  }

  // Check intake health - no fallback if unavailable
  const intakeAvailable = await intakeClient.healthCheck();
  if (!intakeAvailable) {
    return { success: false, error: 'Intake service unavailable - cannot execute task' };
  }

  // Claim if not already claimed
  if (entry.status === 'queued') {
    const claimed = await claimEntry(env.DB, entry, executorId);
    if (!claimed) {
      return { success: false, error: 'Failed to claim queue entry' };
    }
  }

  // Get encryption key for decrypting task fields
  const encryptionKey = await getEncryptionKey(env.KV, tenantId);

  // Get callback URL for workflow completion
  const callbackBaseUrl = env.NEXUS_URL || 'https://nexus-mcp.solamp.workers.dev';

  console.log(`Executing task via intake: ${entry.task_id}`);

  // Trigger workflow via intake
  const result = await triggerWorkflowForEntry(intakeClient, entry, encryptionKey, callbackBaseUrl);

  if (result.success && result.workflowInstanceId) {
    // Mark as dispatched - workflow callbacks will handle completion
    await markEntryAsDispatched(env.DB, entry, result.workflowInstanceId);
    console.log(`Workflow triggered for task ${entry.task_id}: ${result.workflowInstanceId}`);
    return {
      success: true,
      result: `Workflow triggered: ${result.workflowInstanceId}. Task will complete asynchronously via callback.`,
    };
  } else {
    const error = result.error || 'Unknown workflow trigger error';
    await failEntry(env.DB, entry, error);
    return { success: false, error };
  }
}
