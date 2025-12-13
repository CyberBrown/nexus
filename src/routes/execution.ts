import { Hono } from 'hono';
import type { AppType } from '../types/index.ts';
import { getAuth } from '../lib/auth.ts';
import { getEncryptionKey, decryptField } from '../lib/encryption.ts';

const executionRoutes = new Hono<AppType>();

/**
 * Execution API Routes
 *
 * Manages the idea → execution pipeline:
 * - List ideas ready for execution
 * - Trigger planning for an idea
 * - Start execution (create tasks)
 * - Check execution status
 * - Resolve blockers
 * - Cancel executions
 */

// GET /execution/ideas - List ideas with execution status
executionRoutes.get('/ideas', async (c) => {
  const { tenantId } = getAuth(c);

  try {
    // Get all ideas with their execution status
    const ideas = await c.env.DB.prepare(`
      SELECT
        i.id,
        i.title,
        i.description,
        i.category,
        i.effort_estimate,
        i.impact_score,
        i.priority_score,
        i.created_at,
        e.id as execution_id,
        e.status as execution_status,
        e.phase as execution_phase,
        e.started_at as execution_started,
        e.completed_at as execution_completed
      FROM ideas i
      LEFT JOIN idea_executions e ON i.id = e.idea_id AND e.deleted_at IS NULL
      WHERE i.tenant_id = ? AND i.deleted_at IS NULL AND i.archived_at IS NULL
      ORDER BY i.priority_score DESC NULLS LAST, i.created_at DESC
    `).bind(tenantId).all();

    return c.json({
      success: true,
      data: ideas.results.map(row => ({
        id: row.id,
        title: row.title,
        description: row.description,
        category: row.category,
        effortEstimate: row.effort_estimate,
        impactScore: row.impact_score,
        priorityScore: row.priority_score,
        createdAt: row.created_at,
        execution: row.execution_id ? {
          id: row.execution_id,
          status: row.execution_status,
          phase: row.execution_phase,
          startedAt: row.execution_started,
          completedAt: row.execution_completed,
        } : null,
      })),
    });
  } catch (error) {
    console.error('List execution ideas error:', error);
    return c.json({ success: false, error: 'Failed to list ideas' }, 500);
  }
});

// GET /execution/ideas/:id - Get idea with full execution details
executionRoutes.get('/ideas/:id', async (c) => {
  const { tenantId } = getAuth(c);
  const ideaId = c.req.param('id');

  try {
    // Get idea
    const idea = await c.env.DB.prepare(`
      SELECT * FROM ideas WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).bind(ideaId, tenantId).first();

    if (!idea) {
      return c.json({ success: false, error: 'Idea not found' }, 404);
    }

    // Get execution if exists
    const execution = await c.env.DB.prepare(`
      SELECT * FROM idea_executions
      WHERE idea_id = ? AND tenant_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).bind(ideaId, tenantId).first();

    // Get DO status if execution exists
    let doStatus = null;
    if (execution) {
      const doId = c.env.IDEA_EXECUTOR.idFromName(`${tenantId}:${ideaId}`);
      const stub = c.env.IDEA_EXECUTOR.get(doId);
      const response = await stub.fetch(new Request('http://do/status'));
      const statusResult = await response.json() as { success: boolean; data: unknown };
      doStatus = statusResult.data;
    }

    return c.json({
      success: true,
      data: {
        idea: {
          id: idea.id,
          title: idea.title,
          description: idea.description,
          category: idea.category,
          effortEstimate: idea.effort_estimate,
          impactScore: idea.impact_score,
          priorityScore: idea.priority_score,
          createdAt: idea.created_at,
        },
        execution: execution ? {
          id: execution.id,
          status: execution.status,
          phase: execution.phase,
          plan: execution.plan ? JSON.parse(execution.plan as string) : null,
          tasks: execution.tasks_generated ? JSON.parse(execution.tasks_generated as string) : [],
          blockers: execution.blockers ? JSON.parse(execution.blockers as string) : [],
          result: execution.result ? JSON.parse(execution.result as string) : null,
          error: execution.error,
          startedAt: execution.started_at,
          completedAt: execution.completed_at,
        } : null,
        liveStatus: doStatus,
      },
    });
  } catch (error) {
    console.error('Get execution idea error:', error);
    return c.json({ success: false, error: 'Failed to get idea' }, 500);
  }
});

