// Task Executor - Execute queued tasks via sandbox-executor
// Runs after dispatchTasks() to process queued work items
//
// Routes tasks to sandbox-executor service:
// - claude-ai tasks -> /execute/sdk (fast AI path)
// - claude-code tasks -> /execute (container path)
// - de-agent tasks -> DE service binding (legacy)

import type { Env, Task } from '../types/index.ts';
import { getEncryptionKey, decryptField } from '../lib/encryption.ts';
import { DEClient, createDEClient } from '../lib/de-client.ts';
import { SandboxClient, createSandboxClient } from '../lib/sandbox-client.ts';
import type { ExecutorType } from './task-dispatcher.ts';

// ========================================
// Types
// ========================================

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
 */
async function failEntry(
  db: D1Database,
  entry: QueueEntry,
  error: string
): Promise<void> {
  const now = new Date().toISOString();
  const newRetryCount = entry.retry_count + 1;

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
    // No more retries - mark as failed
    await db.prepare(`
      UPDATE execution_queue
      SET status = 'failed', error = ?, retry_count = ?, updated_at = ?
      WHERE id = ?
    `).bind(error, newRetryCount, now, entry.id).run();

    await db.prepare(`
      INSERT INTO dispatch_log (id, tenant_id, queue_entry_id, task_id, executor_type, action, details, created_at)
      VALUES (?, ?, ?, ?, ?, 'failed', ?, ?)
    `).bind(
      crypto.randomUUID(),
      entry.tenant_id,
      entry.id,
      entry.task_id,
      entry.executor_type,
      JSON.stringify({ error, retry_count: newRetryCount, exhausted_retries: true }),
      now
    ).run();
  }
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
 * Execute a claude-ai task via sandbox-executor SDK path
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

    // Build prompt for SDK execution
    const prompt = buildTaskPrompt(title, description, context);

    // Execute via sandbox SDK path
    const response = await sandboxClient.executeQuick(prompt, {
      max_tokens: 2000,
      temperature: 0.7,
    });

    if (response.success && response.result) {
      return {
        success: true,
        result: response.result,
      };
    } else {
      return {
        success: false,
        error: response.error || 'SDK execution returned no result',
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
  encryptionKey: CryptoKey | null
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

    // Extract repo from context if available
    const repo = context?.repo as string | undefined;
    const branch = context?.branch as string | undefined;

    // Execute via sandbox container path
    const response = await sandboxClient.executeCode(taskDescription, {
      repo,
      branch,
      timeout_seconds: 600, // 10 minute timeout for code tasks
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

// ========================================
// Main Executor Function
// ========================================

/**
 * Execute queued tasks via sandbox-executor or DE
 *
 * Routes tasks based on executor_type:
 * - claude-ai -> sandbox-executor /execute/sdk (fast AI path)
 * - claude-code -> sandbox-executor /execute (container path)
 * - de-agent -> DE service binding (legacy)
 * - human -> skipped (requires human action)
 */
export async function executeTasks(env: Env): Promise<ExecutionStats> {
  console.log('Task executor starting...');

  const stats: ExecutionStats = {
    processed: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  // Check available execution services
  const sandboxClient = createSandboxClient(env);
  const deClient = createDEClient(env);

  // Check sandbox availability
  let sandboxAvailable = false;
  if (sandboxClient) {
    sandboxAvailable = await sandboxClient.isAvailable();
    if (sandboxAvailable) {
      console.log('Sandbox executor available');
    } else {
      console.warn('Sandbox executor configured but not healthy');
    }
  } else {
    console.log('Sandbox executor not configured (SANDBOX_EXECUTOR_URL not set)');
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
  if (!sandboxAvailable && !deAvailable) {
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

    // Build executor type filter based on available services
    const executorTypes: string[] = [];
    if (sandboxAvailable) {
      executorTypes.push('claude-ai', 'claude-code');
    }
    if (deAvailable) {
      executorTypes.push('de-agent');
    }

    if (executorTypes.length === 0) {
      console.log('No executor types available');
      return stats;
    }

    const executorTypePlaceholders = executorTypes.map(() => '?').join(', ');

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
          LIMIT 10
        `).bind(tenantId, ...executorTypes).all<QueueEntry & TaskRow>();

        if (!entries.results || entries.results.length === 0) {
          continue;
        }

        console.log(`Found ${entries.results.length} queued tasks for tenant ${tenantId}`);

        // Get encryption key for this tenant
        const encryptionKey = await getEncryptionKey(env.KV, tenantId);

        // Process each entry
        for (const entry of entries.results) {
          stats.processed++;

          try {
            // Try to claim the entry
            const claimed = await claimEntry(env.DB, entry, executorId);
            if (!claimed) {
              console.log(`Entry ${entry.id} already claimed, skipping`);
              stats.skipped++;
              continue;
            }

            console.log(`Executing task: ${entry.task_id} (${entry.executor_type})`);

            // Route to appropriate executor
            let result: { success: boolean; result?: string; error?: string };

            switch (entry.executor_type) {
              case 'claude-ai':
                if (!sandboxClient) {
                  result = { success: false, error: 'Sandbox executor not available for claude-ai task' };
                } else {
                  result = await executeTaskViaSandboxSdk(sandboxClient, entry, entry, encryptionKey);
                }
                break;

              case 'claude-code':
                if (!sandboxClient) {
                  result = { success: false, error: 'Sandbox executor not available for claude-code task' };
                } else {
                  result = await executeTaskViaSandboxContainer(sandboxClient, entry, entry, encryptionKey);
                }
                break;

              case 'de-agent':
                if (!deClient) {
                  result = { success: false, error: 'DE service not available for de-agent task' };
                } else {
                  result = await executeTaskViaDE(deClient, entry, entry, encryptionKey);
                }
                break;

              default:
                result = { success: false, error: `Unknown executor type: ${entry.executor_type}` };
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
 * - claude-ai -> sandbox-executor /execute/sdk
 * - claude-code -> sandbox-executor /execute
 * - de-agent -> DE service binding
 */
export async function executeQueueEntry(
  env: Env,
  queueId: string,
  tenantId: string,
  options?: { repo?: string; branch?: string; commitMessage?: string }
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

  // Validate executor type
  if (!['de-agent', 'claude-ai', 'claude-code'].includes(entry.executor_type)) {
    return {
      success: false,
      error: `Cannot execute ${entry.executor_type} tasks automatically. Only de-agent, claude-ai, and claude-code tasks are supported.`,
    };
  }

  // Check status
  if (entry.status !== 'queued' && entry.status !== 'claimed') {
    return {
      success: false,
      error: `Queue entry has status '${entry.status}', expected 'queued' or 'claimed'`,
    };
  }

  // Initialize clients based on executor type
  const sandboxClient = createSandboxClient(env);
  const deClient = createDEClient(env);

  // Check if the required executor is available
  if ((entry.executor_type === 'claude-ai' || entry.executor_type === 'claude-code') && !sandboxClient) {
    return { success: false, error: 'Sandbox executor not configured (SANDBOX_EXECUTOR_URL not set)' };
  }

  if (entry.executor_type === 'de-agent' && !deClient) {
    return { success: false, error: 'DE service not available' };
  }

  // Check service health
  if (entry.executor_type === 'claude-ai' || entry.executor_type === 'claude-code') {
    const available = await sandboxClient!.isAvailable();
    if (!available) {
      return { success: false, error: 'Sandbox executor not healthy' };
    }
  } else if (entry.executor_type === 'de-agent') {
    const healthy = await deClient!.healthCheck();
    if (!healthy) {
      return { success: false, error: 'DE service health check failed' };
    }
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

  // Route to appropriate executor
  let result: { success: boolean; result?: string; error?: string };

  switch (entry.executor_type) {
    case 'claude-ai':
      result = await executeTaskViaSandboxSdk(sandboxClient!, entry, entry, encryptionKey);
      break;

    case 'claude-code':
      result = await executeTaskViaSandboxContainer(sandboxClient!, entry, entry, encryptionKey);
      break;

    case 'de-agent':
      result = await executeTaskViaDE(deClient!, entry, entry, encryptionKey);
      break;

    default:
      result = { success: false, error: `Unknown executor type: ${entry.executor_type}` };
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
