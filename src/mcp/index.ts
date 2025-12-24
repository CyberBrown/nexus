/**
 * MCP Server for Nexus using Cloudflare Agents SDK
 *
 * Implements the Model Context Protocol for Claude.ai integration.
 * Uses the same pattern as developer-guides-mcp for proper OAuth handling.
 *
 * Authentication: Mnemo-style passphrase auth
 * - Read operations: No auth required
 * - Write operations: Require WRITE_PASSPHRASE in tool arguments
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpHandler } from 'agents/mcp';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Env } from '../types/index.ts';
import type { D1Database } from '@cloudflare/workers-types';
import { getEncryptionKey, encryptField, decryptField, decryptFields } from '../lib/encryption.ts';
import { executeQueueEntry } from '../scheduled/task-executor.ts';

// ========================================
// SAFE DECRYPT HELPER
// ========================================

/**
 * Safely decrypt a field, returning the original value if decryption fails.
 * This handles cases where data might be unencrypted (plain text) or NULL.
 */
async function safeDecrypt(value: unknown, key: CryptoKey | null): Promise<string> {
  if (!value || typeof value !== 'string') {
    return '';
  }
  try {
    return await decryptField(value, key);
  } catch {
    // If decryption fails, the value is likely plain text - return as-is
    return value;
  }
}

// ========================================
// EXECUTOR ROUTING NOTES
// ========================================

/**
 * Generate routing explanation for dispatch messages.
 * Currently all tasks route through claude-code (on-prem runner) since SDK mode isn't operational.
 */
function getRoutingNote(executorType: string): string {
  if (executorType === 'claude-code') {
    return 'Routes to on-prem claude-runner via Cloudflare Tunnel.';
  }
  if (executorType === 'claude-ai') {
    return 'Note: claude-ai tasks currently execute via claude-code path (SDK mode not yet operational).';
  }
  if (executorType === 'human') {
    return 'Requires human action - will not auto-execute.';
  }
  if (executorType === 'de-agent') {
    return 'Routes to DE service binding.';
  }
  return '';
}

// ========================================
// PASSPHRASE AUTH HELPERS
// ========================================

/**
 * Tools that modify data (create, update, delete, execute)
 * These require passphrase validation when WRITE_PASSPHRASE is set
 */
const WRITE_TOOLS = new Set([
  'nexus_create_task',
  'nexus_create_idea',
  'nexus_update_idea',
  'nexus_archive_idea',
  'nexus_delete_idea',
  'nexus_plan_idea',
  'nexus_execute_idea',
  'nexus_resolve_blocker',
  'nexus_cancel_execution',
  'nexus_log_decision',
  'nexus_capture',
  'nexus_update_task',
  'nexus_complete_task',
  'nexus_delete_task',
  'nexus_claim_task',
  // Notes tools
  'nexus_create_note',
  'nexus_update_note',
  'nexus_delete_note',
  'nexus_archive_note',
  // Queue tools
  'nexus_claim_queue_task',
  'nexus_complete_queue_task',
  'nexus_dispatch_task',
  'nexus_dispatch_ready',
  'nexus_execute_task',
  'nexus_run_executor',
  'nexus_reset_quarantine',
  'nexus_cleanup_queue',
]);

/**
 * Tools that only read data - no passphrase required
 */
const READ_TOOLS = new Set([
  'nexus_get_status',
  'nexus_get_idea',
  'nexus_list_ideas',
  'nexus_list_active',
  'nexus_list_blocked',
  'nexus_list_tasks',
  'nexus_trigger_task',
  // Notes read tools
  'nexus_list_notes',
  'nexus_get_note',
  'nexus_search_notes',
  // Queue read tools
  'nexus_check_queue',
  'nexus_queue_stats',
  'nexus_task_status',
  'nexus_list_quarantined',
]);

/**
 * Check if a tool is a write operation
 */