// POST /execution/ideas/:id/plan - Trigger planning for an idea
executionRoutes.post('/ideas/:id/plan', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const ideaId = c.req.param('id');

  try {
    // Get the idea
    const idea = await c.env.DB.prepare(`
      SELECT id, title, description FROM ideas
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).bind(ideaId, tenantId).first<{ id: string; title: string; description: string }>();

    if (!idea) {
      return c.json({ success: false, error: 'Idea not found' }, 404);
    }

    // Decrypt title and description
    const encryptionKey = await getEncryptionKey(c.env.KV, tenantId);
    const decryptedTitle = idea.title ? await decryptField(idea.title, encryptionKey) : '';
    const decryptedDescription = idea.description ? await decryptField(idea.description, encryptionKey) : '';

    // Get or create DO instance for this idea
    const doId = c.env.IDEA_EXECUTOR.idFromName(`${tenantId}:${ideaId}`);
    const stub = c.env.IDEA_EXECUTOR.get(doId);

    // Initialize execution
    const executionId = crypto.randomUUID();
    const initResponse = await stub.fetch(new Request('http://do/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        executionId,
        ideaId: idea.id,
        tenantId,
        userId,
        ideaTitle: decryptedTitle,
        ideaDescription: decryptedDescription,
      }),
    }));

    if (!initResponse.ok) {
      const error = await initResponse.json() as { error: string };
      return c.json({ success: false, error: error.error }, initResponse.status);
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

    const result = await planResponse.json();
    return c.json(result, planResponse.ok ? 200 : 500);
  } catch (error) {
    console.error('Plan idea error:', error);
    return c.json({ success: false, error: 'Failed to generate plan' }, 500);
  }
});

// POST /execution/ideas/:id/execute - Start execution (create tasks from plan)
executionRoutes.post('/ideas/:id/execute', async (c) => {
  const { tenantId } = getAuth(c);
  const ideaId = c.req.param('id');

  try {
    const doId = c.env.IDEA_EXECUTOR.idFromName(`${tenantId}:${ideaId}`);
    const stub = c.env.IDEA_EXECUTOR.get(doId);

    const response = await stub.fetch(new Request('http://do/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await response.json();
    return c.json(result, response.ok ? 200 : 500);
  } catch (error) {
    console.error('Execute idea error:', error);
    return c.json({ success: false, error: 'Failed to start execution' }, 500);
  }
});

// GET /execution/ideas/:id/status - Get execution status
executionRoutes.get('/ideas/:id/status', async (c) => {
  const { tenantId } = getAuth(c);
  const ideaId = c.req.param('id');

  try {
    const doId = c.env.IDEA_EXECUTOR.idFromName(`${tenantId}:${ideaId}`);
    const stub = c.env.IDEA_EXECUTOR.get(doId);

    const response = await stub.fetch(new Request('http://do/status'));
    const result = await response.json();
    return c.json(result);
  } catch (error) {
    console.error('Get execution status error:', error);
    return c.json({ success: false, error: 'Failed to get status' }, 500);
  }
});

// POST /execution/ideas/:id/resolve - Resolve a blocker
executionRoutes.post('/ideas/:id/resolve', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const ideaId = c.req.param('id');

  try {
    const body = await c.req.json() as { blockerId: string; resolution: string };

    const doId = c.env.IDEA_EXECUTOR.idFromName(`${tenantId}:${ideaId}`);
    const stub = c.env.IDEA_EXECUTOR.get(doId);

    const response = await stub.fetch(new Request('http://do/resolve-blocker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
      body.resolution,
      new Date().toISOString()
    ).run();

    const result = await response.json();
    return c.json(result, response.ok ? 200 : 500);
  } catch (error) {
    console.error('Resolve blocker error:', error);
    return c.json({ success: false, error: 'Failed to resolve blocker' }, 500);
  }
});

// POST /execution/ideas/:id/cancel - Cancel execution
executionRoutes.post('/ideas/:id/cancel', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const ideaId = c.req.param('id');

  try {
    const body = await c.req.json() as { reason?: string };

    const doId = c.env.IDEA_EXECUTOR.idFromName(`${tenantId}:${ideaId}`);
    const stub = c.env.IDEA_EXECUTOR.get(doId);

    const response = await stub.fetch(new Request('http://do/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
      body.reason || 'Cancelled by user',
      new Date().toISOString()
    ).run();

    const result = await response.json();
    return c.json(result, response.ok ? 200 : 500);
  } catch (error) {
    console.error('Cancel execution error:', error);
    return c.json({ success: false, error: 'Failed to cancel execution' }, 500);
  }
});

// GET /execution/active - List all active executions
executionRoutes.get('/active', async (c) => {
  const { tenantId } = getAuth(c);

  try {
    const executions = await c.env.DB.prepare(`
      SELECT
        e.*,
        i.title as idea_title,
        i.description as idea_description
      FROM idea_executions e
      JOIN ideas i ON e.idea_id = i.id
      WHERE e.tenant_id = ? AND e.deleted_at IS NULL
        AND e.status IN ('pending', 'planning', 'in_progress', 'blocked')
      ORDER BY e.updated_at DESC
    `).bind(tenantId).all();

    return c.json({
      success: true,
      data: executions.results.map(row => ({
        id: row.id,
        ideaId: row.idea_id,
        ideaTitle: row.idea_title,
        status: row.status,
        phase: row.phase,
        blockers: row.blockers ? JSON.parse(row.blockers as string) : [],
        startedAt: row.started_at,
        updatedAt: row.updated_at,
      })),
    });
  } catch (error) {
    console.error('List active executions error:', error);
    return c.json({ success: false, error: 'Failed to list executions' }, 500);
  }
});

// GET /execution/decisions - List recent decisions
executionRoutes.get('/decisions', async (c) => {
  const { tenantId } = getAuth(c);
  const limit = parseInt(c.req.query('limit') || '50');

  try {
    const decisions = await c.env.DB.prepare(`
      SELECT * FROM decisions
      WHERE tenant_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(tenantId, limit).all();

    return c.json({
      success: true,
      data: decisions.results,
    });
  } catch (error) {
    console.error('List decisions error:', error);
    return c.json({ success: false, error: 'Failed to list decisions' }, 500);
  }
});

