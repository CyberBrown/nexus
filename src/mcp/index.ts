/**
 * MCP Protocol Handler for Nexus
 *
 * Implements the Model Context Protocol for Claude.ai integration.
 * This allows Claude to interact with Nexus via MCP tools.
 */

import { Hono } from 'hono';
import type { AppType } from '../types/index.ts';
import { getAuth } from '../lib/auth.ts';
import { tools, getToolByName } from './tools.ts';
import { getEncryptionKey, encryptField, decryptField } from '../lib/encryption.ts';

// MCP Protocol types
interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface MCPToolCallParams {
  name: string;
  arguments: Record<string, unknown>;
}

const mcpRoutes = new Hono<AppType>();

/**
 * MCP Initialize - Returns server info and capabilities
 */
mcpRoutes.post('/', async (c) => {
  const body = await c.req.json() as MCPRequest;

  switch (body.method) {
    case 'initialize':
      return c.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: {
            name: 'nexus-mcp',
            version: '1.0.0',
          },
          capabilities: {
            tools: {},
          },
        },
      } as MCPResponse);

    case 'tools/list':
      return c.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          tools: tools,
        },
      } as MCPResponse);

    case 'tools/call':
      return handleToolCall(c, body);

    case 'notifications/initialized':
      // Client acknowledged initialization
      return c.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {},
      } as MCPResponse);

    default:
      return c.json({
        jsonrpc: '2.0',
        id: body.id,
        error: {
          code: -32601,
          message: `Method not found: ${body.method}`,
        },
      } as MCPResponse);
  }
});

/**
 * Handle tool calls
 */
async function handleToolCall(c: any, request: MCPRequest): Promise<Response> {
  const params = request.params as MCPToolCallParams;
  const { tenantId, userId } = getAuth(c);

  if (!params?.name) {
    return c.json({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32602,
        message: 'Missing tool name',
      },
    } as MCPResponse);
  }

  const tool = getToolByName(params.name);
  if (!tool) {
    return c.json({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32602,
        message: `Unknown tool: ${params.name}`,
      },
    } as MCPResponse);
  }

  try {
    const args = params.arguments || {};
    let result: unknown;

    switch (params.name) {
      case 'nexus_create_idea':
        result = await createIdea(c, tenantId, userId, args);
        break;
      case 'nexus_plan_idea':
        result = await planIdea(c, tenantId, userId, args);
        break;
      case 'nexus_execute_idea':
        result = await executeIdea(c, tenantId, args);
        break;
      case 'nexus_get_status':
        result = await getStatus(c, tenantId, args);
        break;
      case 'nexus_list_ideas':
        result = await listIdeas(c, tenantId, args);
        break;
      case 'nexus_list_active':
        result = await listActive(c, tenantId);
        break;
      case 'nexus_list_blocked':
        result = await listBlocked(c, tenantId);
        break;
      case 'nexus_resolve_blocker':
        result = await resolveBlocker(c, tenantId, userId, args);
        break;
      case 'nexus_cancel_execution':
        result = await cancelExecution(c, tenantId, userId, args);
        break;
      case 'nexus_log_decision':
        result = await logDecision(c, tenantId, userId, args);
        break;
      case 'nexus_list_tasks':
        result = await listTasks(c, tenantId, args);
        break;
      case 'nexus_capture':
        result = await capture(c, tenantId, userId, args);
        break;
      default:
        return c.json({
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32602,
            message: `Tool not implemented: ${params.name}`,
          },
        } as MCPResponse);
    }

    return c.json({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      },
    } as MCPResponse);
  } catch (error) {
    console.error(`Tool ${params.name} error:`, error);
    return c.json({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32603,
        message: String(error),
      },
    } as MCPResponse);
  }
}

// Tool implementations