export function isWriteOperation(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

/**
 * Validate passphrase for write operations
 * Returns error result if validation fails, null if OK
 */
export function validatePassphrase(
  toolName: string,
  args: Record<string, unknown>,
  writePassphrase: string | undefined
): CallToolResult | null {
  // If no passphrase configured, skip validation (dev mode)
  if (!writePassphrase) {
    return null;
  }

  // Read operations don't need passphrase
  if (!isWriteOperation(toolName)) {
    return null;
  }

  // Check passphrase in arguments
  const providedPassphrase = args.passphrase as string | undefined;
  if (!providedPassphrase) {
    return {
      content: [{ type: 'text', text: 'Error: Write operation requires passphrase' }],
      isError: true,
    };
  }

  if (providedPassphrase !== writePassphrase) {
    return {
      content: [{ type: 'text', text: 'Error: Invalid passphrase' }],
      isError: true,
    };
  }

  return null; // Passphrase valid
}

/**
 * Optional passphrase schema for write tools
 */
const passphraseSchema = z.string().optional().describe('Passphrase for write operations (required when WRITE_PASSPHRASE is configured)');

// Factory function to create MCP server with bindings
export function createNexusMcpServer(env: Env, tenantId: string, userId: string) {
  const server = new McpServer(
    {
      name: 'nexus-mcp',
      version: '1.0.0',
    },
    { capabilities: { logging: {}, prompts: {} } }
  );

  // ========================================
  // TOOLS
  // ========================================

  // Tool: nexus_create_task - Create a task with optional immediate dispatch
  server.tool(
    'nexus_create_task',
    'Create a new task in Nexus. Use auto_dispatch=true to immediately queue it for execution instead of waiting for the 15-minute cron.',
    {
      title: z.string().describe('Task title. Prefix with a tag like [implement], [research], [human] to auto-route to the right executor'),
      description: z.string().optional().describe('Detailed description of what needs to be done'),
      status: z.enum(['inbox', 'next', 'scheduled', 'waiting', 'someday']).optional().describe('Task status (default: inbox). Use "next" for tasks ready to execute'),
      domain: z.enum(['work', 'personal', 'side_project', 'family', 'health']).optional().describe('Domain area (default: work)'),
      urgency: z.number().min(1).max(5).optional().describe('Urgency level 1-5 (default: 3)'),
      importance: z.number().min(1).max(5).optional().describe('Importance level 1-5 (default: 3)'),
      energy_required: z.enum(['low', 'medium', 'high']).optional().describe('Energy required (default: medium)'),
      due_date: z.string().optional().describe('Due date in ISO format (YYYY-MM-DD)'),
      project_id: z.string().uuid().optional().describe('Project ID to associate this task with'),
      time_estimate_minutes: z.number().optional().describe('Estimated time in minutes'),
      auto_dispatch: z.boolean().optional().describe('If true and status is "next", immediately queue for execution'),
      executor_type: z.enum(['claude-code', 'claude-ai', 'de-agent', 'human']).optional()
        .describe('Override auto-detected executor type (only used with auto_dispatch)'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      // Validate passphrase for write operation
      const authError = validatePassphrase('nexus_create_task', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      try {
        const encryptionKey = await getEncryptionKey(env.KV, tenantId);
        const now = new Date().toISOString();
        const taskId = crypto.randomUUID();

        const encryptedTitle = await encryptField(args.title, encryptionKey);
        const encryptedDescription = args.description ? await encryptField(args.description, encryptionKey) : null;

        const status = args.status || 'inbox';
        const domain = args.domain || 'work';
        const urgency = args.urgency || 3;
        const importance = args.importance || 3;
        const energyRequired = args.energy_required || 'medium';

        await env.DB.prepare(`
          INSERT INTO tasks (
            id, tenant_id, user_id, title, description, status, domain,
            urgency, importance, energy_required, due_date, project_id,
            time_estimate_minutes, source_type, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mcp', ?, ?)
        `).bind(
          taskId,
          tenantId,
          userId,
          encryptedTitle,
          encryptedDescription,
          status,
          domain,
          urgency,
          importance,
          energyRequired,
          args.due_date || null,
          args.project_id || null,
          args.time_estimate_minutes || null,
          now,
          now
        ).run();

        // Handle auto_dispatch if task is ready (status = 'next')
        let dispatchResult = null;
        if (args.auto_dispatch && status === 'next') {
          // Determine executor type
          let executorType = args.executor_type;
          if (!executorType) {
            // Auto-detect from title tag patterns
            const patterns: Array<{ pattern: RegExp; executor: 'claude-code' | 'claude-ai' | 'de-agent' | 'human' }> = [
              // Literal executor names (highest priority)
              { pattern: /^\[claude-code\]/i, executor: 'claude-code' },
              { pattern: /^\[claude-ai\]/i, executor: 'claude-ai' },
              { pattern: /^\[de-agent\]/i, executor: 'de-agent' },
              // Shorthand tags
              { pattern: /^\[CC\]/i, executor: 'claude-code' },
              { pattern: /^\[AI\]/i, executor: 'claude-ai' },
              { pattern: /^\[DE\]/i, executor: 'de-agent' },
              { pattern: /^\[HUMAN\]/i, executor: 'human' },
              { pattern: /^\[BLOCKED\]/i, executor: 'human' },
              // Semantic tags
              { pattern: /^\[implement\]/i, executor: 'claude-code' },
              { pattern: /^\[deploy\]/i, executor: 'claude-code' },
              { pattern: /^\[fix\]/i, executor: 'claude-code' },
              { pattern: /^\[refactor\]/i, executor: 'claude-code' },
              { pattern: /^\[test\]/i, executor: 'claude-code' },
              { pattern: /^\[debug\]/i, executor: 'claude-code' },
              { pattern: /^\[code\]/i, executor: 'claude-code' },
              { pattern: /^\[research\]/i, executor: 'claude-ai' },
              { pattern: /^\[design\]/i, executor: 'claude-ai' },
              { pattern: /^\[document\]/i, executor: 'claude-ai' },
              { pattern: /^\[analyze\]/i, executor: 'claude-ai' },
              { pattern: /^\[plan\]/i, executor: 'claude-ai' },
              { pattern: /^\[write\]/i, executor: 'claude-ai' },
              { pattern: /^\[review\]/i, executor: 'human' },
              { pattern: /^\[approve\]/i, executor: 'human' },
              { pattern: /^\[decide\]/i, executor: 'human' },
            ];

            for (const { pattern, executor } of patterns) {
              if (pattern.test(args.title)) {
                executorType = executor;
                break;
              }
            }
            executorType = executorType || 'human'; // Default to human if no pattern matches
          }

          // Create execution queue entry
          const queueId = crypto.randomUUID();
          const priority = urgency * importance;

          // Build context for executor
          const context = {
            task_id: taskId,
            title: args.title,
            description: args.description || null,
            urgency,
            importance,
            energy_required: energyRequired,
            domain,
            time_estimate_minutes: args.time_estimate_minutes || null,
          };
          const encryptedContext = await encryptField(JSON.stringify(context), encryptionKey);

          await env.DB.prepare(`
            INSERT INTO execution_queue (
              id, tenant_id, user_id, task_id, executor_type, status,
              priority, context, queued_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
          `).bind(
            queueId,
            tenantId,
            userId,
            taskId,
            executorType,
            priority,
            encryptedContext,
            now,
            now,
            now
          ).run();

          // Log the dispatch
          await env.DB.prepare(`
            INSERT INTO dispatch_log (id, tenant_id, queue_entry_id, task_id, executor_type, action, created_at)
            VALUES (?, ?, ?, ?, ?, 'queued', ?)
          `).bind(
            crypto.randomUUID(),
            tenantId,
            queueId,
            taskId,
            executorType,
            now
          ).run();

          dispatchResult = {
            dispatched: true,
            queue_id: queueId,
            executor_type: executorType,
            priority,
          };
        }

        const response: Record<string, unknown> = {
          success: true,
          task_id: taskId,
          title: args.title,
          status,
          message: dispatchResult
            ? `Task created and queued for ${dispatchResult.executor_type} executor. ${getRoutingNote(dispatchResult.executor_type)} Use nexus_task_status to track progress.`
            : status === 'next'
              ? `Task created with status "next". Use nexus_dispatch_task to queue it, or wait for the 15-minute cron.`
              : `Task created successfully.`,
        };

        if (dispatchResult) {
          response.dispatch = dispatchResult;
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(response, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_create_idea
  server.tool(
    'nexus_create_idea',
    'Create a new idea in Nexus for future planning and execution',
    {
      title: z.string().describe('Short, descriptive title for the idea'),
      description: z.string().optional().describe('Detailed description of the idea'),
      category: z.enum(['feature', 'improvement', 'bug', 'documentation', 'research', 'infrastructure', 'random']).optional().describe('Category for the idea'),
      domain: z.enum(['work', 'personal', 'side_project', 'family', 'health']).optional().describe('Domain area for the idea'),
      excitement_level: z.number().min(1).max(5).optional().describe('How excited are you about this idea? (1-5)'),
      feasibility: z.number().min(1).max(5).optional().describe('How feasible is this idea? (1-5)'),
      potential_impact: z.number().min(1).max(5).optional().describe('What is the potential impact? (1-5)'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      // Validate passphrase for write operation
      const authError = validatePassphrase('nexus_create_idea', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      try {
        const encryptionKey = await getEncryptionKey(env.KV, tenantId);
        const now = new Date().toISOString();
        const ideaId = crypto.randomUUID();

        const encryptedTitle = await encryptField(args.title, encryptionKey);
        const encryptedDescription = args.description ? await encryptField(args.description, encryptionKey) : null;

        await env.DB.prepare(`
          INSERT INTO ideas (
            id, tenant_id, user_id, title, description, category, domain,
            excitement_level, feasibility, potential_impact, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          ideaId,
          tenantId,
          userId,
          encryptedTitle,
          encryptedDescription,
          args.category || 'random',
          args.domain || null,
          args.excitement_level || null,
          args.feasibility || null,
          args.potential_impact || null,
          now,
          now
        ).run();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              idea_id: ideaId,
              title: args.title,
              message: `Idea "${args.title}" created successfully. Use nexus_plan_idea to generate an execution plan.`,
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_plan_idea
  server.tool(
    'nexus_plan_idea',
    'Trigger AI planning for an idea. Starts a workflow that generates an execution plan and waits for approval.',
    {
      idea_id: z.string().describe('The UUID of the idea to plan'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      // Validate passphrase for write operation
      const authError = validatePassphrase('nexus_plan_idea', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      const { idea_id } = args;
      try {
        // Verify idea exists
        const idea = await env.DB.prepare(`
          SELECT id, title, description FROM ideas
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
        `).bind(idea_id, tenantId).first<{ id: string; title: string; description: string }>();

        if (!idea) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Idea not found' }) }],
            isError: true
          };
        }

        const encryptionKey = await getEncryptionKey(env.KV, tenantId);
        const decryptedTitle = idea.title ? await safeDecrypt(idea.title, encryptionKey) : '';

        // Create execution record
        const executionId = crypto.randomUUID();
        const now = new Date().toISOString();

        await env.DB.prepare(`
          INSERT INTO idea_executions (
            id, idea_id, tenant_id, user_id, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
        `).bind(executionId, idea_id, tenantId, userId, now, now).run();

        // Start the planning workflow
        const instance = await env.IDEA_PLANNING_WORKFLOW.create({
          id: executionId,
          params: {
            idea_id,
            tenant_id: tenantId,
            user_id: userId,
            execution_id: executionId,
          },
        });

        // Update execution with workflow instance ID
        await env.DB.prepare(`
          UPDATE idea_executions SET workflow_instance_id = ?, updated_at = ? WHERE id = ?
        `).bind(instance.id, now, executionId).run();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              idea_id,
              title: decryptedTitle,
              execution_id: executionId,
              workflow_id: instance.id,
              message: 'Planning workflow started. The plan will be generated and then wait for your approval. Use nexus_get_status to check progress, then nexus_approve_plan to approve.',
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_approve_plan
  server.tool(
    'nexus_approve_plan',
    'Approve or reject a generated plan. The workflow will proceed to create tasks if approved.',
    {
      idea_id: z.string().describe('The UUID of the idea with a pending plan'),
      approved: z.boolean().describe('Whether to approve the plan'),
      remove_steps: z.array(z.number()).optional().describe('Step order numbers to remove from the plan'),
      notes: z.string().optional().describe('Notes about the approval decision'),
    },
    async ({ idea_id, approved, remove_steps, notes }): Promise<CallToolResult> => {
      try {
        // Get the execution record - look for planning status with plan_review phase
        // (status='planned' was never used; workflow uses status='planning' + phase='plan_review')
        const execution = await env.DB.prepare(`
          SELECT id, workflow_instance_id, status, phase FROM idea_executions
          WHERE idea_id = ? AND tenant_id = ?
            AND (status = 'planned' OR (status = 'planning' AND phase = 'plan_review'))
          ORDER BY created_at DESC LIMIT 1
        `).bind(idea_id, tenantId).first<{ id: string; workflow_instance_id: string; status: string; phase: string }>();

        if (!execution) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No pending plan found for this idea. Run nexus_plan_idea first and wait for planning to complete (status must be planning with phase plan_review).' }) }],
            isError: true
          };
        }

        if (!execution.workflow_instance_id) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No workflow instance found' }) }],
            isError: true
          };
        }

        // Get the workflow instance and send the approval event
        const instance = await env.IDEA_PLANNING_WORKFLOW.get(execution.workflow_instance_id);

        // Send the approval event to resume the workflow
        // This triggers the waitForEvent('plan-approved') in IdeaPlanningWorkflow
        await instance.sendEvent({
          type: 'plan-approved',
          payload: {
            approved,
            modifications: {
              remove_steps: remove_steps || [],
              notes: notes || '',
            },
          },
        });

        // Also update database status for immediate visibility
        const now = new Date().toISOString();
        if (!approved) {
          // For rejection, update DB immediately (workflow will also update, but this gives faster feedback)
          await env.DB.prepare(`
            UPDATE idea_executions
            SET status = 'cancelled', error_message = ?, updated_at = ?
            WHERE id = ?
          `).bind(notes || 'Plan rejected by user', now, execution.id).run();
        }
        // Note: For approval, let the workflow update the status after creating tasks

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              idea_id,
              execution_id: execution.id,
              approved,
              message: approved
                ? 'Plan approved. Tasks will be created from the plan. Use nexus_get_status to monitor progress.'
                : 'Plan rejected. The idea has been reset to "new" status.',
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_execute_idea (now sends approval to start task creation)
  server.tool(
    'nexus_execute_idea',
    'Approve and execute a planned idea by creating tasks from the generated plan. Shortcut for nexus_approve_plan with approved=true.',
    {
      idea_id: z.string().describe('The UUID of the idea to execute (must have a plan)'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      // Validate passphrase for write operation
      const authError = validatePassphrase('nexus_execute_idea', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      const { idea_id } = args;
      try {
        // Get the execution record with plan - look for planning status with plan_review phase
        // (status='planned' was never used; workflow uses status='planning' + phase='plan_review')
        const execution = await env.DB.prepare(`
          SELECT id, workflow_instance_id, status, phase, plan FROM idea_executions
          WHERE idea_id = ? AND tenant_id = ?
            AND (status = 'planned' OR (status = 'planning' AND phase = 'plan_review'))
          ORDER BY created_at DESC LIMIT 1
        `).bind(idea_id, tenantId).first<{ id: string; workflow_instance_id: string; status: string; phase: string; plan: string }>();

        if (!execution) {
          // Check if there's a pending/planning execution without plan_review
          const pendingExecution = await env.DB.prepare(`
            SELECT status, phase FROM idea_executions
            WHERE idea_id = ? AND tenant_id = ? AND status IN ('pending', 'planning')
            ORDER BY created_at DESC LIMIT 1
          `).bind(idea_id, tenantId).first<{ status: string; phase: string }>();

          if (pendingExecution) {
            return {
              content: [{ type: 'text', text: JSON.stringify({
                success: false,
                error: `Planning still in progress (status: ${pendingExecution.status}, phase: ${pendingExecution.phase}). Wait for phase to be 'plan_review'.`
              }) }],
              isError: true
            };
          }

          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No pending execution found. Run nexus_plan_idea first and wait for planning to complete.' }) }],
            isError: true
          };
        }

        // Parse plan to show task count
        let taskCount = 0;
        if (execution.plan) {
          try {
            const plan = JSON.parse(execution.plan);
            taskCount = plan.steps?.length || 0;
          } catch {
            // Ignore parse errors
          }
        }

        // Send approval event to workflow to trigger task creation
        if (execution.workflow_instance_id) {
          const instance = await env.IDEA_PLANNING_WORKFLOW.get(execution.workflow_instance_id);
          await instance.sendEvent({
            type: 'plan-approved',
            payload: {
              approved: true,
              modifications: {
                remove_steps: [],
                notes: '',
              },
            },
          });
        }
        // Note: Workflow will update status to 'executing' after creating tasks

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              idea_id,
              execution_id: execution.id,
              tasks_planned: taskCount,
              message: `Execution approved. ${taskCount} tasks will be created from the plan. Use nexus_get_status to monitor progress.`,
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_get_status
  server.tool(
    'nexus_get_status',
    'Get the current execution status for an idea, including plan details, task progress, workflow status, and any blockers',
    {
      idea_id: z.string().describe('The UUID of the idea to check'),
    },
    async ({ idea_id }): Promise<CallToolResult> => {
      try {
        // Get idea details (execution_status is derived from idea_executions, not stored on ideas)
        const idea = await env.DB.prepare(`
          SELECT id, title, category, created_at FROM ideas
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
        `).bind(idea_id, tenantId).first();

        if (!idea) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Idea not found' }) }],
            isError: true
          };
        }

        // Decrypt title
        const encryptionKey = await getEncryptionKey(env.KV, tenantId);
        const decryptedTitle = idea.title ? await safeDecrypt(idea.title as string, encryptionKey) : '';

        // Get execution from DB (this is the source of truth for execution status)
        const execution = await env.DB.prepare(`
          SELECT * FROM idea_executions
          WHERE idea_id = ? AND tenant_id = ?
          ORDER BY created_at DESC LIMIT 1
        `).bind(idea_id, tenantId).first();

        // Get workflow status if we have an instance ID
        let workflowStatus = null;
        if (execution?.workflow_instance_id) {
          try {
            const instance = await env.IDEA_PLANNING_WORKFLOW.get(execution.workflow_instance_id as string);
            const status = await instance.status();
            workflowStatus = {
              id: execution.workflow_instance_id,
              status: status.status,
              output: status.output,
              error: status.error,
            };
          } catch {
            // Workflow instance may not exist or be accessible
            workflowStatus = { id: execution.workflow_instance_id, status: 'unknown' };
          }
        }

        // Get task progress
        const taskStats = await env.DB.prepare(`
          SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
            SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress
          FROM idea_tasks
          WHERE idea_id = ? AND tenant_id = ? AND deleted_at IS NULL
        `).bind(idea_id, tenantId).first();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              idea: {
                id: idea_id,
                title: decryptedTitle,
                category: idea.category,
                execution_status: execution ? execution.status : 'none',
                created_at: idea.created_at,
              },
              execution: execution ? {
                id: execution.id,
                status: execution.status,
                plan: execution.plan ? JSON.parse(execution.plan as string) : null,
                total_tasks: execution.total_tasks,
                completed_tasks: execution.completed_tasks,
                started_at: execution.started_at,
                planned_at: execution.planned_at,
                completed_at: execution.completed_at,
                error_message: execution.error_message,
                blockers: execution.blockers ? JSON.parse(execution.blockers as string) : [],
              } : null,
              workflow: workflowStatus,
              task_progress: taskStats ? {
                total: taskStats.total,
                completed: taskStats.completed,
                failed: taskStats.failed,
                in_progress: taskStats.in_progress,
              } : null,
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_get_idea - Returns full idea details including description
  server.tool(
    'nexus_get_idea',
    'Get full details of an idea including its description content. Use this to access the complete idea context.',
    {
      idea_id: z.string().describe('The UUID of the idea to retrieve'),
    },
    async ({ idea_id }): Promise<CallToolResult> => {
      try {
        const idea = await env.DB.prepare(`
          SELECT id, title, description, category, domain,
                 excitement_level, feasibility, potential_impact,
                 created_at, updated_at
          FROM ideas
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
        `).bind(idea_id, tenantId).first();

        if (!idea) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Idea not found' }) }],
            isError: true
          };
        }

        const encryptionKey = await getEncryptionKey(env.KV, tenantId);
        const decryptedTitle = idea.title ? await safeDecrypt(idea.title as string, encryptionKey) : '';
        const decryptedDescription = idea.description ? await safeDecrypt(idea.description as string, encryptionKey) : '';

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              idea: {
                id: idea.id,
                title: decryptedTitle,
                description: decryptedDescription,
                category: idea.category,
                domain: idea.domain,
                excitement_level: idea.excitement_level,
                feasibility: idea.feasibility,
                potential_impact: idea.potential_impact,
                created_at: idea.created_at,
                updated_at: idea.updated_at,
              },
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_trigger_task - Returns full context needed to execute a task
  server.tool(
    'nexus_trigger_task',
    'Get full context needed to execute a task, including parent idea details and execution plan. Use this before starting work on a task.',
    {
      task_id: z.string().describe('The UUID of the task to get context for'),
    },
    async ({ task_id }): Promise<CallToolResult> => {
      try {
        // Get task with source reference to find parent idea
        const task = await env.DB.prepare(`
          SELECT id, title, description, status, source_type, source_reference,
                 urgency, importance, energy_required, time_estimate_minutes,
                 claimed_by, claimed_at, created_at
          FROM tasks
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
        `).bind(task_id, tenantId).first();

        if (!task) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Task not found' }) }],
            isError: true
          };
        }

        const encryptionKey = await getEncryptionKey(env.KV, tenantId);
        const decryptedTaskTitle = await safeDecrypt(task.title, encryptionKey);
        const decryptedTaskDescription = await safeDecrypt(task.description, encryptionKey);

        // Parse source_reference to get idea and execution IDs
        // Format: "idea:{ideaId}:execution:{executionId}" OR just a UUID (legacy)
        let ideaContext = null;
        let executionContext = null;
        const sourceRef = task.source_reference as string;

        // Try to extract idea ID from source_reference
        let ideaId: string | null = null;
        let executionId: string | null = null;

        if (sourceRef) {
          if (sourceRef.startsWith('idea:')) {
            // New format: "idea:{ideaId}:execution:{executionId}"
            const parts = sourceRef.split(':');
            ideaId = parts[1] ?? null;
            executionId = parts[3] ?? null;
          } else {
            // Legacy format: might be just an execution ID, try to look it up
            const execution = await env.DB.prepare(`
              SELECT idea_id FROM idea_executions WHERE id = ? AND tenant_id = ?
            `).bind(sourceRef, tenantId).first<{ idea_id: string }>();
            if (execution) {
              ideaId = execution.idea_id;
              executionId = sourceRef;
            }
          }
        }

        if (ideaId) {
          // Get parent idea
          const idea = await env.DB.prepare(`
            SELECT id, title, description, category, domain
            FROM ideas
            WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
          `).bind(ideaId, tenantId).first();

          if (idea) {
            const decryptedIdeaTitle = await safeDecrypt(idea.title, encryptionKey);
            const decryptedIdeaDescription = await safeDecrypt(idea.description, encryptionKey);

            ideaContext = {
              id: idea.id,
              title: decryptedIdeaTitle,
              description: decryptedIdeaDescription,
              category: idea.category,
              domain: idea.domain,
            };
          }

          // Get execution plan
          if (executionId) {
            const execution = await env.DB.prepare(`
              SELECT id, plan, phase, status
              FROM idea_executions
              WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
            `).bind(executionId, tenantId).first();

            if (execution && execution.plan) {
              executionContext = {
                id: execution.id,
                phase: execution.phase,
                status: execution.status,
                plan: JSON.parse(execution.plan as string),
              };
            }
          }
        }

        // Check if task is ready to work on
        const isReady = task.status === 'inbox' || task.status === 'next';
        const isClaimed = !!task.claimed_by;

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              task: {
                id: task.id,
                title: decryptedTaskTitle,
                description: decryptedTaskDescription,
                status: task.status,
                source_type: task.source_type,
                urgency: task.urgency,
                importance: task.importance,
                energy_required: task.energy_required,
                time_estimate_minutes: task.time_estimate_minutes,
                claimed_by: task.claimed_by,
                claimed_at: task.claimed_at,
              },
              idea: ideaContext,
              execution: executionContext,
              ready: isReady && !isClaimed,
              message: isClaimed
                ? `Task already claimed by ${task.claimed_by} at ${task.claimed_at}`
                : isReady
                  ? 'Task is ready to be claimed and executed'
                  : `Task status is "${task.status}" - may not be ready for execution`,
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_task_status - Track a task's full execution journey
  server.tool(
    'nexus_task_status',
    'Get complete status of a task including its execution queue state and timeline. Use this to track progress of tasks you\'ve dispatched.',
    {
      task_id: z.string().uuid().describe('The UUID of the task to check status for'),
    },
    async ({ task_id }): Promise<CallToolResult> => {
      try {
        const encryptionKey = await getEncryptionKey(env.KV, tenantId);

        // Get task details
        const task = await env.DB.prepare(`
          SELECT id, title, description, status, source_type, source_reference,
                 urgency, importance, energy_required, time_estimate_minutes,
                 claimed_by, claimed_at, completed_at, created_at, updated_at
          FROM tasks
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
        `).bind(task_id, tenantId).first();

        if (!task) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Task not found' }) }],
            isError: true
          };
        }

        const decryptedTitle = await safeDecrypt(task.title, encryptionKey);

        // Get current execution queue entry (if any)
        const queueEntry = await env.DB.prepare(`
          SELECT id, executor_type, status, priority, context,
                 queued_at, claimed_at, claimed_by, completed_at, result, error,
                 retry_count, max_retries
          FROM execution_queue
          WHERE task_id = ? AND tenant_id = ?
          ORDER BY queued_at DESC
          LIMIT 1
        `).bind(task_id, tenantId).first();

        // Get dispatch log timeline for this task
        const timeline = await env.DB.prepare(`
          SELECT action, details, created_at
          FROM dispatch_log
          WHERE task_id = ? AND tenant_id = ?
          ORDER BY created_at ASC
          LIMIT 50
        `).bind(task_id, tenantId).all<{ action: string; details: string | null; created_at: string }>();

        // Build timeline with task creation as first event
        const events: Array<{ action: string; at: string; details?: Record<string, unknown> }> = [
          { action: 'created', at: task.created_at as string }
        ];

        // Add dispatch log events
        for (const log of timeline.results || []) {
          const event: { action: string; at: string; details?: Record<string, unknown> } = {
            action: log.action,
            at: log.created_at,
          };
          if (log.details) {
            try {
              event.details = JSON.parse(log.details);
            } catch {
              event.details = { raw: log.details };
            }
          }
          events.push(event);
        }

        // Determine overall status
        let overallStatus: string;
        let statusMessage: string;

        if (task.status === 'completed') {
          overallStatus = 'completed';
          statusMessage = `Task completed at ${task.completed_at}`;
        } else if (task.status === 'cancelled') {
          overallStatus = 'cancelled';
          statusMessage = 'Task was cancelled';
        } else if (queueEntry) {
          overallStatus = queueEntry.status as string;
          switch (queueEntry.status) {
            case 'queued':
              statusMessage = `Waiting in queue for ${queueEntry.executor_type} executor (priority: ${queueEntry.priority})`;
              break;
            case 'claimed':
              statusMessage = `Being worked on by ${queueEntry.claimed_by} since ${queueEntry.claimed_at}`;
              break;
            case 'dispatched':
              statusMessage = `Dispatched to ${queueEntry.executor_type}, awaiting completion`;
              break;
            case 'completed':
              overallStatus = 'execution_completed';
              statusMessage = `Execution completed at ${queueEntry.completed_at}`;
              break;
            case 'failed':
              statusMessage = `Execution failed: ${queueEntry.error || 'Unknown error'} (retries: ${queueEntry.retry_count}/${queueEntry.max_retries})`;
              break;
            default:
              statusMessage = `Queue status: ${queueEntry.status}`;
          }
        } else if (task.status === 'next') {
          overallStatus = 'ready';
          statusMessage = 'Task is ready but not yet dispatched to queue. Use nexus_dispatch_task to queue it.';
        } else {
          overallStatus = task.status as string;
          statusMessage = `Task status: ${task.status}`;
        }

        // Build execution info
        const executionInfo = queueEntry ? {
          queue_id: queueEntry.id,
          queue_status: queueEntry.status,
          executor_type: queueEntry.executor_type,
          priority: queueEntry.priority,
          queued_at: queueEntry.queued_at,
          claimed_at: queueEntry.claimed_at,
          claimed_by: queueEntry.claimed_by,
          completed_at: queueEntry.completed_at,
          result: queueEntry.result ? (() => {
            try { return JSON.parse(queueEntry.result as string); }
            catch { return queueEntry.result; }
          })() : null,
          error: queueEntry.error,
          retry_count: queueEntry.retry_count,
          max_retries: queueEntry.max_retries,
        } : null;

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              overall_status: overallStatus,
              message: statusMessage,
              task: {
                id: task.id,
                title: decryptedTitle,
                status: task.status,
                created_at: task.created_at,
                updated_at: task.updated_at,
                completed_at: task.completed_at,
              },
              execution: executionInfo,
              timeline: events,
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_claim_task - Executor claims a task to prevent duplicate work
  server.tool(
    'nexus_claim_task',
    'Claim a task for execution. This prevents duplicate work by marking who is working on it. Returns full context needed to execute.',
    {
      task_id: z.string().describe('The UUID of the task to claim'),
      executor_id: z.string().describe('Identifier of the executor claiming the task (e.g., "claude-code", "claude-ai", "human")'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      const authError = validatePassphrase('nexus_claim_task', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      const { task_id, executor_id } = args;

      try {
        // Check if task exists and is not already claimed
        const task = await env.DB.prepare(`
          SELECT id, title, description, status, source_type, source_reference,
                 urgency, importance, claimed_by, claimed_at
          FROM tasks
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
        `).bind(task_id, tenantId).first();

        if (!task) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Task not found' }) }],
            isError: true
          };
        }

        // Check if already claimed by someone else
        if (task.claimed_by && task.claimed_by !== executor_id) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: `Task already claimed by ${task.claimed_by} at ${task.claimed_at}`,
                claimed_by: task.claimed_by,
                claimed_at: task.claimed_at,
              })
            }],
            isError: true
          };
        }

        const now = new Date().toISOString();
        const encryptionKey = await getEncryptionKey(env.KV, tenantId);

        // Claim the task
        await env.DB.prepare(`
          UPDATE tasks SET claimed_by = ?, claimed_at = ?, status = 'next', updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).bind(executor_id, now, now, task_id, tenantId).run();

        // Decrypt task fields (using safeDecrypt for mixed encrypted/plain data)
        const decryptedTaskTitle = await safeDecrypt(task.title, encryptionKey);
        const decryptedTaskDescription = await safeDecrypt(task.description, encryptionKey);

        // Get parent idea context
        let ideaContext = null;
        const sourceRef = task.source_reference as string;

        // Try to extract idea ID from source_reference
        let ideaId: string | null = null;

        if (sourceRef) {
          if (sourceRef.startsWith('idea:')) {
            // New format: "idea:{ideaId}:execution:{executionId}"
            const parts = sourceRef.split(':');
            ideaId = parts[1] ?? null;
          } else {
            // Legacy format: might be just an execution ID, try to look it up
            const execution = await env.DB.prepare(`
              SELECT idea_id FROM idea_executions WHERE id = ? AND tenant_id = ?
            `).bind(sourceRef, tenantId).first<{ idea_id: string }>();
            if (execution) {
              ideaId = execution.idea_id;
            }
          }
        }

        if (ideaId) {
          const idea = await env.DB.prepare(`
            SELECT id, title, description, category, domain
            FROM ideas
            WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
          `).bind(ideaId, tenantId).first();

          if (idea) {
            const decryptedIdeaTitle = await safeDecrypt(idea.title, encryptionKey);
            const decryptedIdeaDescription = await safeDecrypt(idea.description, encryptionKey);

            ideaContext = {
              id: idea.id,
              title: decryptedIdeaTitle,
              description: decryptedIdeaDescription,
              category: idea.category,
              domain: idea.domain,
            };
          }
        }

        // Log the decision
        await env.DB.prepare(`
          INSERT INTO decisions (id, tenant_id, user_id, entity_type, entity_id, decision, reasoning, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          crypto.randomUUID(),
          tenantId,
          userId,
          'task',
          task_id,
          'claimed',
          `Claimed by ${executor_id}`,
          now
        ).run();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              claimed: true,
              task: {
                id: task.id,
                title: decryptedTaskTitle,
                description: decryptedTaskDescription,
                status: 'next',
                source_type: task.source_type,
              },
              idea: ideaContext,
              claimed_by: executor_id,
              claimed_at: now,
              message: `Task claimed successfully. You are now responsible for executing this task.`,
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_list_ideas
  server.tool(
    'nexus_list_ideas',
    'List all ideas in the system with their execution status',
    {
      status: z.enum(['all', 'no_execution', 'planning', 'in_progress', 'completed', 'blocked']).optional().describe('Filter by execution status'),
      category: z.string().optional().describe('Filter by idea category'),
      limit: z.number().optional().default(20).describe('Maximum number of ideas to return'),
    },
    async ({ status, category, limit }): Promise<CallToolResult> => {
      try {
        // Use a subquery to get only the most recent execution per idea
        // This prevents duplicates when an idea has multiple execution records
        let query = `
          SELECT
            i.id,
            i.title,
            i.description,
            i.category,
            i.created_at,
            latest_exec.status as execution_status,
            latest_exec.phase as execution_phase
          FROM ideas i
          LEFT JOIN (
            SELECT e1.*
            FROM idea_executions e1
            INNER JOIN (
              SELECT idea_id, MAX(created_at) as max_created
              FROM idea_executions
              WHERE deleted_at IS NULL
              GROUP BY idea_id
            ) e2 ON e1.idea_id = e2.idea_id AND e1.created_at = e2.max_created
            WHERE e1.deleted_at IS NULL
          ) latest_exec ON i.id = latest_exec.idea_id
          WHERE i.tenant_id = ? AND i.deleted_at IS NULL AND i.archived_at IS NULL
        `;

        const bindings: unknown[] = [tenantId];

        if (category) {
          query += ' AND i.category = ?';
          bindings.push(category);
        }

        if (status && status !== 'all') {
          if (status === 'no_execution') {
            query += ' AND latest_exec.id IS NULL';
          } else {
            query += ' AND latest_exec.status = ?';
            bindings.push(status);
          }
        }

        query += ' ORDER BY i.created_at DESC LIMIT ?';
        bindings.push(limit || 20);

        const ideas = await env.DB.prepare(query).bind(...bindings).all();

        // Decrypt titles (safeDecrypt handles plain text gracefully)
        const encryptionKey = await getEncryptionKey(env.KV, tenantId);
        const decryptedIdeas = await Promise.all(
          ideas.results.map(async (idea: Record<string, unknown>) => ({
            id: idea.id,
            title: idea.title ? await safeDecrypt(idea.title as string, encryptionKey) : '',
            category: idea.category,
            created_at: idea.created_at,
            execution_status: idea.execution_status || 'none',
            execution_phase: idea.execution_phase,
          }))
        );

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              count: decryptedIdeas.length,
              ideas: decryptedIdeas,
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_list_active
  server.tool(
    'nexus_list_active',
    'List all active executions currently in progress or blocked',
    {},
    async (): Promise<CallToolResult> => {
      try {
        const executions = await env.DB.prepare(`
          SELECT
            e.*,
            i.title as idea_title
          FROM idea_executions e
          JOIN ideas i ON e.idea_id = i.id
          WHERE e.tenant_id = ? AND e.deleted_at IS NULL
            AND e.status IN ('pending', 'planning', 'in_progress', 'blocked')
          ORDER BY e.updated_at DESC
        `).bind(tenantId).all();

        const encryptionKey = await getEncryptionKey(env.KV, tenantId);
        const decrypted = await Promise.all(
          executions.results.map(async (e: Record<string, unknown>) => ({
            execution_id: e.id,
            idea_id: e.idea_id,
            title: e.idea_title ? await safeDecrypt(e.idea_title as string, encryptionKey) : '',
            status: e.status,
            phase: e.phase,
            started_at: e.started_at,
            blockers: e.blockers ? JSON.parse(e.blockers as string) : [],
          }))
        );

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              count: decrypted.length,
              executions: decrypted,
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_list_blocked
  server.tool(
    'nexus_list_blocked',
    'List all executions that are currently blocked and need human input',
    {},
    async (): Promise<CallToolResult> => {
      try {
        const executions = await env.DB.prepare(`
          SELECT
            e.*,
            i.title as idea_title
          FROM idea_executions e
          JOIN ideas i ON e.idea_id = i.id
          WHERE e.tenant_id = ? AND e.deleted_at IS NULL
            AND e.status = 'blocked'
          ORDER BY e.updated_at DESC
        `).bind(tenantId).all();

        const encryptionKey = await getEncryptionKey(env.KV, tenantId);
        const decrypted = await Promise.all(
          executions.results.map(async (e: Record<string, unknown>) => ({
            execution_id: e.id,
            idea_id: e.idea_id,
            title: e.idea_title ? await safeDecrypt(e.idea_title as string, encryptionKey) : '',
            blockers: e.blockers ? JSON.parse(e.blockers as string) : [],
            started_at: e.started_at,
          }))
        );

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              count: decrypted.length,
              blocked: decrypted,
              message: decrypted.length > 0
                ? 'Use nexus_resolve_blocker to resolve blockers and continue execution.'
                : 'No blocked executions.',
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_resolve_blocker
  server.tool(
    'nexus_resolve_blocker',
    'Resolve a blocker on an execution by providing a resolution',
    {
      idea_id: z.string().describe('The UUID of the idea with the blocker'),
      blocker_id: z.string().describe('The UUID of the specific blocker to resolve'),
      resolution: z.string().describe('How the blocker was resolved (decision made, info provided, etc.)'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      // Validate passphrase for write operation
      const authError = validatePassphrase('nexus_resolve_blocker', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      const { idea_id, blocker_id, resolution } = args;
      try {
        // Find the execution with blockers in DB (not using DO which has no persistent state)
        const execution = await env.DB.prepare(`
          SELECT id, status, phase, blockers FROM idea_executions
          WHERE idea_id = ? AND tenant_id = ?
          ORDER BY created_at DESC LIMIT 1
        `).bind(idea_id, tenantId).first<{ id: string; status: string; phase: string; blockers: string | null }>();

        if (!execution) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: 'No execution found for this idea.'
            }) }],
            isError: true
          };
        }

        // Parse blockers
        let blockers: Array<{ id: string; description: string; resolved?: boolean; resolution?: string; resolved_at?: string }> = [];
        if (execution.blockers) {
          try {
            blockers = JSON.parse(execution.blockers);
          } catch {
            blockers = [];
          }
        }

        if (blockers.length === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: 'No blockers found for this execution.'
            }) }],
            isError: true
          };
        }

        // Find and resolve the blocker
        const blockerIndex = blockers.findIndex(b => b.id === blocker_id);
        if (blockerIndex === -1) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: `Blocker with ID ${blocker_id} not found. Available blockers: ${blockers.map(b => b.id).join(', ')}`
            }) }],
            isError: true
          };
        }

        const blocker = blockers[blockerIndex];
        if (!blocker) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: `Blocker at index ${blockerIndex} not found.`
            }) }],
            isError: true
          };
        }

        if (blocker.resolved) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: `Blocker ${blocker_id} is already resolved.`
            }) }],
            isError: true
          };
        }

        // Mark as resolved
        const now = new Date().toISOString();
        blockers[blockerIndex] = {
          id: blocker.id,
          description: blocker.description,
          resolved: true,
          resolution,
          resolved_at: now,
        };

        // Check if all blockers are resolved
        const unresolvedBlockers = blockers.filter(b => !b.resolved);
        const allResolved = unresolvedBlockers.length === 0;

        // Update the execution
        const newStatus = allResolved && execution.status === 'blocked' ? 'executing' : execution.status;
        await env.DB.prepare(`
          UPDATE idea_executions
          SET blockers = ?, status = ?, updated_at = ?
          WHERE id = ?
        `).bind(JSON.stringify(blockers), newStatus, now, execution.id).run();

        // Log the decision
        await env.DB.prepare(`
          INSERT INTO decisions (id, tenant_id, user_id, entity_type, entity_id, decision, reasoning, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          crypto.randomUUID(),
          tenantId,
          userId,
          'execution',
          idea_id,
          'resolved_blocker',
          `Blocker: ${blocker.description}\nResolution: ${resolution}`,
          now
        ).run();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              idea_id,
              execution_id: execution.id,
              blocker_id,
              blocker_description: blocker.description,
              resolution,
              all_blockers_resolved: allResolved,
              remaining_blockers: unresolvedBlockers.length,
              new_status: newStatus,
              message: allResolved
                ? 'All blockers resolved. Execution resumed.'
                : `Blocker resolved. ${unresolvedBlockers.length} blocker(s) remaining.`,
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_cancel_execution
  server.tool(
    'nexus_cancel_execution',
    'Cancel an in-progress execution with a reason',
    {
      idea_id: z.string().describe('The UUID of the idea to cancel execution for'),
      reason: z.string().optional().describe('Why the execution is being cancelled'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      // Validate passphrase for write operation
      const authError = validatePassphrase('nexus_cancel_execution', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      const { idea_id, reason } = args;
      try {
        const cancelReason = reason || 'Cancelled via MCP';

        // Find the active execution in DB (not using DO which has no persistent state)
        const execution = await env.DB.prepare(`
          SELECT id, status, phase FROM idea_executions
          WHERE idea_id = ? AND tenant_id = ?
            AND status NOT IN ('completed', 'failed', 'cancelled')
          ORDER BY created_at DESC LIMIT 1
        `).bind(idea_id, tenantId).first<{ id: string; status: string; phase: string }>();

        if (!execution) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: 'No active execution found for this idea. It may already be completed, failed, or cancelled.'
            }) }],
            isError: true
          };
        }

        const now = new Date().toISOString();

        // Update the execution to cancelled
        await env.DB.prepare(`
          UPDATE idea_executions
          SET status = 'cancelled', error = ?, updated_at = ?
          WHERE id = ?
        `).bind(cancelReason, now, execution.id).run();

        // Log the decision
        await env.DB.prepare(`
          INSERT INTO decisions (id, tenant_id, user_id, entity_type, entity_id, decision, reasoning, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          crypto.randomUUID(),
          tenantId,
          userId,
          'execution',
          idea_id,
          'cancelled',
          cancelReason,
          now
        ).run();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              idea_id,
              execution_id: execution.id,
              previous_status: execution.status,
              previous_phase: execution.phase,
              message: `Execution cancelled. Reason: ${cancelReason}`,
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_log_decision
  server.tool(
    'nexus_log_decision',
    'Log a CEO decision for the decision log',
    {
      entity_type: z.enum(['idea', 'task', 'project', 'execution']).describe('Type of entity the decision is about'),
      entity_id: z.string().describe('UUID of the entity'),
      decision: z.enum(['approved', 'rejected', 'deferred', 'modified', 'cancelled']).describe('The decision made'),
      reasoning: z.string().optional().describe('Why this decision was made'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      // Validate passphrase for write operation
      const authError = validatePassphrase('nexus_log_decision', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      const { entity_type, entity_id, decision, reasoning } = args;
      try {
        const decisionId = crypto.randomUUID();

        await env.DB.prepare(`
          INSERT INTO decisions (id, tenant_id, user_id, entity_type, entity_id, decision, reasoning, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          decisionId,
          tenantId,
          userId,
          entity_type,
          entity_id,
          decision,
          reasoning || null,
          new Date().toISOString()
        ).run();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              decision_id: decisionId,
              message: 'Decision logged successfully.',
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_list_tasks
  server.tool(
    'nexus_list_tasks',
    'List tasks, optionally filtered by status or source',
    {
      status: z.enum(['inbox', 'next', 'scheduled', 'waiting', 'someday', 'completed', 'cancelled']).optional().describe('Filter by task status'),
      source_type: z.string().optional().describe('Filter by source (e.g., "idea_execution" for auto-generated tasks)'),
      limit: z.number().optional().default(50).describe('Maximum number of tasks to return'),
    },
    async ({ status, source_type, limit }): Promise<CallToolResult> => {
      try {
        let query = `
          SELECT id, title, description, status, source_type, source_reference, created_at, due_date
          FROM tasks
          WHERE tenant_id = ? AND deleted_at IS NULL
        `;

        const bindings: unknown[] = [tenantId];

        if (status) {
          query += ' AND status = ?';
          bindings.push(status);
        }

        if (source_type) {
          query += ' AND source_type = ?';
          bindings.push(source_type);
        }

        query += ' ORDER BY created_at DESC LIMIT ?';
        bindings.push(limit || 50);

        const tasks = await env.DB.prepare(query).bind(...bindings).all();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              count: tasks.results.length,
              tasks: tasks.results.map((t: Record<string, unknown>) => ({
                id: t.id,
                title: t.title,
                status: t.status,
                source_type: t.source_type,
                source_reference: t.source_reference,
                due_date: t.due_date,
                created_at: t.created_at,
              })),
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_delete_idea
  server.tool(
    'nexus_delete_idea',
    'Permanently delete an idea from Nexus. Requires passphrase for write operations. Will fail if idea has an active execution.',
    {
      idea_id: z.string().describe('The UUID of the idea to delete'),
      passphrase: z.string().describe('Write passphrase for destructive operations'),
    },
    async ({ idea_id, passphrase }): Promise<CallToolResult> => {
      try {
        // Verify passphrase
        if (passphrase !== env.WRITE_PASSPHRASE) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Invalid passphrase' }) }],
            isError: true
          };
        }

        // Check idea exists
        const idea = await env.DB.prepare(`
          SELECT id, title FROM ideas
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
        `).bind(idea_id, tenantId).first<{ id: string; title: string }>();

        if (!idea) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Idea not found' }) }],
            isError: true
          };
        }

        // Decrypt title for response
        const encryptionKey = await getEncryptionKey(env.KV, tenantId);
        const decryptedTitle = idea.title ? await safeDecrypt(idea.title, encryptionKey) : '';

        // Check for active executions
        const activeExecution = await env.DB.prepare(`
          SELECT id, status FROM idea_executions
          WHERE idea_id = ? AND tenant_id = ?
            AND status IN ('pending', 'planning', 'planned', 'executing', 'in_progress', 'blocked')
          LIMIT 1
        `).bind(idea_id, tenantId).first();

        if (activeExecution) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: `Idea has an active execution (status: ${activeExecution.status}). Cancel the execution first using nexus_cancel_execution.`
            }) }],
            isError: true
          };
        }

        const now = new Date().toISOString();

        // Soft delete the idea
        await env.DB.prepare(`
          UPDATE ideas SET deleted_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).bind(now, now, idea_id, tenantId).run();

        // Also soft delete any associated executions and tasks
        await env.DB.prepare(`
          UPDATE idea_executions SET deleted_at = ?, updated_at = ?
          WHERE idea_id = ? AND tenant_id = ?
        `).bind(now, now, idea_id, tenantId).run();

        await env.DB.prepare(`
          UPDATE idea_tasks SET deleted_at = ?, updated_at = ?
          WHERE idea_id = ? AND tenant_id = ?
        `).bind(now, now, idea_id, tenantId).run();

        // Log the decision
        await env.DB.prepare(`
          INSERT INTO decisions (id, tenant_id, user_id, entity_type, entity_id, decision, reasoning, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          crypto.randomUUID(),
          tenantId,
          userId,
          'idea',
          idea_id,
          'deleted',
          'Deleted via MCP tool',
          now
        ).run();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              deleted_id: idea_id,
              title: decryptedTitle,
              message: `Idea "${decryptedTitle}" has been deleted.`,
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_complete_idea
  server.tool(
    'nexus_complete_idea',
    'Mark an idea as completed without going through the full execution flow. Use when work was done outside the system.',
    {
      idea_id: z.string().describe('The UUID of the idea to mark as completed'),
      passphrase: z.string().describe('Write passphrase for write operations'),
      resolution: z.string().optional().describe('How the idea was completed or resolved'),
    },
    async ({ idea_id, passphrase, resolution }): Promise<CallToolResult> => {
      try {
        // Verify passphrase
        if (passphrase !== env.WRITE_PASSPHRASE) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Invalid passphrase' }) }],
            isError: true
          };
        }

        // Check idea exists
        const idea = await env.DB.prepare(`
          SELECT id, title FROM ideas
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
        `).bind(idea_id, tenantId).first<{ id: string; title: string }>();

        if (!idea) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Idea not found' }) }],
            isError: true
          };
        }

        // Decrypt title for response
        const encryptionKey = await getEncryptionKey(env.KV, tenantId);
        const decryptedTitle = idea.title ? await safeDecrypt(idea.title, encryptionKey) : '';

        const now = new Date().toISOString();

        // Archive the idea (execution_status is derived from idea_executions, not stored on ideas table)
        await env.DB.prepare(`
          UPDATE ideas
          SET archived_at = ?, archive_reason = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).bind(now, resolution || 'Completed via MCP', now, idea_id, tenantId).run();

        // If there's an existing execution, mark it completed too
        await env.DB.prepare(`
          UPDATE idea_executions
          SET status = 'completed', completed_at = ?, updated_at = ?
          WHERE idea_id = ? AND tenant_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
        `).bind(now, now, idea_id, tenantId).run();

        // Log the decision
        await env.DB.prepare(`
          INSERT INTO decisions (id, tenant_id, user_id, entity_type, entity_id, decision, reasoning, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          crypto.randomUUID(),
          tenantId,
          userId,
          'idea',
          idea_id,
          'completed',
          resolution || 'Marked complete via MCP tool',
          now
        ).run();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              idea_id,
              title: decryptedTitle,
              resolution: resolution || null,
              message: `Idea "${decryptedTitle}" has been marked as completed.`,
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_capture
  server.tool(
    'nexus_capture',
    'Capture raw input for AI classification. The input will be analyzed and potentially auto-promoted to a task, idea, or other entity.',
    {
      content: z.string().describe('The raw content to capture (voice transcription, note, etc.)'),
      source_type: z.enum(['voice', 'email', 'webhook', 'manual', 'sms', 'claude']).optional().describe('Source of the capture'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      // Validate passphrase for write operation
      const authError = validatePassphrase('nexus_capture', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      const { content, source_type } = args;
      try {
        // Forward to InboxManager DO
        const doId = env.INBOX_MANAGER.idFromName(tenantId);
        const stub = env.INBOX_MANAGER.get(doId);

        const response = await stub.fetch(new Request('http://do/capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenant_id: tenantId,
            user_id: userId,
            input: {
              raw_content: content,
              source_type: source_type || 'claude',
              captured_at: new Date().toISOString(),
            },
          }),
        }));

        const result = await response.json() as { success: boolean; data?: { id: string } };

        if (result.success) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                inbox_item_id: result.data?.id,
                message: 'Content captured and queued for AI classification. It may be auto-promoted to a task or idea.',
              }, null, 2)
            }]
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: true
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_update_idea
  server.tool(
    'nexus_update_idea',
    'Update an existing idea with new information',
    {
      idea_id: z.string().describe('The UUID of the idea to update'),
      title: z.string().optional().describe('New title for the idea'),
      description: z.string().optional().describe('New description for the idea'),
      category: z.enum(['feature', 'improvement', 'bug', 'documentation', 'research', 'infrastructure', 'random']).optional().describe('New category'),
      domain: z.enum(['work', 'personal', 'side_project', 'family', 'health']).optional().describe('New domain'),
      excitement_level: z.number().min(1).max(5).optional().describe('Updated excitement level (1-5)'),
      feasibility: z.number().min(1).max(5).optional().describe('Updated feasibility score (1-5)'),
      potential_impact: z.number().min(1).max(5).optional().describe('Updated impact score (1-5)'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      const authError = validatePassphrase('nexus_update_idea', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      const { idea_id, title, description, category, domain, excitement_level, feasibility, potential_impact } = args;

      try {
        // Check idea exists
        const existing = await env.DB.prepare(`
          SELECT id FROM ideas WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
        `).bind(idea_id, tenantId).first();

        if (!existing) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Idea not found' }) }],
            isError: true
          };
        }

        const encryptionKey = await getEncryptionKey(env.KV, tenantId);
        const now = new Date().toISOString();

        // Build dynamic update query
        const updates: string[] = ['updated_at = ?'];
        const bindings: unknown[] = [now];

        if (title !== undefined) {
          updates.push('title = ?');
          bindings.push(await encryptField(title, encryptionKey));
        }
        if (description !== undefined) {
          updates.push('description = ?');
          bindings.push(await encryptField(description, encryptionKey));
        }
        if (category !== undefined) {
          updates.push('category = ?');
          bindings.push(category);
        }
        if (domain !== undefined) {
          updates.push('domain = ?');
          bindings.push(domain);
        }
        if (excitement_level !== undefined) {
          updates.push('excitement_level = ?');
          bindings.push(excitement_level);
        }
        if (feasibility !== undefined) {
          updates.push('feasibility = ?');
          bindings.push(feasibility);
        }
        if (potential_impact !== undefined) {
          updates.push('potential_impact = ?');
          bindings.push(potential_impact);
        }

        bindings.push(idea_id, tenantId);

        await env.DB.prepare(`
          UPDATE ideas SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?
        `).bind(...bindings).run();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              idea_id,
              message: 'Idea updated successfully',
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_archive_idea
  server.tool(
    'nexus_archive_idea',
    'Archive an idea (soft delete). Use this to clean up ideas that are no longer relevant.',
    {
      idea_id: z.string().describe('The UUID of the idea to archive'),
      reason: z.string().optional().describe('Reason for archiving (e.g., "duplicate", "no longer relevant", "completed elsewhere")'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      const authError = validatePassphrase('nexus_archive_idea', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      const { idea_id, reason } = args;

      try {
        const now = new Date().toISOString();

        const result = await env.DB.prepare(`
          UPDATE ideas SET archived_at = ?, archive_reason = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND archived_at IS NULL
        `).bind(now, reason || null, now, idea_id, tenantId).run();

        if (result.meta.changes === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Idea not found or already archived' }) }],
            isError: true
          };
        }

        // Log the decision
        await env.DB.prepare(`
          INSERT INTO decisions (id, tenant_id, user_id, entity_type, entity_id, decision, reasoning, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          crypto.randomUUID(),
          tenantId,
          userId,
          'idea',
          idea_id,
          'archived',
          reason || 'Archived via MCP',
          now
        ).run();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              idea_id,
              message: 'Idea archived successfully',
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_update_task
  server.tool(
    'nexus_update_task',
    'Update an existing task with new information',
    {
      task_id: z.string().describe('The UUID of the task to update'),
      title: z.string().optional().describe('New title for the task'),
      description: z.string().optional().describe('New description'),
      status: z.enum(['inbox', 'next', 'scheduled', 'waiting', 'someday', 'completed', 'cancelled']).optional().describe('New status'),
      urgency: z.number().min(1).max(5).optional().describe('Urgency level (1-5)'),
      importance: z.number().min(1).max(5).optional().describe('Importance level (1-5)'),
      due_date: z.string().optional().describe('Due date in ISO format (YYYY-MM-DD)'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      const authError = validatePassphrase('nexus_update_task', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      const { task_id, title, description, status, urgency, importance, due_date } = args;

      try {
        const existing = await env.DB.prepare(`
          SELECT id FROM tasks WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
        `).bind(task_id, tenantId).first();

        if (!existing) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Task not found' }) }],
            isError: true
          };
        }

        const encryptionKey = await getEncryptionKey(env.KV, tenantId);
        const now = new Date().toISOString();

        const updates: string[] = ['updated_at = ?'];
        const bindings: unknown[] = [now];

        if (title !== undefined) {
          updates.push('title = ?');
          bindings.push(await encryptField(title, encryptionKey));
        }
        if (description !== undefined) {
          updates.push('description = ?');
          bindings.push(await encryptField(description, encryptionKey));
        }
        if (status !== undefined) {
          updates.push('status = ?');
          bindings.push(status);
          if (status === 'completed') {
            updates.push('completed_at = ?');
            bindings.push(now);
          }
        }
        if (urgency !== undefined) {
          updates.push('urgency = ?');
          bindings.push(urgency);
        }
        if (importance !== undefined) {
          updates.push('importance = ?');
          bindings.push(importance);
        }
        if (due_date !== undefined) {
          updates.push('due_date = ?');
          bindings.push(due_date);
        }

        bindings.push(task_id, tenantId);

        await env.DB.prepare(`
          UPDATE tasks SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?
        `).bind(...bindings).run();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              task_id,
              message: 'Task updated successfully',
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_complete_task
  server.tool(
    'nexus_complete_task',
    'Mark a task as completed',
    {
      task_id: z.string().describe('The UUID of the task to complete'),
      notes: z.string().optional().describe('Optional completion notes'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      const authError = validatePassphrase('nexus_complete_task', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      const { task_id, notes } = args;

      try {
        const now = new Date().toISOString();

        const result = await env.DB.prepare(`
          UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND status != 'completed'
        `).bind(now, now, task_id, tenantId).run();

        if (result.meta.changes === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Task not found or already completed' }) }],
            isError: true
          };
        }

        // Log the decision
        await env.DB.prepare(`
          INSERT INTO decisions (id, tenant_id, user_id, entity_type, entity_id, decision, reasoning, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          crypto.randomUUID(),
          tenantId,
          userId,
          'task',
          task_id,
          'completed',
          notes || 'Completed via MCP',
          now
        ).run();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              task_id,
              message: 'Task marked as completed',
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_delete_task
  server.tool(
    'nexus_delete_task',
    'Delete a task (soft delete)',
    {
      task_id: z.string().describe('The UUID of the task to delete'),
      reason: z.string().optional().describe('Reason for deletion'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      const authError = validatePassphrase('nexus_delete_task', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      const { task_id, reason } = args;

      try {
        const now = new Date().toISOString();

        const result = await env.DB.prepare(`
          UPDATE tasks SET deleted_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
        `).bind(now, now, task_id, tenantId).run();

        if (result.meta.changes === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Task not found or already deleted' }) }],
            isError: true
          };
        }

        // Log the decision
        await env.DB.prepare(`
          INSERT INTO decisions (id, tenant_id, user_id, entity_type, entity_id, decision, reasoning, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          crypto.randomUUID(),
          tenantId,
          userId,
          'task',
          task_id,
          'deleted',
          reason || 'Deleted via MCP',
          now
        ).run();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              task_id,
              message: 'Task deleted successfully',
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // ========================================
  // ========================================
  // NOTES TOOLS
  // ========================================

  // Tool: nexus_create_note - Create a new note
  server.tool(
    'nexus_create_note',
    'Create a new note in Nexus. Notes are persistent storage for any content - meeting notes, research, ideas, logs, etc.',
    {
      title: z.string().describe('Title of the note'),
      content: z.string().optional().describe('Content/body of the note'),
      category: z.enum(['general', 'meeting', 'research', 'reference', 'idea', 'log']).optional().describe('Category of the note'),
      tags: z.string().optional().describe('JSON array of tags (e.g., \'["project-x", "important"]\')'),
      source_type: z.string().optional().describe('Where this note originated (claude_conversation, idea_execution, task, manual, capture)'),
      source_reference: z.string().optional().describe('ID or URL of the source'),
      source_context: z.string().optional().describe('Additional context about the source'),
      pinned: z.boolean().optional().describe('Pin the note to top of list'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      const authError = validatePassphrase('nexus_create_note', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      const { title, content, category, tags, source_type, source_reference, source_context, pinned } = args;

      try {
        const encryptionKey = await getEncryptionKey(env.KV, tenantId);
        const id = crypto.randomUUID();
        const now = new Date().toISOString();

        // Encrypt title and content
        const encryptedTitle = await encryptField(title, encryptionKey);
        const encryptedContent = content ? await encryptField(content, encryptionKey) : null;

        await env.DB.prepare(`
          INSERT INTO notes (id, tenant_id, user_id, title, content, category, tags, source_type, source_reference, source_context, pinned, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          id,
          tenantId,
          userId,
          encryptedTitle,
          encryptedContent,
          category || 'general',
          tags || null,
          source_type || null,
          source_reference || null,
          source_context || null,
          pinned ? 1 : 0,
          now,
          now
        ).run();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              note_id: id,
              title: title,
              category: category || 'general',
              message: 'Note created successfully',
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_list_notes - List notes with optional filters
  server.tool(
    'nexus_list_notes',
    'List notes from Nexus with optional filtering by category, archived status, pinned, or source',
    {
      category: z.enum(['general', 'meeting', 'research', 'reference', 'idea', 'log']).optional().describe('Filter by category'),
      archived: z.boolean().optional().describe('Include archived notes (default: false)'),
      pinned: z.boolean().optional().describe('Filter to only pinned notes'),
      source_type: z.string().optional().describe('Filter by source type'),
      limit: z.number().optional().default(50).describe('Maximum notes to return'),
    },
    async ({ category, archived, pinned, source_type, limit }): Promise<CallToolResult> => {
      try {
        let query = `
          SELECT id, title, content, category, tags, source_type, source_reference, pinned, archived_at, created_at, updated_at
          FROM notes
          WHERE tenant_id = ? AND user_id = ? AND deleted_at IS NULL
        `;

        const bindings: unknown[] = [tenantId, userId];

        if (!archived) {
          query += ' AND archived_at IS NULL';
        }

        if (category) {
          query += ' AND category = ?';
          bindings.push(category);
        }

        if (pinned) {
          query += ' AND pinned = 1';
        }

        if (source_type) {
          query += ' AND source_type = ?';
          bindings.push(source_type);
        }

        query += ' ORDER BY pinned DESC, created_at DESC LIMIT ?';
        bindings.push(limit || 50);

        const notes = await env.DB.prepare(query).bind(...bindings).all();

        // Decrypt titles and content
        const encryptionKey = await getEncryptionKey(env.KV, tenantId);
        const decryptedNotes = await Promise.all(
          notes.results.map(async (note: Record<string, unknown>) => ({
            id: note.id,
            title: note.title ? await safeDecrypt(note.title, encryptionKey) : '',
            content_preview: note.content
              ? (await safeDecrypt(note.content, encryptionKey)).substring(0, 200) + '...'
              : null,
            category: note.category,
            tags: note.tags,
            source_type: note.source_type,
            pinned: note.pinned === 1,
            archived: !!note.archived_at,
            created_at: note.created_at,
          }))
        );

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              count: decryptedNotes.length,
              notes: decryptedNotes,
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_get_note - Get a single note with full content
  server.tool(
    'nexus_get_note',
    'Get a single note by ID with full content',
    {
      note_id: z.string().describe('The UUID of the note to retrieve'),
    },
    async ({ note_id }): Promise<CallToolResult> => {
      try {
        const note = await env.DB.prepare(`
          SELECT id, title, content, category, tags, source_type, source_reference, source_context, pinned, archived_at, created_at, updated_at
          FROM notes
          WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
        `).bind(note_id, tenantId, userId).first();

        if (!note) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Note not found' }) }],
            isError: true
          };
        }

        const encryptionKey = await getEncryptionKey(env.KV, tenantId);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              note: {
                id: note.id,
                title: note.title ? await safeDecrypt(note.title, encryptionKey) : '',
                content: note.content ? await safeDecrypt(note.content, encryptionKey) : null,
                category: note.category,
                tags: note.tags,
                source_type: note.source_type,
                source_reference: note.source_reference,
                source_context: note.source_context,
                pinned: note.pinned === 1,
                archived: !!note.archived_at,
                created_at: note.created_at,
                updated_at: note.updated_at,
              },
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_update_note - Update an existing note
  server.tool(
    'nexus_update_note',
    'Update an existing note',
    {
      note_id: z.string().describe('The UUID of the note to update'),
      title: z.string().optional().describe('New title'),
      content: z.string().optional().describe('New content'),
      category: z.enum(['general', 'meeting', 'research', 'reference', 'idea', 'log']).optional().describe('New category'),
      tags: z.string().optional().describe('New tags (JSON array)'),
      pinned: z.boolean().optional().describe('Pin/unpin the note'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      const authError = validatePassphrase('nexus_update_note', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      const { note_id, title, content, category, tags, pinned } = args;

      try {
        // Check note exists
        const existing = await env.DB.prepare(`
          SELECT id FROM notes WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
        `).bind(note_id, tenantId, userId).first();

        if (!existing) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Note not found' }) }],
            isError: true
          };
        }

        const encryptionKey = await getEncryptionKey(env.KV, tenantId);
        const now = new Date().toISOString();
        const updates: string[] = ['updated_at = ?'];
        const bindings: unknown[] = [now];

        if (title !== undefined) {
          updates.push('title = ?');
          bindings.push(await encryptField(title, encryptionKey));
        }
        if (content !== undefined) {
          updates.push('content = ?');
          bindings.push(content ? await encryptField(content, encryptionKey) : null);
        }
        if (category !== undefined) {
          updates.push('category = ?');
          bindings.push(category);
        }
        if (tags !== undefined) {
          updates.push('tags = ?');
          bindings.push(tags);
        }
        if (pinned !== undefined) {
          updates.push('pinned = ?');
          bindings.push(pinned ? 1 : 0);
        }

        bindings.push(note_id, tenantId);

        await env.DB.prepare(`
          UPDATE notes SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?
        `).bind(...bindings).run();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              note_id: note_id,
              message: 'Note updated successfully',
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_delete_note - Delete a note
  server.tool(
    'nexus_delete_note',
    'Delete a note (soft delete)',
    {
      note_id: z.string().describe('The UUID of the note to delete'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      const authError = validatePassphrase('nexus_delete_note', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      const { note_id } = args;

      try {
        const existing = await env.DB.prepare(`
          SELECT id, title FROM notes WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
        `).bind(note_id, tenantId, userId).first();

        if (!existing) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Note not found' }) }],
            isError: true
          };
        }

        const now = new Date().toISOString();
        await env.DB.prepare(`
          UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?
        `).bind(now, now, note_id, tenantId).run();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              note_id: note_id,
              message: 'Note deleted successfully',
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_archive_note - Archive or unarchive a note
  server.tool(
    'nexus_archive_note',
    'Archive or unarchive a note',
    {
      note_id: z.string().describe('The UUID of the note'),
      archive: z.boolean().describe('true to archive, false to unarchive'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      const authError = validatePassphrase('nexus_archive_note', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      const { note_id, archive } = args;

      try {
        const existing = await env.DB.prepare(`
          SELECT id FROM notes WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
        `).bind(note_id, tenantId, userId).first();

        if (!existing) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Note not found' }) }],
            isError: true
          };
        }

        const now = new Date().toISOString();
        const archivedAt = archive ? now : null;

        await env.DB.prepare(`
          UPDATE notes SET archived_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?
        `).bind(archivedAt, now, note_id, tenantId).run();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              note_id: note_id,
              archived: archive,
              message: archive ? 'Note archived' : 'Note unarchived',
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_search_notes - Search notes by content
  server.tool(
    'nexus_search_notes',
    'Search notes by title or content',
    {
      query: z.string().describe('Search query'),
      limit: z.number().optional().default(20).describe('Maximum results'),
    },
    async ({ query, limit }): Promise<CallToolResult> => {
      try {
        // Get all notes and search in decrypted content
        const notes = await env.DB.prepare(`
          SELECT id, title, content, category, tags, source_type, pinned, archived_at, created_at
          FROM notes
          WHERE tenant_id = ? AND user_id = ? AND deleted_at IS NULL AND archived_at IS NULL
          ORDER BY created_at DESC
        `).bind(tenantId, userId).all();

        const encryptionKey = await getEncryptionKey(env.KV, tenantId);
        const searchLower = query.toLowerCase();

        const matchingNotes = [];
        for (const note of notes.results) {
          const decryptedTitle = note.title ? await safeDecrypt(note.title, encryptionKey) : '';
          const decryptedContent = note.content ? await safeDecrypt(note.content, encryptionKey) : '';

          if (
            decryptedTitle.toLowerCase().includes(searchLower) ||
            decryptedContent.toLowerCase().includes(searchLower)
          ) {
            matchingNotes.push({
              id: note.id,
              title: decryptedTitle,
              content_preview: decryptedContent.substring(0, 200) + (decryptedContent.length > 200 ? '...' : ''),
              category: note.category,
              tags: note.tags,
              pinned: note.pinned === 1,
              created_at: note.created_at,
            });

            if (matchingNotes.length >= (limit || 20)) break;
          }
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              query: query,
              count: matchingNotes.length,
              notes: matchingNotes,
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // ========================================
  // EXECUTION QUEUE TOOLS
  // ========================================

  // Tool: nexus_check_queue
  server.tool(
    'nexus_check_queue',
    'Check the execution queue for tasks waiting to be processed by a specific executor type',
    {
      executor_type: z.enum(['claude-code', 'claude-ai', 'de-agent', 'human']).describe('The type of executor to check queue for'),
      status: z.enum(['queued', 'claimed', 'dispatched', 'all']).optional().describe('Filter by queue status (default: queued)'),
      limit: z.number().optional().describe('Maximum number of results to return (default: 10)'),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const executorType = args.executor_type;
        const status = args.status || 'queued';
        const limit = args.limit || 10;

        const encryptionKey = await getEncryptionKey(env.KV, tenantId);

        // Build query based on status
        let query: string;
        let bindings: unknown[];

        if (status === 'all') {
          query = `
            SELECT eq.*, t.title as task_title_encrypted, t.description as task_description_encrypted
            FROM execution_queue eq
            JOIN tasks t ON eq.task_id = t.id
            WHERE eq.tenant_id = ? AND eq.executor_type = ?
            ORDER BY eq.priority DESC, eq.queued_at ASC
            LIMIT ?
          `;
          bindings = [tenantId, executorType, limit];
        } else {
          query = `
            SELECT eq.*, t.title as task_title_encrypted, t.description as task_description_encrypted
            FROM execution_queue eq
            JOIN tasks t ON eq.task_id = t.id
            WHERE eq.tenant_id = ? AND eq.executor_type = ? AND eq.status = ?
            ORDER BY eq.priority DESC, eq.queued_at ASC
            LIMIT ?
          `;
          bindings = [tenantId, executorType, status, limit];
        }

        const result = await env.DB.prepare(query).bind(...bindings).all<{
          id: string;
          task_id: string;
          executor_type: string;
          status: string;
          priority: number;
          queued_at: string;
          claimed_at: string | null;
          claimed_by: string | null;
          context: string | null;
          task_title_encrypted: string;
          task_description_encrypted: string | null;
        }>();

        // Decrypt task titles
        const queueItems = await Promise.all((result.results || []).map(async (item) => ({
          id: item.id,
          task_id: item.task_id,
          executor_type: item.executor_type,
          status: item.status,
          priority: item.priority,
          queued_at: item.queued_at,
          claimed_at: item.claimed_at,
          claimed_by: item.claimed_by,
          task_title: await safeDecrypt(item.task_title_encrypted, encryptionKey),
          task_description: item.task_description_encrypted
            ? await safeDecrypt(item.task_description_encrypted, encryptionKey)
            : null,
          context: item.context ? JSON.parse(item.context) : null,
        })));

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              executor_type: executorType,
              status_filter: status,
              count: queueItems.length,
              queue: queueItems,
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_claim_queue_task - Claim from execution queue (different from nexus_claim_task which claims directly by task_id)
  server.tool(
    'nexus_claim_queue_task',
    'Claim a task from the execution queue to begin working on it. Prevents other executors from picking it up.',
    {
      queue_id: z.string().uuid().describe('The execution queue entry ID to claim'),
      claimed_by: z.string().optional().describe('Identifier for this executor instance (e.g., session ID)'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      // Validate passphrase for write operation
      const authError = validatePassphrase('nexus_claim_queue_task', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      try {
        const queueId = args.queue_id;
        const claimedBy = args.claimed_by || `mcp-session-${Date.now()}`;
        const now = new Date().toISOString();

        // Check if already claimed
        const existing = await env.DB.prepare(`
          SELECT id, status, task_id FROM execution_queue
          WHERE id = ? AND tenant_id = ?
        `).bind(queueId, tenantId).first<{ id: string; status: string; task_id: string }>();

        if (!existing) {
          return {
            content: [{ type: 'text', text: 'Error: Queue entry not found' }],
            isError: true
          };
        }

        if (existing.status !== 'queued') {
          return {
            content: [{ type: 'text', text: `Error: Queue entry is already ${existing.status}, cannot claim` }],
            isError: true
          };
        }

        // Claim the entry
        await env.DB.prepare(`
          UPDATE execution_queue
          SET status = 'claimed', claimed_at = ?, claimed_by = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).bind(now, claimedBy, now, queueId, tenantId).run();

        // Log the claim
        const logId = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO dispatch_log (id, tenant_id, queue_entry_id, task_id, executor_type, action, details, created_at)
          SELECT ?, ?, id, task_id, executor_type, 'claimed', ?, ?
          FROM execution_queue WHERE id = ?
        `).bind(logId, tenantId, JSON.stringify({ claimed_by: claimedBy }), now, queueId).run();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              queue_id: queueId,
              task_id: existing.task_id,
              claimed_by: claimedBy,
              claimed_at: now,
              message: 'Task claimed successfully. Use nexus_trigger_task with the task_id to get execution context.',
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_complete_queue_task
  server.tool(
    'nexus_complete_queue_task',
    'Mark a claimed queue task as completed with results. Returns next available tasks for the same executor type.',
    {
      queue_id: z.string().uuid().describe('The execution queue entry ID to complete'),
      result: z.string().optional().describe('JSON result from execution'),
      error: z.string().optional().describe('Error message if the task failed'),
      auto_dispatch: z.boolean().optional().describe('Auto-dispatch newly ready tasks after completion (default: true)'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      // Validate passphrase for write operation
      const authError = validatePassphrase('nexus_complete_queue_task', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      try {
        const queueId = args.queue_id;
        const now = new Date().toISOString();
        const hasError = !!args.error;
        const newStatus = hasError ? 'failed' : 'completed';
        const autoDispatch = args.auto_dispatch !== false; // default true

        // Check current status and get executor type
        const existing = await env.DB.prepare(`
          SELECT id, status, task_id, executor_type, retry_count, max_retries FROM execution_queue
          WHERE id = ? AND tenant_id = ?
        `).bind(queueId, tenantId).first<{
          id: string;
          status: string;
          task_id: string;
          executor_type: string;
          retry_count: number;
          max_retries: number;
        }>();

        if (!existing) {
          return {
            content: [{ type: 'text', text: 'Error: Queue entry not found' }],
            isError: true
          };
        }

        if (existing.status !== 'claimed' && existing.status !== 'dispatched') {
          return {
            content: [{ type: 'text', text: `Error: Queue entry has status '${existing.status}', expected 'claimed' or 'dispatched'` }],
            isError: true
          };
        }

        const executorType = existing.executor_type;

        // Update the queue entry
        await env.DB.prepare(`
          UPDATE execution_queue
          SET status = ?, completed_at = ?, result = ?, error = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).bind(newStatus, now, args.result || null, args.error || null, now, queueId, tenantId).run();

        // Also update the task status if completed successfully
        if (!hasError) {
          await env.DB.prepare(`
            UPDATE tasks
            SET status = 'completed', completed_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ?
          `).bind(now, now, existing.task_id, tenantId).run();
        }

        // Log the completion
        const logId = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO dispatch_log (id, tenant_id, queue_entry_id, task_id, executor_type, action, details, created_at)
          SELECT ?, ?, id, task_id, executor_type, ?, ?, ?
          FROM execution_queue WHERE id = ?
        `).bind(
          logId,
          tenantId,
          newStatus,
          JSON.stringify({ result: args.result, error: args.error }),
          now,
          queueId
        ).run();

        // ========================================
        // CHECK FOR MORE WORK
        // ========================================

        // 1. Check for already-queued tasks for this executor
        const queuedTasks = await env.DB.prepare(`
          SELECT eq.id, eq.task_id, eq.priority, eq.context
          FROM execution_queue eq
          WHERE eq.tenant_id = ? AND eq.executor_type = ? AND eq.status = 'queued'
          ORDER BY eq.priority DESC, eq.queued_at ASC
          LIMIT 5
        `).bind(tenantId, executorType).all<{
          id: string;
          task_id: string;
          priority: number;
          context: string | null;
        }>();

        // 2. If auto_dispatch is enabled, check for newly ready tasks (status="next")
        //    that aren't yet queued and dispatch them
        let newlyDispatched: Array<{ task_id: string; queue_id: string; task_title: string }> = [];

        if (autoDispatch) {
          const encryptionKey = await getEncryptionKey(env.KV, tenantId);

          // Find tasks with status="next" that aren't in the queue yet
          const readyTasks = await env.DB.prepare(`
            SELECT t.id, t.user_id, t.title, t.description, t.urgency, t.importance,
                   t.project_id, t.domain, t.due_date, t.energy_required, t.source_type, t.source_reference
            FROM tasks t
            WHERE t.tenant_id = ? AND t.status = 'next' AND t.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM execution_queue eq
                WHERE eq.task_id = t.id AND eq.status IN ('queued', 'claimed', 'dispatched')
              )
            ORDER BY t.urgency DESC, t.importance DESC
            LIMIT 10
          `).bind(tenantId).all<{
            id: string;
            user_id: string;
            title: string;
            description: string | null;
            urgency: number;
            importance: number;
            project_id: string | null;
            domain: string;
            due_date: string | null;
            energy_required: string;
            source_type: string | null;
            source_reference: string | null;
          }>();

          // Auto-detect executor patterns
          const patterns: Array<{ pattern: RegExp; executor: string }> = [
            // Literal executor names (highest priority)
            { pattern: /^\[claude-code\]/i, executor: 'claude-code' },
            { pattern: /^\[claude-ai\]/i, executor: 'claude-ai' },
            { pattern: /^\[de-agent\]/i, executor: 'de-agent' },
            // Shorthand tags
            { pattern: /^\[CC\]/i, executor: 'claude-code' },
            { pattern: /^\[AI\]/i, executor: 'claude-ai' },
            { pattern: /^\[DE\]/i, executor: 'de-agent' },
            { pattern: /^\[HUMAN\]/i, executor: 'human' },
            { pattern: /^\[BLOCKED\]/i, executor: 'human' },
            // Semantic tags
            { pattern: /^\[implement\]/i, executor: 'claude-code' },
            { pattern: /^\[deploy\]/i, executor: 'claude-code' },
            { pattern: /^\[fix\]/i, executor: 'claude-code' },
            { pattern: /^\[refactor\]/i, executor: 'claude-code' },
            { pattern: /^\[test\]/i, executor: 'claude-code' },
            { pattern: /^\[debug\]/i, executor: 'claude-code' },
            { pattern: /^\[code\]/i, executor: 'claude-code' },
            { pattern: /^\[research\]/i, executor: 'claude-ai' },
            { pattern: /^\[design\]/i, executor: 'claude-ai' },
            { pattern: /^\[document\]/i, executor: 'claude-ai' },
            { pattern: /^\[analyze\]/i, executor: 'claude-ai' },
            { pattern: /^\[plan\]/i, executor: 'claude-ai' },
            { pattern: /^\[write\]/i, executor: 'claude-ai' },
            { pattern: /^\[human\]/i, executor: 'human' },
            { pattern: /^\[review\]/i, executor: 'human' },
            { pattern: /^\[approve\]/i, executor: 'human' },
            { pattern: /^\[decide\]/i, executor: 'human' },
            { pattern: /^\[call\]/i, executor: 'human' },
            { pattern: /^\[meeting\]/i, executor: 'human' },
          ];

          for (const task of (readyTasks.results || [])) {
            const decryptedTitle = await safeDecrypt(task.title, encryptionKey);

            // Determine executor type
            let taskExecutorType = 'human';
            for (const { pattern, executor } of patterns) {
              if (pattern.test(decryptedTitle)) {
                taskExecutorType = executor;
                break;
              }
            }

            // Only auto-dispatch tasks for the SAME executor type
            if (taskExecutorType !== executorType) continue;

            // Calculate priority
            const priority = (task.urgency || 3) * (task.importance || 3);

            // Build context
            const context = JSON.stringify({
              task_title: decryptedTitle,
              task_description: task.description ? await safeDecrypt(task.description, encryptionKey) : null,
              project_id: task.project_id,
              domain: task.domain,
              due_date: task.due_date,
              energy_required: task.energy_required,
              source_type: task.source_type,
              source_reference: task.source_reference,
            });

            // Add to queue
            const newQueueId = crypto.randomUUID();
            await env.DB.prepare(`
              INSERT INTO execution_queue (
                id, tenant_id, user_id, task_id, executor_type, status,
                priority, queued_at, context, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
            `).bind(newQueueId, tenantId, task.user_id, task.id, taskExecutorType, priority, now, context, now, now).run();

            // Log
            const newLogId = crypto.randomUUID();
            await env.DB.prepare(`
              INSERT INTO dispatch_log (id, tenant_id, queue_entry_id, task_id, executor_type, action, details, created_at)
              VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
            `).bind(newLogId, tenantId, newQueueId, task.id, taskExecutorType, JSON.stringify({ source: 'auto_dispatch_on_complete' }), now).run();

            newlyDispatched.push({
              task_id: task.id,
              queue_id: newQueueId,
              task_title: decryptedTitle,
            });
          }
        }

        // Build list of next available tasks (already queued + newly dispatched)
        const encryptionKey = await getEncryptionKey(env.KV, tenantId);
        const nextTasks = await Promise.all((queuedTasks.results || []).map(async (q) => {
          const ctx = q.context ? JSON.parse(q.context) : {};
          return {
            queue_id: q.id,
            task_id: q.task_id,
            task_title: ctx.task_title || '(encrypted)',
            priority: q.priority,
          };
        }));

        // Add newly dispatched to the front
        for (const nd of newlyDispatched) {
          nextTasks.unshift({
            queue_id: nd.queue_id,
            task_id: nd.task_id,
            task_title: nd.task_title,
            priority: 9, // assume high priority for newly ready
          });
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              completed: {
                queue_id: queueId,
                task_id: existing.task_id,
                status: newStatus,
                completed_at: now,
              },
              newly_dispatched: newlyDispatched.length,
              next_available: nextTasks.slice(0, 5),
              has_more_work: nextTasks.length > 0,
              message: nextTasks.length > 0
                ? `Task completed. ${nextTasks.length} task(s) available for ${executorType}. Use nexus_claim_queue_task to claim the next one.`
                : `Task completed. No more tasks queued for ${executorType}.`,
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_queue_stats
  server.tool(
    'nexus_queue_stats',
    'Get execution queue statistics - counts by status and executor type',
    {},
    async (): Promise<CallToolResult> => {
      try {
        // Total by status
        const byStatus = await env.DB.prepare(`
          SELECT status, COUNT(*) as count FROM execution_queue
          WHERE tenant_id = ?
          GROUP BY status
        `).bind(tenantId).all<{ status: string; count: number }>();

        // Total by executor
        const byExecutor = await env.DB.prepare(`
          SELECT executor_type, status, COUNT(*) as count FROM execution_queue
          WHERE tenant_id = ?
          GROUP BY executor_type, status
        `).bind(tenantId).all<{ executor_type: string; status: string; count: number }>();

        // Recent activity
        const recentActivity = await env.DB.prepare(`
          SELECT action, COUNT(*) as count
          FROM dispatch_log
          WHERE tenant_id = ? AND created_at > datetime('now', '-1 hour')
          GROUP BY action
        `).bind(tenantId).all<{ action: string; count: number }>();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              by_status: Object.fromEntries((byStatus.results || []).map(r => [r.status, r.count])),
              by_executor: (byExecutor.results || []).reduce((acc, r) => {
                if (!acc[r.executor_type]) acc[r.executor_type] = {};
                const executorStats = acc[r.executor_type];
                if (executorStats) executorStats[r.status] = r.count;
                return acc;
              }, {} as Record<string, Record<string, number>>),
              recent_activity_1h: Object.fromEntries((recentActivity.results || []).map(r => [r.action, r.count])),
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_list_quarantined
  server.tool(
    'nexus_list_quarantined',
    'List all quarantined tasks that need attention. Quarantined tasks are ones that failed execution and need investigation or manual intervention.',
    {
      limit: z.number().optional().describe('Maximum number of results to return (default: 50)'),
      include_context: z.boolean().optional().describe('Include full task context in response (default: false)'),
    },
    async ({ limit = 50, include_context = false }): Promise<CallToolResult> => {
      try {
        // Get encryption key for decrypting task titles
        const encryptionKey = await getEncryptionKey(env.KV, tenantId);

        // Query quarantined entries with task info
        const results = await env.DB.prepare(`
          SELECT
            eq.id as queue_id,
            eq.task_id,
            eq.executor_type,
            eq.status as queue_status,
            eq.error,
            eq.retry_count,
            eq.context,
            eq.queued_at,
            eq.updated_at as quarantined_at,
            t.title,
            t.description,
            t.status as task_status,
            t.urgency,
            t.importance,
            t.project_id,
            t.source_type,
            t.source_reference
          FROM execution_queue eq
          LEFT JOIN tasks t ON eq.task_id = t.id
          WHERE eq.tenant_id = ? AND eq.status = 'quarantine'
          ORDER BY eq.updated_at DESC
          LIMIT ?
        `).bind(tenantId, limit).all<{
          queue_id: string;
          task_id: string;
          executor_type: string;
          queue_status: string;
          error: string | null;
          retry_count: number;
          context: string | null;
          queued_at: string;
          quarantined_at: string;
          title: string | null;
          description: string | null;
          task_status: string | null;
          urgency: number | null;
          importance: number | null;
          project_id: string | null;
          source_type: string | null;
          source_reference: string | null;
        }>();

        // Decrypt titles and format results
        const quarantined = await Promise.all((results.results || []).map(async (row) => {
          let decryptedTitle = row.title;
          let decryptedDescription = row.description;

          // Decrypt if we have encrypted content
          if (row.title && encryptionKey) {
            try {
              const decrypted = await decryptFields(
                { title: row.title, description: row.description },
                ['title', 'description'],
                encryptionKey
              );
              decryptedTitle = decrypted.title;
              decryptedDescription = decrypted.description;
            } catch {
              // If decryption fails, use original (might be unencrypted)
            }
          }

          const item: Record<string, unknown> = {
            queue_id: row.queue_id,
            task_id: row.task_id,
            title: decryptedTitle || '[Task not found]',
            executor_type: row.executor_type,
            error: row.error,
            retry_count: row.retry_count,
            quarantined_at: row.quarantined_at,
            queued_at: row.queued_at,
            task_status: row.task_status,
            urgency: row.urgency,
            importance: row.importance,
          };

          // Include context and description if requested
          if (include_context) {
            item.description = decryptedDescription;
            item.context = row.context ? JSON.parse(row.context) : null;
            item.project_id = row.project_id;
            item.source_type = row.source_type;
            item.source_reference = row.source_reference;
          }

          return item;
        }));

        // Get total count
        const countResult = await env.DB.prepare(`
          SELECT COUNT(*) as count FROM execution_queue
          WHERE tenant_id = ? AND status = 'quarantine'
        `).bind(tenantId).first<{ count: number }>();

        const totalCount = countResult?.count || 0;

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              total_quarantined: totalCount,
              showing: quarantined.length,
              quarantined,
              message: totalCount > 0
                ? `${totalCount} task(s) in quarantine need attention. Use nexus_reset_quarantine to retry or nexus_complete_task to cancel.`
                : 'No quarantined tasks - execution queue is healthy.',
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_dispatch_task
  server.tool(
    'nexus_dispatch_task',
    'Immediately dispatch a single task to the execution queue. Use this when you want a task executed right away instead of waiting for the 15-minute cron.',
    {
      task_id: z.string().uuid().describe('Task ID to dispatch'),
      executor_type: z.enum(['claude-code', 'claude-ai', 'de-agent', 'human']).optional()
        .describe('Override auto-detected executor type (auto-detects from title tag if not provided)'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      // Validate passphrase for write operation
      const authError = validatePassphrase('nexus_dispatch_task', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      try {
        const taskId = args.task_id;
        const encryptionKey = await getEncryptionKey(env.KV, tenantId);
        const now = new Date().toISOString();

        // Get the task
        const task = await env.DB.prepare(`
          SELECT * FROM tasks WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
        `).bind(taskId, tenantId).first<{
          id: string;
          user_id: string;
          title: string;
          description: string | null;
          status: string;
          urgency: number;
          importance: number;
          project_id: string | null;
          domain: string;
          due_date: string | null;
          energy_required: string;
          source_type: string | null;
          source_reference: string | null;
        }>();

        if (!task) {
          return {
            content: [{ type: 'text', text: 'Error: Task not found' }],
            isError: true
          };
        }

        // Check if already in queue
        const existing = await env.DB.prepare(`
          SELECT id, status FROM execution_queue
          WHERE task_id = ? AND status IN ('queued', 'claimed', 'dispatched')
        `).bind(taskId).first<{ id: string; status: string }>();

        if (existing) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: `Task is already in queue with status '${existing.status}'`,
                queue_id: existing.id,
              }, null, 2)
            }],
            isError: true
          };
        }

        // Decrypt title to determine executor type
        const decryptedTitle = await safeDecrypt(task.title, encryptionKey);

        // Determine executor type (use override or auto-detect)
        let executorType = args.executor_type;
        if (!executorType) {
          // Auto-detect from title tag patterns
          const patterns: Array<{ pattern: RegExp; executor: 'claude-code' | 'claude-ai' | 'de-agent' | 'human' }> = [
            // Literal executor names (highest priority)
            { pattern: /^\[claude-code\]/i, executor: 'claude-code' },
            { pattern: /^\[claude-ai\]/i, executor: 'claude-ai' },
            { pattern: /^\[de-agent\]/i, executor: 'de-agent' },
            // Shorthand tags
            { pattern: /^\[CC\]/i, executor: 'claude-code' },
            { pattern: /^\[AI\]/i, executor: 'claude-ai' },
            { pattern: /^\[DE\]/i, executor: 'de-agent' },
            { pattern: /^\[HUMAN\]/i, executor: 'human' },
            { pattern: /^\[BLOCKED\]/i, executor: 'human' },
            // Semantic tags
            { pattern: /^\[implement\]/i, executor: 'claude-code' },
            { pattern: /^\[deploy\]/i, executor: 'claude-code' },
            { pattern: /^\[fix\]/i, executor: 'claude-code' },
            { pattern: /^\[refactor\]/i, executor: 'claude-code' },
            { pattern: /^\[test\]/i, executor: 'claude-code' },
            { pattern: /^\[debug\]/i, executor: 'claude-code' },
            { pattern: /^\[code\]/i, executor: 'claude-code' },
            { pattern: /^\[research\]/i, executor: 'claude-ai' },
            { pattern: /^\[design\]/i, executor: 'claude-ai' },
            { pattern: /^\[document\]/i, executor: 'claude-ai' },
            { pattern: /^\[analyze\]/i, executor: 'claude-ai' },
            { pattern: /^\[plan\]/i, executor: 'claude-ai' },
            { pattern: /^\[write\]/i, executor: 'claude-ai' },
            { pattern: /^\[human\]/i, executor: 'human' },
            { pattern: /^\[review\]/i, executor: 'human' },
            { pattern: /^\[approve\]/i, executor: 'human' },
            { pattern: /^\[decide\]/i, executor: 'human' },
            { pattern: /^\[call\]/i, executor: 'human' },
            { pattern: /^\[meeting\]/i, executor: 'human' },
          ];

          executorType = 'human'; // default
          for (const { pattern, executor } of patterns) {
            if (pattern.test(decryptedTitle)) {
              executorType = executor;
              break;
            }
          }
        }

        // Calculate priority from urgency/importance
        const priority = (task.urgency || 3) * (task.importance || 3);

        // Build context
        const context = JSON.stringify({
          task_title: decryptedTitle,
          task_description: task.description ? await safeDecrypt(task.description, encryptionKey) : null,
          project_id: task.project_id,
          domain: task.domain,
          due_date: task.due_date,
          energy_required: task.energy_required,
          source_type: task.source_type,
          source_reference: task.source_reference,
        });

        // Add to queue
        const queueId = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO execution_queue (
            id, tenant_id, user_id, task_id, executor_type, status,
            priority, queued_at, context, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
        `).bind(
          queueId,
          tenantId,
          task.user_id,
          taskId,
          executorType,
          priority,
          now,
          context,
          now,
          now
        ).run();

        // Log the dispatch
        const logId = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO dispatch_log (id, tenant_id, queue_entry_id, task_id, executor_type, action, details, created_at)
          VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
        `).bind(
          logId,
          tenantId,
          queueId,
          taskId,
          executorType,
          JSON.stringify({ source: 'manual_dispatch', priority, task_title: decryptedTitle }),
          now
        ).run();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              queue_id: queueId,
              task_id: taskId,
              task_title: decryptedTitle,
              executor_type: executorType,
              priority: priority,
              queued_at: now,
              message: `Task dispatched to ${executorType} queue. ${getRoutingNote(executorType)} Use nexus_check_queue to see pending work.`,
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_dispatch_ready
  server.tool(
    'nexus_dispatch_ready',
    'Dispatch all tasks with status="next" to the execution queue. Use this to immediately queue all ready tasks instead of waiting for the cron.',
    {
      executor_type: z.enum(['claude-code', 'claude-ai', 'de-agent', 'human']).optional()
        .describe('Filter to only dispatch tasks that would route to this executor'),
      limit: z.number().optional().describe('Maximum number of tasks to dispatch (default: 50)'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      // Validate passphrase for write operation
      const authError = validatePassphrase('nexus_dispatch_ready', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      try {
        const filterExecutorType = args.executor_type;
        const limit = args.limit || 50;
        const encryptionKey = await getEncryptionKey(env.KV, tenantId);
        const now = new Date().toISOString();

        // Get tasks with status="next"
        const tasks = await env.DB.prepare(`
          SELECT id, user_id, title, description, urgency, importance,
                 project_id, domain, due_date, energy_required, source_type, source_reference
          FROM tasks
          WHERE tenant_id = ? AND status = 'next' AND deleted_at IS NULL
          ORDER BY urgency DESC, importance DESC, created_at ASC
          LIMIT ?
        `).bind(tenantId, limit * 2).all<{
          id: string;
          user_id: string;
          title: string;
          description: string | null;
          urgency: number;
          importance: number;
          project_id: string | null;
          domain: string;
          due_date: string | null;
          energy_required: string;
          source_type: string | null;
          source_reference: string | null;
        }>();

        if (!tasks.results || tasks.results.length === 0) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                dispatched: 0,
                message: 'No tasks with status="next" found',
              }, null, 2)
            }]
          };
        }

        // Auto-detect executor patterns
        const patterns: Array<{ pattern: RegExp; executor: 'claude-code' | 'claude-ai' | 'de-agent' | 'human' }> = [
          // Literal executor names (highest priority)
          { pattern: /^\[claude-code\]/i, executor: 'claude-code' },
          { pattern: /^\[claude-ai\]/i, executor: 'claude-ai' },
          { pattern: /^\[de-agent\]/i, executor: 'de-agent' },
          // Shorthand tags
          { pattern: /^\[CC\]/i, executor: 'claude-code' },
          { pattern: /^\[AI\]/i, executor: 'claude-ai' },
          { pattern: /^\[DE\]/i, executor: 'de-agent' },
          { pattern: /^\[HUMAN\]/i, executor: 'human' },
          { pattern: /^\[BLOCKED\]/i, executor: 'human' },
          // Semantic tags
          { pattern: /^\[implement\]/i, executor: 'claude-code' },
          { pattern: /^\[deploy\]/i, executor: 'claude-code' },
          { pattern: /^\[fix\]/i, executor: 'claude-code' },
          { pattern: /^\[refactor\]/i, executor: 'claude-code' },
          { pattern: /^\[test\]/i, executor: 'claude-code' },
          { pattern: /^\[debug\]/i, executor: 'claude-code' },
          { pattern: /^\[code\]/i, executor: 'claude-code' },
          { pattern: /^\[research\]/i, executor: 'claude-ai' },
          { pattern: /^\[design\]/i, executor: 'claude-ai' },
          { pattern: /^\[document\]/i, executor: 'claude-ai' },
          { pattern: /^\[analyze\]/i, executor: 'claude-ai' },
          { pattern: /^\[plan\]/i, executor: 'claude-ai' },
          { pattern: /^\[write\]/i, executor: 'claude-ai' },
          { pattern: /^\[human\]/i, executor: 'human' },
          { pattern: /^\[review\]/i, executor: 'human' },
          { pattern: /^\[approve\]/i, executor: 'human' },
          { pattern: /^\[decide\]/i, executor: 'human' },
          { pattern: /^\[call\]/i, executor: 'human' },
          { pattern: /^\[meeting\]/i, executor: 'human' },
        ];

        const dispatched: Array<{ task_id: string; task_title: string; executor_type: string; queue_id: string }> = [];
        const skipped: Array<{ task_id: string; reason: string }> = [];

        for (const task of tasks.results) {
          if (dispatched.length >= limit) break;

          // Check if already queued
          const existing = await env.DB.prepare(`
            SELECT id FROM execution_queue
            WHERE task_id = ? AND status IN ('queued', 'claimed', 'dispatched')
          `).bind(task.id).first<{ id: string }>();

          if (existing) {
            skipped.push({ task_id: task.id, reason: 'already_queued' });
            continue;
          }

          // Decrypt title
          const decryptedTitle = await safeDecrypt(task.title, encryptionKey);

          // Determine executor type
          let executorType: 'claude-code' | 'claude-ai' | 'de-agent' | 'human' = 'human';
          for (const { pattern, executor } of patterns) {
            if (pattern.test(decryptedTitle)) {
              executorType = executor;
              break;
            }
          }

          // Filter by executor type if specified
          if (filterExecutorType && executorType !== filterExecutorType) {
            skipped.push({ task_id: task.id, reason: `executor_mismatch (${executorType})` });
            continue;
          }

          // Calculate priority
          const priority = (task.urgency || 3) * (task.importance || 3);

          // Build context
          const context = JSON.stringify({
            task_title: decryptedTitle,
            task_description: task.description ? await safeDecrypt(task.description, encryptionKey) : null,
            project_id: task.project_id,
            domain: task.domain,
            due_date: task.due_date,
            energy_required: task.energy_required,
            source_type: task.source_type,
            source_reference: task.source_reference,
          });

          // Add to queue
          const queueId = crypto.randomUUID();
          await env.DB.prepare(`
            INSERT INTO execution_queue (
              id, tenant_id, user_id, task_id, executor_type, status,
              priority, queued_at, context, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
          `).bind(
            queueId,
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

          // Log
          const logId = crypto.randomUUID();
          await env.DB.prepare(`
            INSERT INTO dispatch_log (id, tenant_id, queue_entry_id, task_id, executor_type, action, details, created_at)
            VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
          `).bind(logId, tenantId, queueId, task.id, executorType, JSON.stringify({ source: 'batch_dispatch' }), now).run();

          dispatched.push({
            task_id: task.id,
            task_title: decryptedTitle,
            executor_type: executorType,
            queue_id: queueId,
          });
        }

        // Summarize by executor type
        const byExecutor: Record<string, number> = {};
        for (const d of dispatched) {
          byExecutor[d.executor_type] = (byExecutor[d.executor_type] || 0) + 1;
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              dispatched: dispatched.length,
              skipped: skipped.length,
              by_executor: byExecutor,
              tasks: dispatched,
              skipped_tasks: skipped.length > 0 ? skipped : undefined,
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_execute_task
  server.tool(
    'nexus_execute_task',
    'Execute a queued task immediately via sandbox-executor. Routes both claude-ai and claude-code tasks to /execute endpoint (uses OAuth credentials). Also supports de-agent tasks via DE service. Use this for immediate task execution instead of waiting for the 15-minute cron.',
    {
      queue_id: z.string().uuid().describe('Queue entry ID to execute (from nexus_check_queue)'),
      repo: z.string().optional().describe('GitHub repo in owner/repo format (e.g., "CyberBrown/nexus"). Overrides any repo in task context. For claude-code tasks only.'),
      branch: z.string().optional().describe('Git branch to create/use. Overrides any branch in task context. For claude-code tasks only.'),
      commit_message: z.string().optional().describe('Commit message for changes. If not provided, auto-generates from task title. For claude-code tasks only.'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      // Validate passphrase for write operation
      const authError = validatePassphrase('nexus_execute_task', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      try {
        const queueId = args.queue_id;

        // Build override options from MCP params
        const overrideOptions = {
          repo: args.repo,
          branch: args.branch,
          commit_message: args.commit_message,
        };

        // Execute the task via sandbox-executor or DE
        const result = await executeQueueEntry(env, queueId, tenantId, overrideOptions);

        if (result.success) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                queue_id: queueId,
                message: 'Task executed successfully',
                result: result.result,
              }, null, 2)
            }]
          };
        } else {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                queue_id: queueId,
                error: result.error,
              }, null, 2)
            }],
            isError: true
          };
        }
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_run_executor
  server.tool(
    'nexus_run_executor',
    'Run the task executor immediately to process all queued tasks. This is the same as what the 15-minute cron does, but triggered manually. Processes both claude-ai and claude-code tasks via /execute endpoint (uses OAuth credentials), and de-agent tasks via DE service.',
    {
      executor_type: z.enum(['claude-ai', 'claude-code', 'de-agent', 'all']).optional()
        .describe('Filter to only execute tasks of this type. Default: all'),
      limit: z.number().min(1).max(20).optional()
        .describe('Maximum number of tasks to execute (default: 10)'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      // Validate passphrase for write operation
      const authError = validatePassphrase('nexus_run_executor', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      try {
        // Import executeTasks
        const { executeTasks } = await import('../scheduled/task-executor.ts');

        // Run the executor
        const stats = await executeTasks(env);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'Task executor run completed',
              stats: {
                processed: stats.processed,
                completed: stats.completed,
                failed: stats.failed,
                skipped: stats.skipped,
                errors: stats.errors.length > 0 ? stats.errors : undefined,
              },
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // ========================================
  // EXECUTION QUEUE TOOLS (with quarantine support)
  // ========================================

  // Helper: Check and apply quarantine if needed
  async function checkAndQuarantine(db: D1Database, queueId: string, tenantId: string): Promise<boolean> {
    const entry = await db.prepare(`
      SELECT id, retry_count, max_retries FROM execution_queue
      WHERE id = ? AND tenant_id = ?
    `).bind(queueId, tenantId).first<{ id: string; retry_count: number; max_retries: number }>();

    if (!entry) return false;

    if (entry.retry_count >= entry.max_retries) {
      const now = new Date().toISOString();
      await db.prepare(`
        UPDATE execution_queue
        SET status = 'quarantine',
            error = 'Max attempts (' || ? || ') exceeded',
            updated_at = ?
        WHERE id = ?
      `).bind(entry.retry_count, now, queueId).run();
      return true;
    }
    return false;
  }


  // Tool: nexus_reset_quarantine
  server.tool(
    'nexus_reset_quarantine',
    'Reset quarantined tasks back to queued status so they can be retried. Use this after fixing the underlying issue (e.g., re-authenticating OAuth).',
    {
      executor_type: z.enum(['claude-code', 'claude-ai', 'de-agent', 'human', 'all']).optional()
        .describe('Filter to only reset tasks of this executor type. Default: all'),
      task_id: z.string().uuid().optional()
        .describe('Reset a specific task by ID instead of all quarantined tasks'),
      limit: z.number().min(1).max(100).optional()
        .describe('Maximum number of tasks to reset (default: 50, max: 100)'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      // Validate passphrase for write operation
      const authError = validatePassphrase('nexus_reset_quarantine', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      try {
        const executorType = args.executor_type;
        const taskId = args.task_id;
        const limit = Math.min(args.limit || 50, 100);
        const now = new Date().toISOString();

        let query: string;
        let bindings: unknown[];

        if (taskId) {
          // Reset specific task
          query = `
            UPDATE execution_queue
            SET status = 'queued',
                retry_count = 0,
                error = NULL,
                updated_at = ?
            WHERE tenant_id = ? AND task_id = ? AND status = 'quarantine'
          `;
          bindings = [now, tenantId, taskId];
        } else if (executorType && executorType !== 'all') {
          // Reset by executor type
          query = `
            UPDATE execution_queue
            SET status = 'queued',
                retry_count = 0,
                error = NULL,
                updated_at = ?
            WHERE tenant_id = ? AND executor_type = ? AND status = 'quarantine'
            AND id IN (
              SELECT id FROM execution_queue
              WHERE tenant_id = ? AND executor_type = ? AND status = 'quarantine'
              ORDER BY priority DESC, queued_at ASC
              LIMIT ?
            )
          `;
          bindings = [now, tenantId, executorType, tenantId, executorType, limit];
        } else {
          // Reset all quarantined
          query = `
            UPDATE execution_queue
            SET status = 'queued',
                retry_count = 0,
                error = NULL,
                updated_at = ?
            WHERE tenant_id = ? AND status = 'quarantine'
            AND id IN (
              SELECT id FROM execution_queue
              WHERE tenant_id = ? AND status = 'quarantine'
              ORDER BY priority DESC, queued_at ASC
              LIMIT ?
            )
          `;
          bindings = [now, tenantId, tenantId, limit];
        }

        const result = await env.DB.prepare(query).bind(...bindings).run();

        // Get count of remaining quarantined tasks
        const remainingResult = await env.DB.prepare(`
          SELECT COUNT(*) as count FROM execution_queue
          WHERE tenant_id = ? AND status = 'quarantine'
        `).bind(tenantId).first<{ count: number }>();

        const resetCount = result.meta?.changes || 0;
        const remaining = remainingResult?.count || 0;

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              reset_count: resetCount,
              remaining_quarantined: remaining,
              message: resetCount > 0
                ? `Reset ${resetCount} quarantined task(s) back to queued status. They will be picked up by the next executor run.`
                : 'No quarantined tasks found matching the criteria.',
              filter: {
                executor_type: executorType || 'all',
                task_id: taskId || null,
                limit: limit,
              },
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_cleanup_queue
  server.tool(
    'nexus_cleanup_queue',
    'Clean up duplicate and stale entries from execution_queue. Removes quarantine entries where the task already has an active entry, and optionally clears old completed/failed/cancelled entries.',
    {
      mode: z.enum(['duplicates', 'stale', 'all']).default('duplicates')
        .describe('Cleanup mode: "duplicates" removes quarantine entries with active task entries, "stale" removes old completed/failed/cancelled entries (>7 days), "all" does both'),
      dry_run: z.boolean().default(false)
        .describe('If true, only report what would be deleted without actually deleting'),
      passphrase: passphraseSchema,
    },
    async ({ mode, dry_run, passphrase }) => {
      try {
        const authError = validatePassphrase('nexus_cleanup_queue', { passphrase }, env.WRITE_PASSPHRASE);
        if (authError) return authError;

        const tenantId = 'default';
        const results: { duplicates_removed: number; stale_removed: number; details: string[] } = {
          duplicates_removed: 0,
          stale_removed: 0,
          details: [],
        };

        // Find and remove quarantine entries where task already has an active entry
        if (mode === 'duplicates' || mode === 'all') {
          // First, identify duplicates
          const duplicates = await env.DB.prepare(`
            SELECT q1.id, q1.task_id, q1.status as quarantine_status, q2.status as active_status
            FROM execution_queue q1
            INNER JOIN execution_queue q2 ON q1.task_id = q2.task_id AND q1.id != q2.id
            WHERE q1.tenant_id = ?
              AND q1.status = 'quarantine'
              AND q2.status IN ('queued', 'claimed', 'dispatched')
          `).bind(tenantId).all();

          if (duplicates.results && duplicates.results.length > 0) {
            results.details.push(`Found ${duplicates.results.length} quarantine entries with active task entries`);

            if (!dry_run) {
              // Delete the duplicate quarantine entries
              const ids = duplicates.results.map((d: any) => d.id);
              for (const id of ids) {
                await env.DB.prepare(`
                  DELETE FROM execution_queue WHERE id = ? AND tenant_id = ?
                `).bind(id, tenantId).run();
              }
              results.duplicates_removed = ids.length;
            } else {
              results.duplicates_removed = duplicates.results.length;
            }
          }
        }

        // Remove stale entries (completed/failed/cancelled older than 7 days)
        if (mode === 'stale' || mode === 'all') {
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

          // Count stale entries
          const staleCount = await env.DB.prepare(`
            SELECT COUNT(*) as count FROM execution_queue
            WHERE tenant_id = ?
              AND status IN ('completed', 'failed', 'cancelled')
              AND updated_at < ?
          `).bind(tenantId, sevenDaysAgo).first<{ count: number }>();

          if (staleCount && staleCount.count > 0) {
            results.details.push(`Found ${staleCount.count} stale entries older than 7 days`);

            if (!dry_run) {
              await env.DB.prepare(`
                DELETE FROM execution_queue
                WHERE tenant_id = ?
                  AND status IN ('completed', 'failed', 'cancelled')
                  AND updated_at < ?
              `).bind(tenantId, sevenDaysAgo).run();
              results.stale_removed = staleCount.count;
            } else {
              results.stale_removed = staleCount.count;
            }
          }
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              dry_run,
              mode,
              ...results,
              message: dry_run
                ? `Dry run complete. Would remove ${results.duplicates_removed} duplicates and ${results.stale_removed} stale entries.`
                : `Cleanup complete. Removed ${results.duplicates_removed} duplicates and ${results.stale_removed} stale entries.`,
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // ========================================
  // PROMPTS (become slash commands)
  // ========================================

  server.prompt(
    'quick_capture',
    'Quickly capture content to Nexus inbox for AI classification',
    {
      content: z.string().describe('The content to capture (will be AI-classified)'),
    },
    ({ content }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Capture this to Nexus: "${content}"

Use the nexus_capture tool to save this content. Then briefly confirm what was captured.`,
        },
      }],
    })
  );

  server.prompt(
    'new_idea',
    'Create a new idea in Nexus',
    {
      title: z.string().describe('Title of the idea'),
      description: z.string().optional().describe('Detailed description of the idea'),
      category: z.string().optional().describe('Category: feature, improvement, bug, documentation, research, infrastructure, random'),
    },
    ({ title, description, category }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Create a new idea in Nexus:
Title: ${title}
${description ? `Description: ${description}` : ''}
${category ? `Category: ${category}` : ''}

Use the nexus_create_idea tool with these details. Then confirm the idea was created and suggest next steps (planning, adding more details, etc).`,
        },
      }],
    })
  );

  server.prompt(
    'check_status',
    'Check Nexus status - active executions, blocked items, and recent ideas',
    {},
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Check my Nexus status. Use the following tools:
1. nexus_list_active - Show active executions
2. nexus_list_blocked - Show anything blocked needing my input
3. nexus_list_ideas with status="no_execution" and limit=5 - Show recent unplanned ideas

Summarize what needs my attention and what's in progress.`,
        },
      }],
    })
  );

  server.prompt(
    'plan_and_execute',
    'Plan an idea and optionally execute it to create tasks',
    {
      idea_id: z.string().describe('UUID of the idea to plan'),
    },
    ({ idea_id }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Plan and execute idea: ${idea_id}

1. First use nexus_get_status to see if there's already a plan
2. If no plan exists, use nexus_plan_idea to generate one
3. Show me the plan and ask if I want to proceed
4. If I confirm, use nexus_execute_idea to create tasks`,
        },
      }],
    })
  );

  server.prompt(
    'daily_review',
    'Do a daily review - see blocked items, in-progress work, inbox, and recent ideas',
    {},
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Do a daily review of my Nexus system:

1. Use nexus_list_blocked to check for blockers needing resolution
2. Use nexus_list_active to see in-progress work
3. Use nexus_list_tasks with status="inbox" to see new tasks
4. Use nexus_list_ideas with limit=10 to see recent ideas

Give me a summary in this format:
- Blocked (need my input)
- In Progress
- New in Inbox
- Recent Ideas

Then suggest what I should focus on.`,
        },
      }],
    })
  );

  return server;
}

// Export the handler factory for use in the main router
export function createNexusMcpHandler(env: Env, tenantId: string, userId: string) {
  const server = createNexusMcpServer(env, tenantId, userId);
  return createMcpHandler(server);
}