// POST /execution/decisions - Log a decision
executionRoutes.post('/decisions', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const body = await c.req.json() as {
      entityType: string;
      entityId: string;
      decision: string;
      reasoning?: string;
      context?: Record<string, unknown>;
    };

    const decisionId = crypto.randomUUID();
    await c.env.DB.prepare(`
      INSERT INTO decisions (id, tenant_id, user_id, entity_type, entity_id, decision, reasoning, context, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      decisionId,
      tenantId,
      userId,
      body.entityType,
      body.entityId,
      body.decision,
      body.reasoning || null,
      body.context ? JSON.stringify(body.context) : null,
      new Date().toISOString()
    ).run();

    return c.json({
      success: true,
      data: { id: decisionId },
    });
  } catch (error) {
    console.error('Log decision error:', error);
    return c.json({ success: false, error: 'Failed to log decision' }, 500);
  }
});

// ========================================
// Cloudflare Workflow Endpoints (Durable Execution)
// ========================================

// POST /execution/workflow/ideas/:id - Trigger idea execution via Cloudflare Workflow
// This is the preferred method for long-running executions with automatic retries
executionRoutes.post('/workflow/ideas/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const ideaId = c.req.param('id');

  try {
    // Get the idea
    const idea = await c.env.DB.prepare(`
      SELECT id, title, description FROM ideas
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).bind(ideaId, tenantId).first<{ id: string; title: string; description: string }>();

    if (!idea) {
      return c.json({ success: false, error: 'Idea not found' }, 404);
    }

    // Decrypt title and description
    const encryptionKey = await getEncryptionKey(c.env.KV, tenantId);
    const decryptedTitle = idea.title ? await decryptField(idea.title, encryptionKey) : '';
    const decryptedDescription = idea.description ? await decryptField(idea.description, encryptionKey) : '';

    // Start the workflow
    const workflowId = `idea-${ideaId}-${Date.now()}`;
    const instance = await c.env.IDEA_EXECUTION_WORKFLOW.create({
      id: workflowId,
      params: {
        ideaId: idea.id,
        tenantId,
        userId,
        ideaTitle: decryptedTitle,
        ideaDescription: decryptedDescription,
      },
    });

    return c.json({
      success: true,
      data: {
        workflowId: instance.id,
        ideaId,
        status: 'started',
        message: 'Workflow execution started. Use GET /execution/workflow/:id to check status.',
      },
    });
  } catch (error) {
    console.error('Start workflow error:', error);
    return c.json({ success: false, error: 'Failed to start workflow' }, 500);
  }
});

// GET /execution/workflow/:id - Get workflow instance status
executionRoutes.get('/workflow/:id', async (c) => {
  const workflowId = c.req.param('id');

  try {
    const instance = await c.env.IDEA_EXECUTION_WORKFLOW.get(workflowId);
    const status = await instance.status();

    return c.json({
      success: true,
      data: {
        workflowId,
        status: status.status,
        output: status.output,
        error: status.error,
      },
    });
  } catch (error) {
    console.error('Get workflow status error:', error);
    return c.json({ success: false, error: 'Workflow not found or failed to get status' }, 404);
  }
});

// POST /execution/workflow/:id/terminate - Terminate a running workflow
executionRoutes.post('/workflow/:id/terminate', async (c) => {
  const workflowId = c.req.param('id');

  try {
    const instance = await c.env.IDEA_EXECUTION_WORKFLOW.get(workflowId);
    await instance.terminate();

    return c.json({
      success: true,
      data: { workflowId, status: 'terminated' },
    });
  } catch (error) {
    console.error('Terminate workflow error:', error);
    return c.json({ success: false, error: 'Failed to terminate workflow' }, 500);
  }
});

// GET /execution/workflows - List recent workflow instances
executionRoutes.get('/workflows', async (c) => {
  try {
    // Note: Cloudflare Workflows doesn't have a list API yet
    // This returns info from our idea_executions table instead
    const { tenantId } = getAuth(c);

    const executions = await c.env.DB.prepare(`
      SELECT id, idea_id, status, phase, started_at, completed_at, updated_at
      FROM idea_executions
      WHERE tenant_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 50
    `).bind(tenantId).all();

    return c.json({
      success: true,
      data: executions.results,
    });
  } catch (error) {
    console.error('List workflows error:', error);
    return c.json({ success: false, error: 'Failed to list workflows' }, 500);
  }
});

export default executionRoutes;
