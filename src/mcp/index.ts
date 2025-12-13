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
import { getEncryptionKey, encryptField, decryptField } from '../lib/encryption.ts';

// ========================================
// PASSPHRASE AUTH HELPERS
// ========================================

/**
 * Tools that modify data (create, update, delete, execute)
 * These require passphrase validation when WRITE_PASSPHRASE is set
 */
const WRITE_TOOLS = new Set([
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
]);

/**
 * Tools that only read data - no passphrase required
 */
const READ_TOOLS = new Set([
  'nexus_get_status',
  'nexus_list_ideas',
  'nexus_list_active',
  'nexus_list_blocked',
  'nexus_list_tasks',
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
    'Trigger AI planning for an idea. Generates an execution plan with steps, effort estimates, risks, and dependencies.',
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
        // Get and decrypt the idea
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
        const decryptedTitle = idea.title ? await decryptField(idea.title, encryptionKey) : '';
        const decryptedDescription = idea.description ? await decryptField(idea.description, encryptionKey) : '';

        // Get or create DO instance
        const doId = env.IDEA_EXECUTOR.idFromName(`${tenantId}:${idea_id}`);
        const stub = env.IDEA_EXECUTOR.get(doId);

        // Initialize
        const executionId = crypto.randomUUID();
        const initResponse = await stub.fetch(new Request('http://do/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            executionId,
            ideaId: idea_id,
            tenantId,
            userId,
            ideaTitle: decryptedTitle,
            ideaDescription: decryptedDescription,
          }),
        }));

        if (!initResponse.ok) {
          const error = await initResponse.json() as { error: string };
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.error }) }],
            isError: true
          };
        }

        // Generate plan
        const planResponse = await stub.fetch(new Request('http://do/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ideaTitle: decryptedTitle,
            ideaDescription: decryptedDescription,
          }),
        }));

        const result = await planResponse.json() as { success: boolean; data?: { plan: unknown }; error?: string };

        if (result.success && result.data?.plan) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                idea_id,
                title: decryptedTitle,
                execution_id: executionId,
                plan: result.data.plan,
                message: 'Plan generated. Use nexus_execute_idea to create tasks from this plan.',
              }, null, 2)
            }]
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: !result.success
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool: nexus_execute_idea
  server.tool(
    'nexus_execute_idea',
    'Execute a planned idea by creating tasks from the generated plan',
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
        const doId = env.IDEA_EXECUTOR.idFromName(`${tenantId}:${idea_id}`);
        const stub = env.IDEA_EXECUTOR.get(doId);

        const response = await stub.fetch(new Request('http://do/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }));

        const result = await response.json() as { success: boolean; data?: { tasksCreated: number; tasks: unknown[] } };

        if (result.success && result.data) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                idea_id,
                tasks_created: result.data.tasksCreated,
                tasks: result.data.tasks,
                message: `Created ${result.data.tasksCreated} tasks from the plan. Tasks are now in the inbox.`,
              }, null, 2)
            }]
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: !result.success
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
    'Get the current execution status for an idea, including plan details, task progress, and any blockers',
    {
      idea_id: z.string().describe('The UUID of the idea to check'),
    },
    async ({ idea_id }): Promise<CallToolResult> => {
      try {
        // Get idea details
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
        const decryptedTitle = idea.title ? await decryptField(idea.title as string, encryptionKey) : '';

        // Get execution status from DO
        const doId = env.IDEA_EXECUTOR.idFromName(`${tenantId}:${idea_id}`);
        const stub = env.IDEA_EXECUTOR.get(doId);

        const response = await stub.fetch(new Request('http://do/status'));
        const statusResult = await response.json() as { success: boolean; data: unknown };

        // Also get from DB for historical data
        const execution = await env.DB.prepare(`
          SELECT * FROM idea_executions
          WHERE idea_id = ? AND tenant_id = ? AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT 1
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
                created_at: idea.created_at,
              },
              execution: statusResult.data || (execution ? {
                id: execution.id,
                status: execution.status,
                phase: execution.phase,
                plan: execution.plan ? JSON.parse(execution.plan as string) : null,
                started_at: execution.started_at,
                completed_at: execution.completed_at,
              } : null),
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

        // Decrypt titles
        const encryptionKey = await getEncryptionKey(env.KV, tenantId);
        const decryptedIdeas = await Promise.all(
          ideas.results.map(async (idea: Record<string, unknown>) => ({
            id: idea.id,
            title: idea.title ? await decryptField(idea.title as string, encryptionKey) : '',
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
            title: e.idea_title ? await decryptField(e.idea_title as string, encryptionKey) : '',
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
            title: e.idea_title ? await decryptField(e.idea_title as string, encryptionKey) : '',
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
        const doId = env.IDEA_EXECUTOR.idFromName(`${tenantId}:${idea_id}`);
        const stub = env.IDEA_EXECUTOR.get(doId);

        const response = await stub.fetch(new Request('http://do/resolve-blocker', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blockerId: blocker_id, resolution }),
        }));

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
          resolution,
          new Date().toISOString()
        ).run();

        const result = await response.json();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
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

        const doId = env.IDEA_EXECUTOR.idFromName(`${tenantId}:${idea_id}`);
        const stub = env.IDEA_EXECUTOR.get(doId);

        const response = await stub.fetch(new Request('http://do/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: cancelReason }),
        }));

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
          new Date().toISOString()
        ).run();

        const result = await response.json();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
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

  // Tool: nexus_delete_idea
  server.tool(
    'nexus_delete_idea',
    'Permanently delete an idea (hard delete). Use sparingly - prefer archive for most cases.',
    {
      idea_id: z.string().describe('The UUID of the idea to delete'),
      confirm: z.boolean().describe('Must be true to confirm deletion'),
      passphrase: passphraseSchema,
    },
    async (args): Promise<CallToolResult> => {
      const authError = validatePassphrase('nexus_delete_idea', args, env.WRITE_PASSPHRASE);
      if (authError) return authError;

      const { idea_id, confirm } = args;

      if (!confirm) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Must set confirm=true to delete' }) }],
          isError: true
        };
      }

      try {
        const now = new Date().toISOString();

        // Soft delete (set deleted_at)
        const result = await env.DB.prepare(`
          UPDATE ideas SET deleted_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
        `).bind(now, now, idea_id, tenantId).run();

        if (result.meta.changes === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Idea not found or already deleted' }) }],
            isError: true
          };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              idea_id,
              message: 'Idea deleted successfully',
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
