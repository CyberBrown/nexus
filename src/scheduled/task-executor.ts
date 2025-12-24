// Task Executor - Execute queued tasks via DE
// Runs after dispatchTasks() to process queued work items
//
// Simplified executor types:
// - 'ai': Full AI autonomy, auto-dispatch to DE (via intake workflows or sandbox fallback)
// - 'human-ai': Human leads with AI assist (human pulls from queue)
// - 'human': Human only, never auto-dispatch
//
// Only 'ai' tasks are auto-executed. DE decides the HOW (model, OAuth vs API, etc.)

import type { Env, Task } from '../types/index.ts';
import { getEncryptionKey, decryptField } from '../lib/encryption.ts';
import { DEClient, createDEClient } from '../lib/de-client.ts';
import { SandboxClient, createSandboxClient } from '../lib/sandbox-client.ts';
import { IntakeClient, createIntakeClient } from '../lib/intake-client.ts';
import { isOAuthError, sendOAuthExpirationAlert, sendQuarantineAlert } from '../lib/notifications.ts';
import type { ExecutorType } from './task-dispatcher.ts';

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
 * Mark queue entry as completed
 */
async function completeEntry(
  db: D1Database,
  entry: QueueEntry,
  result: string
): Promise<void> {
  const now = new Date().toISOString();

  await db.prepare(`
    UPDATE execution_queue
    SET status = 'completed', completed_at = ?, result = ?, updated_at = ?
    WHERE id = ?
  `).bind(now, result, now, entry.id).run();

  // Update the task status to completed
  await db.prepare(`
    UPDATE tasks
    SET status = 'completed', completed_at = ?, updated_at = ?
    WHERE id = ?
  `).bind(now, now, entry.task_id).run();

  // Log completion
  await db.prepare(`
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
 * Build prompt for DE based on task context
 */
function buildTaskPrompt(
  title: string,
  description: string | null,
  context: Record<string, unknown> | null
): string {
  let prompt = `You are an AI assistant executing a task. Complete the following task and provide a concise summary of what was done.

## Task
**Title:** ${title}`;

  if (description) {
    prompt += `\n\n**Description:** ${description}`;
  }

  if (context) {
    if (context.domain) {
      prompt += `\n\n**Domain:** ${context.domain}`;
    }
    if (context.due_date) {
      prompt += `\n**Due Date:** ${context.due_date}`;
    }
    if (context.project_id) {
      prompt += `\n**Project ID:** ${context.project_id}`;
    }
    if (context.source_reference) {
      prompt += `\n**Reference:** ${context.source_reference}`;
    }
  }

  prompt += `

## Instructions
1. Analyze the task requirements
2. Execute the task to the best of your ability
3. Provide a clear, actionable result or summary
4. If the task cannot be fully completed, explain what was accomplished and what remains

Please complete this task now:`;

  return prompt;
}

/**
 * Execute a single task via DE (legacy path for de-agent tasks)
 */
async function executeTaskViaDE(
  deClient: DEClient,
  entry: QueueEntry,
  task: TaskRow,
  encryptionKey: CryptoKey | null
): Promise<{ success: boolean; result?: string; error?: string }> {
  try {
    // Decrypt task fields
    const title = await safeDecrypt(task.title, encryptionKey);
    const description = await safeDecrypt(task.description, encryptionKey);

    // Parse context if available
    let context: Record<string, unknown> | null = null;
    if (entry.context) {
      try {
        context = JSON.parse(entry.context);
      } catch {
        // Context might be encrypted or malformed, try decrypting
        const decryptedContext = await safeDecrypt(entry.context, encryptionKey);
        if (decryptedContext) {
          try {
            context = JSON.parse(decryptedContext);
          } catch {
            // Ignore parse errors, context is optional
          }
        }
      }
    }

    // Build prompt
    const prompt = buildTaskPrompt(title, description, context);

    // Execute via DE
    const response = await deClient.textCompletion({
      prompt,
      max_tokens: 2000,
      temperature: 0.7,
    });

    return {
      success: true,
      result: response.text,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Execute a claude-ai task via sandbox-executor container path
 * Routes through /execute endpoint to use OAuth credentials instead of API credits
 */
async function executeTaskViaSandboxSdk(
  sandboxClient: SandboxClient,
  entry: QueueEntry,
  task: TaskRow,
  encryptionKey: CryptoKey | null
): Promise<{ success: boolean; result?: string; error?: string }> {
  try {
    // Decrypt task fields
    const title = await safeDecrypt(task.title, encryptionKey);
    const description = await safeDecrypt(task.description, encryptionKey);

    // Parse context if available
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

    // Build prompt for execution
    const prompt = buildTaskPrompt(title, description, context);

    // Execute via sandbox container path (uses OAuth credentials)
    // claude-ai tasks don't need repo/branch since they're research/analysis tasks
    const response = await sandboxClient.executeCode(prompt, {
      timeout_seconds: 300, // 5 minute timeout for AI tasks (shorter than code tasks)
    });

    if (response.success) {
      return {
        success: true,
        result: response.logs || 'Task completed successfully',
      };
    } else {
      return {
        success: false,
        error: response.error || 'Execution returned no result',
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Execute a claude-code task via sandbox-executor container path
 */
async function executeTaskViaSandboxContainer(
  sandboxClient: SandboxClient,
  entry: QueueEntry,
  task: TaskRow,
  encryptionKey: CryptoKey | null,
  overrideOptions?: ExecuteOverrideOptions
): Promise<{ success: boolean; result?: string; error?: string }> {
  try {
    // Decrypt task fields
    const title = await safeDecrypt(task.title, encryptionKey);
    const description = await safeDecrypt(task.description, encryptionKey);

    // Parse context for repo info
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

    // Build task description for container execution
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

    // Extract repo from override options first, then context
    // Override options take precedence over context values
    const repo = overrideOptions?.repo || (context?.repo as string | undefined);
    const branch = overrideOptions?.branch || (context?.branch as string | undefined);
    const commitMessage = overrideOptions?.commit_message || (context?.commit_message as string | undefined);

    console.log(`executeTaskViaSandboxContainer: repo=${repo}, branch=${branch}, commit_message=${commitMessage}, override=${!!overrideOptions}`);

    // Execute via sandbox container path
    const response = await sandboxClient.executeCode(taskDescription, {
      repo,
      branch,
      timeout_seconds: 600, // 10 minute timeout for code tasks
      commit_message: commitMessage || `chore: ${title.slice(0, 50)}`,
    });

    if (response.success) {
      return {
        success: true,
        result: response.logs || 'Task completed successfully',
      };
    } else {
      return {
        success: false,
        error: response.error || `Container execution failed (exit code: ${response.exit_code})`,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
 * Execute queued tasks via DE Workflows (parallel) or sandbox-executor (fallback)
 *
 * PARALLEL WORKFLOW EXECUTION (preferred for claude-ai/claude-code):
 * - Triggers CodeExecutionWorkflow via intake service binding
 * - Workflows run in parallel with automatic fallover (Claude -> Gemini)
 * - Built-in retries, crash recovery, callbacks to Nexus
 * - No batch limit - all tasks triggered immediately
 *
 * SEQUENTIAL EXECUTION (fallback for de-agent tasks):
 * - de-agent -> DE service binding
 * - human -> skipped (requires human action)
 */
export async function executeTasks(env: Env): Promise<ExecutionStats> {
  console.log('Task executor starting (parallel workflow mode)...');

  const stats: ExecutionStats = {
    processed: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  // Check available execution services
  const intakeClient = createIntakeClient(env);
  const sandboxClient = createSandboxClient(env);
  const deClient = createDEClient(env);

  // Check intake availability (preferred for parallel workflow execution)
  let intakeAvailable = false;
  if (intakeClient) {
    intakeAvailable = await intakeClient.healthCheck();
    if (intakeAvailable) {
      console.log('Intake available - parallel workflow execution enabled');
    } else {
      console.warn('Intake configured but not healthy, falling back to sandbox');
    }
  }

  // Check sandbox availability (fallback for sequential execution)
  let sandboxAvailable = false;
  if (!intakeAvailable && sandboxClient) {
    sandboxAvailable = await sandboxClient.isAvailable();
    if (sandboxAvailable) {
      console.log('Sandbox executor available (sequential fallback)');
    } else {
      console.warn('Sandbox executor configured but not healthy');
    }
  }

  // Check DE availability (for legacy de-agent tasks)
  let deAvailable = false;
  if (deClient) {
    deAvailable = await deClient.healthCheck();
    if (deAvailable) {
      console.log('DE service available (for de-agent tasks)');
    }
  }

  // If no execution services available, skip
  if (!intakeAvailable && !sandboxAvailable && !deAvailable) {
    console.log('No execution services available, skipping task execution');
    stats.errors.push('No execution services available');
    return stats;
  }

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

    // Only auto-execute 'ai' tasks (human and human-ai stay in queue for humans to pull)
    // We need at least one execution service available
    if (!intakeAvailable && !sandboxAvailable && !deAvailable) {
      console.log('No execution services available for ai tasks');
      return stats;
    }

    // Only process 'ai' executor type
    const executorTypes = ['ai'];

    const executorTypePlaceholders = executorTypes.map(() => '?').join(', ');

    // Use higher limit when intake is available (parallel mode)
    const taskLimit = intakeAvailable ? 100 : 10;

    // Get callback base URL for workflow callbacks (use NEXUS_URL or fallback)
    const callbackBaseUrl = env.NEXUS_URL || 'https://nexus-mcp.solamp.workers.dev';

    // Process each tenant
    for (const tenant of tenants.results) {
      const tenantId = tenant.id;

      try {
        // Get queued tasks that can be executed
        const entries = await env.DB.prepare(`
          SELECT eq.*, t.title, t.description, t.project_id, t.domain,
                 t.due_date, t.energy_required, t.source_type, t.source_reference
          FROM execution_queue eq
          JOIN tasks t ON eq.task_id = t.id
          WHERE eq.tenant_id = ?
            AND eq.status = 'queued'
            AND eq.executor_type IN (${executorTypePlaceholders})
          ORDER BY eq.priority DESC, eq.queued_at ASC
          LIMIT ?
        `).bind(tenantId, ...executorTypes, taskLimit).all<QueueEntry & TaskRow>();

        if (!entries.results || entries.results.length === 0) {
          continue;
        }

        console.log(`Found ${entries.results.length} queued tasks for tenant ${tenantId} (limit: ${taskLimit})`);

        // Get encryption key for this tenant
        const encryptionKey = await getEncryptionKey(env.KV, tenantId);

        // Separate entries into workflow tasks (parallel) and sequential tasks
        // All 'ai' tasks go to intake if available, otherwise fallback to sequential
        const workflowEntries: (QueueEntry & TaskRow)[] = [];
        const sequentialEntries: (QueueEntry & TaskRow)[] = [];

        for (const entry of entries.results) {
          if (entry.executor_type === 'ai' && intakeAvailable) {
            workflowEntries.push(entry);
          } else if (entry.executor_type === 'ai') {
            // Fallback to sequential execution if intake not available
            sequentialEntries.push(entry);
          }
          // human and human-ai tasks are NOT auto-executed
        }

        // ========================================
        // PARALLEL WORKFLOW EXECUTION (ai tasks via intake)
        // ========================================
        if (workflowEntries.length > 0 && intakeClient) {
          console.log(`Triggering ${workflowEntries.length} workflows in parallel via intake`);

          // Trigger all workflows in parallel
          const workflowPromises = workflowEntries.map(async (entry) => {
            stats.processed++;

            try {
              // Try to claim the entry first
              const claimed = await claimEntry(env.DB, entry, executorId);
              if (!claimed) {
                console.log(`Entry ${entry.id} already claimed, skipping`);
                stats.skipped++;
                return { entry, status: 'skipped' as const };
              }

              console.log(`Triggering workflow for task: ${entry.task_id} (${entry.executor_type})`);

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
        }

        // ========================================
        // SEQUENTIAL EXECUTION (ai tasks when intake not available)
        // ========================================
        for (const entry of sequentialEntries) {
          stats.processed++;

          try {
            // Try to claim the entry
            const claimed = await claimEntry(env.DB, entry, executorId);
            if (!claimed) {
              console.log(`Entry ${entry.id} already claimed, skipping`);
              stats.skipped++;
              continue;
            }

            console.log(`Executing task sequentially: ${entry.task_id} (${entry.executor_type})`);

            // Route to appropriate executor - all 'ai' tasks go to DE
            let result: { success: boolean; result?: string; error?: string };

            if (entry.executor_type === 'ai') {
              // Try sandbox first (uses OAuth), fallback to DE service binding
              if (sandboxClient) {
                result = await executeTaskViaSandboxSdk(sandboxClient, entry, entry, encryptionKey);
              } else if (deClient) {
                result = await executeTaskViaDE(deClient, entry, entry, encryptionKey);
              } else {
                result = { success: false, error: 'No execution service available for ai task' };
              }
            } else {
              // human and human-ai tasks should not be in sequential execution
              result = { success: false, error: `Executor type '${entry.executor_type}' is not auto-executable` };
            }

            if (result.success && result.result) {
              await completeEntry(env.DB, entry, result.result);
              stats.completed++;
              console.log(`Task ${entry.task_id} completed successfully`);
            } else {
              const error = result.error || 'Unknown execution error';
              await failEntry(env.DB, entry, error);
              stats.failed++;
              stats.errors.push(`Task ${entry.task_id}: ${error}`);
              console.error(`Task ${entry.task_id} failed:`, error);
            }
          } catch (entryError) {
            const error = entryError instanceof Error ? entryError.message : String(entryError);
            console.error(`Error processing entry ${entry.id}:`, error);

            // Try to fail the entry
            try {
              await failEntry(env.DB, entry, error);
            } catch {
              // Ignore failure logging errors
            }

            stats.failed++;
            stats.errors.push(`Entry ${entry.id}: ${error}`);
          }
        }
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
 * Routes to appropriate executor based on executor_type:
 * - claude-ai -> sandbox-executor /execute (uses OAuth credentials)
 * - claude-code -> sandbox-executor /execute (container path with repo/branch)
 * - de-agent -> DE service binding
 */
export async function executeQueueEntry(
  env: Env,
  queueId: string,
  tenantId: string,
  overrideOptions?: ExecuteOverrideOptions
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

  // Initialize clients for 'ai' task execution
  const sandboxClient = createSandboxClient(env);
  const deClient = createDEClient(env);

  // Check if at least one execution service is available
  if (!sandboxClient && !deClient) {
    return { success: false, error: 'No execution service available (neither sandbox nor DE configured)' };
  }

  // Check service health - prefer sandbox, fallback to DE
  let useSandbox = false;
  if (sandboxClient) {
    useSandbox = await sandboxClient.isAvailable();
    if (!useSandbox) {
      console.log('Sandbox not available, will try DE fallback');
    }
  }

  if (!useSandbox && deClient) {
    const deHealthy = await deClient.healthCheck();
    if (!deHealthy) {
      return { success: false, error: 'No execution service healthy (sandbox unavailable, DE health check failed)' };
    }
  } else if (!useSandbox) {
    return { success: false, error: 'No execution service healthy' };
  }

  // Claim if not already claimed
  if (entry.status === 'queued') {
    const claimed = await claimEntry(env.DB, entry, executorId);
    if (!claimed) {
      return { success: false, error: 'Failed to claim queue entry' };
    }
  }

  // Get encryption key
  const encryptionKey = await getEncryptionKey(env.KV, tenantId);

  // Execute 'ai' task - prefer sandbox (OAuth), fallback to DE
  let result: { success: boolean; result?: string; error?: string };

  if (useSandbox && sandboxClient) {
    // Use sandbox with override options for repo/branch/commit_message if provided
    if (overrideOptions?.repo) {
      // Task has repo context, use container path
      result = await executeTaskViaSandboxContainer(sandboxClient, entry, entry, encryptionKey, overrideOptions);
    } else {
      // No repo context, use SDK path
      result = await executeTaskViaSandboxSdk(sandboxClient, entry, entry, encryptionKey);
    }
  } else if (deClient) {
    // Fallback to DE service binding
    result = await executeTaskViaDE(deClient, entry, entry, encryptionKey);
  } else {
    result = { success: false, error: 'No execution service available' };
  }

  if (result.success && result.result) {
    await completeEntry(env.DB, entry, result.result);
    return { success: true, result: result.result };
  } else {
    const error = result.error || 'Unknown execution error';
    await failEntry(env.DB, entry, error);
    return { success: false, error };
  }
}