async function createIdea(c: any, tenantId: string, userId: string, args: Record<string, unknown>) {
  const encryptionKey = await getEncryptionKey(c.env.KV, tenantId);
  const now = new Date().toISOString();
  const ideaId = crypto.randomUUID();

  const title = args.title as string;
  const description = args.description as string | undefined;
  const encryptedTitle = await encryptField(title, encryptionKey);
  const encryptedDescription = description ? await encryptField(description, encryptionKey) : null;

  await c.env.DB.prepare(`
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
    success: true,
    idea_id: ideaId,
    title: title,
    message: `Idea "${title}" created successfully. Use nexus_plan_idea to generate an execution plan.`,
  };
}

async function planIdea(c: any, tenantId: string, userId: string, args: Record<string, unknown>) {
  const ideaId = args.idea_id as string;

  // Get and decrypt the idea
  const idea = await c.env.DB.prepare(`
    SELECT id, title, description FROM ideas
    WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
  `).bind(ideaId, tenantId).first<{ id: string; title: string; description: string }>();

  if (!idea) {
    return { success: false, error: 'Idea not found' };
  }

  const encryptionKey = await getEncryptionKey(c.env.KV, tenantId);
  const decryptedTitle = idea.title ? await decryptField(idea.title, encryptionKey) : '';
  const decryptedDescription = idea.description ? await decryptField(idea.description, encryptionKey) : '';

  // Get or create DO instance
  const doId = c.env.IDEA_EXECUTOR.idFromName(`${tenantId}:${ideaId}`);
  const stub = c.env.IDEA_EXECUTOR.get(doId);

  // Initialize
  const executionId = crypto.randomUUID();
  const initResponse = await stub.fetch(new Request('http://do/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      executionId,
      ideaId,
      tenantId,
      userId,
      ideaTitle: decryptedTitle,
      ideaDescription: decryptedDescription,
    }),
  }));

  if (!initResponse.ok) {
    const error = await initResponse.json() as { error: string };
    return { success: false, error: error.error };
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
      success: true,
      idea_id: ideaId,
      title: decryptedTitle,
      execution_id: executionId,
      plan: result.data.plan,
      message: 'Plan generated. Use nexus_execute_idea to create tasks from this plan.',
    };
  }

  return result;
}

async function executeIdea(c: any, tenantId: string, args: Record<string, unknown>) {
  const ideaId = args.idea_id as string;

  const doId = c.env.IDEA_EXECUTOR.idFromName(`${tenantId}:${ideaId}`);
  const stub = c.env.IDEA_EXECUTOR.get(doId);

  const response = await stub.fetch(new Request('http://do/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }));

  const result = await response.json() as { success: boolean; data?: { tasksCreated: number; tasks: unknown[] } };

  if (result.success && result.data) {
    return {
      success: true,
      idea_id: ideaId,
      tasks_created: result.data.tasksCreated,
      tasks: result.data.tasks,
      message: `Created ${result.data.tasksCreated} tasks from the plan. Tasks are now in the inbox.`,
    };
  }

  return result;
}

async function getStatus(c: any, tenantId: string, args: Record<string, unknown>) {
  const ideaId = args.idea_id as string;

  // Get idea details
  const idea = await c.env.DB.prepare(`
    SELECT id, title, category, created_at FROM ideas
    WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
  `).bind(ideaId, tenantId).first();

  if (!idea) {
    return { success: false, error: 'Idea not found' };
  }

  // Decrypt title
  const encryptionKey = await getEncryptionKey(c.env.KV, tenantId);
  const decryptedTitle = idea.title ? await decryptField(idea.title as string, encryptionKey) : '';

  // Get execution status from DO
  const doId = c.env.IDEA_EXECUTOR.idFromName(`${tenantId}:${ideaId}`);
  const stub = c.env.IDEA_EXECUTOR.get(doId);

  const response = await stub.fetch(new Request('http://do/status'));
  const statusResult = await response.json() as { success: boolean; data: unknown };

  // Also get from DB for historical data
  const execution = await c.env.DB.prepare(`
    SELECT * FROM idea_executions
    WHERE idea_id = ? AND tenant_id = ? AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).bind(ideaId, tenantId).first();

  return {
    success: true,
    idea: {
      id: ideaId,
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
  };
}

async function listIdeas(c: any, tenantId: string, args: Record<string, unknown>) {
  const limit = (args.limit as number) || 20;
  const category = args.category as string | undefined;
  const status = args.status as string | undefined;

  let query = `
    SELECT
      i.id,
      i.title,
      i.description,
      i.category,
      i.created_at,
      e.status as execution_status,
      e.phase as execution_phase
    FROM ideas i
    LEFT JOIN idea_executions e ON i.id = e.idea_id AND e.deleted_at IS NULL
    WHERE i.tenant_id = ? AND i.deleted_at IS NULL AND i.archived_at IS NULL
  `;

  const bindings: unknown[] = [tenantId];

  if (category) {
    query += ' AND i.category = ?';
    bindings.push(category);
  }

  if (status && status !== 'all') {
    if (status === 'no_execution') {
      query += ' AND e.id IS NULL';
    } else {
      query += ' AND e.status = ?';
      bindings.push(status);
    }
  }

  query += ' ORDER BY i.created_at DESC LIMIT ?';
  bindings.push(limit);

  const ideas = await c.env.DB.prepare(query).bind(...bindings).all();

  // Decrypt titles
  const encryptionKey = await getEncryptionKey(c.env.KV, tenantId);
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
    success: true,
    count: decryptedIdeas.length,
    ideas: decryptedIdeas,
  };
}

async function listActive(c: any, tenantId: string) {
  const executions = await c.env.DB.prepare(`
    SELECT
      e.*,
      i.title as idea_title
    FROM idea_executions e
    JOIN ideas i ON e.idea_id = i.id
    WHERE e.tenant_id = ? AND e.deleted_at IS NULL
      AND e.status IN ('pending', 'planning', 'in_progress', 'blocked')
    ORDER BY e.updated_at DESC
  `).bind(tenantId).all();

  const encryptionKey = await getEncryptionKey(c.env.KV, tenantId);
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
    success: true,
    count: decrypted.length,
    executions: decrypted,
  };
}

