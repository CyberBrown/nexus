// Task Executor - Execute queued tasks via DE (Distributed Electrons)
// Runs after dispatchTasks() to process queued work items

import type { Env, Task } from '../types/index.ts';
import { getEncryptionKey, decryptField } from '../lib/encryption.ts';
import { DEClient, createDEClient } from '../lib/de-client.ts';
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
 * Execute a single task via DE
 */
async function executeTask(
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

// ========================================
// Main Executor Function
// ========================================

/**
 * Execute queued tasks via DE
 * Only processes tasks routed to 'de-agent' or 'claude-ai' executors
 * (claude-code and human tasks require external executors)
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

  // Check if DE is available
  const deClient = createDEClient(env);
  if (!deClient) {
    console.log('DE service not available, skipping task execution');
    return stats;
  }

  // Verify DE is healthy
  const healthy = await deClient.healthCheck();
  if (!healthy) {
    console.warn('DE service health check failed, skipping task execution');
    stats.errors.push('DE service health check failed');
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

    // Process each tenant
    for (const tenant of tenants.results) {
      const tenantId = tenant.id;

      try {
        // Get queued tasks that can be executed by DE
        // Only process 'de-agent' and 'claude-ai' tasks
        // (claude-code requires Claude Code CLI, human requires human action)
        const entries = await env.DB.prepare(`
          SELECT eq.*, t.title, t.description, t.project_id, t.domain,
                 t.due_date, t.energy_required, t.source_type, t.source_reference
          FROM execution_queue eq
          JOIN tasks t ON eq.task_id = t.id
          WHERE eq.tenant_id = ?
            AND eq.status = 'queued'
            AND eq.executor_type IN ('de-agent', 'claude-ai')
          ORDER BY eq.priority DESC, eq.queued_at ASC
          LIMIT 10
        `).bind(tenantId).all<QueueEntry & TaskRow>();

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

            // Execute the task
            const result = await executeTask(deClient, entry, entry, encryptionKey);

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

  // Check status
  if (entry.status !== 'queued' && entry.status !== 'claimed') {
    return {
      success: false,
      error: `Queue entry has status '${entry.status}', expected 'queued' or 'claimed'`,
    };
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

  // Route based on executor type
  if (entry.executor_type === 'claude-code') {
    // Execute via sandbox-executor
    return executeCodeTask(env, entry, entry, encryptionKey, options);
  } else if (['de-agent', 'claude-ai'].includes(entry.executor_type)) {
    // Execute via DE
    const deClient = createDEClient(env);
    if (!deClient) {
      await failEntry(env.DB, entry, 'DE service not available');
      return { success: false, error: 'DE service not available' };
    }

    const healthy = await deClient.healthCheck();
    if (!healthy) {
      await failEntry(env.DB, entry, 'DE service health check failed');
      return { success: false, error: 'DE service health check failed' };
    }

    const result = await executeTask(deClient, entry, entry, encryptionKey);

    if (result.success && result.result) {
      await completeEntry(env.DB, entry, result.result);
      return { success: true, result: result.result };
    } else {
      const error = result.error || 'Unknown execution error';
      await failEntry(env.DB, entry, error);
      return { success: false, error };
    }
  } else {
    // Human tasks cannot be auto-executed
    return {
      success: false,
      error: `Cannot auto-execute ${entry.executor_type} tasks. Human tasks require manual action.`,
    };
  }
}

/**
 * Execute a code task via sandbox-executor
 * Uses service binding if available, falls back to URL.
 * For long-running tasks, marks as "dispatched" and returns immediately.
 */
async function executeCodeTask(
  env: Env,
  entry: QueueEntry,
  task: TaskRow,
  encryptionKey: CryptoKey | null,
  options?: { repo?: string; branch?: string; commitMessage?: string; waitForResult?: boolean }
): Promise<{ success: boolean; result?: string; error?: string; dispatched?: boolean }> {
  // Check for service binding first, then URL
  const useSandboxBinding = !!env.SANDBOX_EXECUTOR;
  const sandboxUrl = env.SANDBOX_EXECUTOR_URL;

  if (!useSandboxBinding && !sandboxUrl) {
    await failEntry(env.DB, entry, 'SANDBOX_EXECUTOR not configured (no binding or URL)');
    return { success: false, error: 'SANDBOX_EXECUTOR not configured' };
  }

  try {
    // Decrypt task fields
    const title = await safeDecrypt(task.title, encryptionKey);
    const description = await safeDecrypt(task.description, encryptionKey);

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

    // Determine repo/branch (options override context)
    const repo = options?.repo || (context?.repo as string) || null;
    const branch = options?.branch || (context?.branch as string) || 'main';
    const commitMessage = options?.commitMessage || (context?.commitMessage as string) || title.slice(0, 50);

    // Build task prompt
    const taskPrompt = `## Task: ${title}\n\n${description || ''}\n\n## Instructions\nComplete this code task. Generate the necessary code changes.`;

    // Build request body - include callback info for async completion
    const requestBody: Record<string, unknown> = {
      task: taskPrompt,
      context: context?.project ? `Project: ${context.project}` : 'Direct task execution',
      options: {
        max_tokens: 8192,
        temperature: 0.3,
      },
      // Include metadata for tracking
      metadata: {
        queue_entry_id: entry.id,
        task_id: entry.task_id,
        tenant_id: entry.tenant_id,
      },
    };

    if (repo) {
      requestBody.repo = repo;
      requestBody.branch = branch;
      requestBody.commitMessage = commitMessage;
    }

    console.log(`Executing code task via sandbox-executor: ${title}, repo: ${repo || 'none'}, branch: ${branch}`);

    // Mark entry as "dispatched" before calling sandbox-executor
    const now = new Date().toISOString();
    await env.DB.prepare(`
      UPDATE execution_queue SET status = 'dispatched', dispatched_at = ?, updated_at = ? WHERE id = ?
    `).bind(now, now, entry.id).run();

    // Call sandbox-executor using service binding or URL
    let response: Response;
    if (useSandboxBinding) {
      response = await env.SANDBOX_EXECUTOR!.fetch('https://sandbox-executor/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
    } else {
      response = await fetch(`${sandboxUrl}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
    }

    const data = await response.json() as {
      success: boolean;
      execution_id?: string;
      result?: {
        output: string;
        files?: Array<{ path: string; content: string }>;
      };
      commit?: {
        success: boolean;
        sha?: string;
        url?: string;
        branch?: string;
        error?: string;
      };
      error?: string;
    };

    if (!response.ok || !data.success) {
      const error = data.error || `HTTP ${response.status}`;
      await failEntry(env.DB, entry, error);
      return { success: false, error };
    }

    // Build result summary
    let resultText = data.result?.output || 'Task completed';
    if (data.result?.files && data.result.files.length > 0) {
      resultText += `\n\nGenerated ${data.result.files.length} file(s): ${data.result.files.map(f => f.path).join(', ')}`;
    }
    if (data.commit?.success) {
      resultText += `\n\nCommitted to ${data.commit.branch}: ${data.commit.sha}`;
      if (data.commit.url) {
        resultText += `\nURL: ${data.commit.url}`;
      }
    } else if (data.commit?.error) {
      resultText += `\n\nCommit failed: ${data.commit.error}`;
    }

    await completeEntry(env.DB, entry, resultText);
    return { success: true, result: resultText };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await failEntry(env.DB, entry, errorMsg);
    return { success: false, error: errorMsg };
  }
}