async function listBlocked(c: any, tenantId: string) {
  const executions = await c.env.DB.prepare(`
    SELECT
      e.*,
      i.title as idea_title
    FROM idea_executions e
    JOIN ideas i ON e.idea_id = i.id
    WHERE e.tenant_id = ? AND e.deleted_at IS NULL
      AND e.status = 'blocked'
    ORDER BY e.updated_at DESC
  `).bind(tenantId).all();

  const encryptionKey = await getEncryptionKey(c.env.KV, tenantId);
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
    success: true,
    count: decrypted.length,
    blocked: decrypted,
    message: decrypted.length > 0
      ? 'Use nexus_resolve_blocker to resolve blockers and continue execution.'
      : 'No blocked executions.',
  };
}

async function resolveBlocker(c: any, tenantId: string, userId: string, args: Record<string, unknown>) {
  const ideaId = args.idea_id as string;
  const blockerId = args.blocker_id as string;
  const resolution = args.resolution as string;

  const doId = c.env.IDEA_EXECUTOR.idFromName(`${tenantId}:${ideaId}`);
  const stub = c.env.IDEA_EXECUTOR.get(doId);

  const response = await stub.fetch(new Request('http://do/resolve-blocker', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blockerId, resolution }),
  }));

  // Log the decision
  await c.env.DB.prepare(`
    INSERT INTO decisions (id, tenant_id, user_id, entity_type, entity_id, decision, reasoning, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    tenantId,
    userId,
    'execution',
    ideaId,
    'resolved_blocker',
    resolution,
    new Date().toISOString()
  ).run();

  const result = await response.json();
  return result;
}

async function cancelExecution(c: any, tenantId: string, userId: string, args: Record<string, unknown>) {
  const ideaId = args.idea_id as string;
  const reason = args.reason as string || 'Cancelled via MCP';

  const doId = c.env.IDEA_EXECUTOR.idFromName(`${tenantId}:${ideaId}`);
  const stub = c.env.IDEA_EXECUTOR.get(doId);

  const response = await stub.fetch(new Request('http://do/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  }));

  // Log the decision
  await c.env.DB.prepare(`
    INSERT INTO decisions (id, tenant_id, user_id, entity_type, entity_id, decision, reasoning, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    tenantId,
    userId,
    'execution',
    ideaId,
    'cancelled',
    reason,
    new Date().toISOString()
  ).run();

  const result = await response.json();
  return result;
}

async function logDecision(c: any, tenantId: string, userId: string, args: Record<string, unknown>) {
  const decisionId = crypto.randomUUID();

  await c.env.DB.prepare(`
    INSERT INTO decisions (id, tenant_id, user_id, entity_type, entity_id, decision, reasoning, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    decisionId,
    tenantId,
    userId,
    args.entity_type,
    args.entity_id,
    args.decision,
    args.reasoning || null,
    new Date().toISOString()
  ).run();

  return {
    success: true,
    decision_id: decisionId,
    message: 'Decision logged successfully.',
  };
}

async function listTasks(c: any, tenantId: string, args: Record<string, unknown>) {
  const limit = (args.limit as number) || 50;
  const status = args.status as string | undefined;
  const sourceType = args.source_type as string | undefined;

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

  if (sourceType) {
    query += ' AND source_type = ?';
    bindings.push(sourceType);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  bindings.push(limit);

  const tasks = await c.env.DB.prepare(query).bind(...bindings).all();

  return {
    success: true,
    count: tasks.results.length,
    tasks: tasks.results.map((t: Record<string, unknown>) => ({
      id: t.id,
      title: t.title, // Tasks from idea_execution aren't encrypted (for now)
      status: t.status,
      source_type: t.source_type,
      source_reference: t.source_reference,
      due_date: t.due_date,
      created_at: t.created_at,
    })),
  };
}

async function capture(c: any, tenantId: string, userId: string, args: Record<string, unknown>) {
  const content = args.content as string;
  const sourceType = (args.source_type as string) || 'claude';

  // Forward to InboxManager DO
  const doId = c.env.INBOX_MANAGER.idFromName(tenantId);
  const stub = c.env.INBOX_MANAGER.get(doId);

  const response = await stub.fetch(new Request('http://do/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_id: tenantId,
      user_id: userId,
      input: {
        raw_content: content,
        source_type: sourceType,
        captured_at: new Date().toISOString(),
      },
    }),
  }));

  const result = await response.json() as { success: boolean; data?: { id: string } };

  if (result.success) {
    return {
      success: true,
      inbox_item_id: result.data?.id,
      message: 'Content captured and queued for AI classification. It may be auto-promoted to a task or idea.',
    };
  }

  return result;
}

export default mcpRoutes;
