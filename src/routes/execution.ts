import { Hono } from 'hono';
import type { AppType, Idea, IdeaTask, IdeaExecution } from '../types/index.ts';
import { getAuth } from '../lib/auth.ts';
import { findById } from '../lib/db.ts';
import { getEncryptionKey, decryptFields, decryptField } from '../lib/encryption.ts';
import { NotFoundError, AppError, ValidationError } from '../lib/errors.ts';

const ENCRYPTED_IDEA_FIELDS = ['title', 'description'];
const ENCRYPTED_TASK_FIELDS = ['title', 'description', 'result'];

const execution = new Hono<AppType>();

// ========================================
// Trigger Planning Workflow
// ========================================

// POST /api/execution/ideas/:id/plan - Trigger planning workflow for an idea
execution.post('/ideas/:id/plan', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const ideaId = c.req.param('id');

  // Verify idea exists and user owns it
  const idea = await findById<Idea>(c.env.DB, 'ideas', ideaId, { tenantId });
  if (!idea || idea.user_id !== userId) {
    throw new NotFoundError('Idea', ideaId);
  }

  // Check if already executing
  if (idea.execution_status === 'executing' || idea.execution_status === 'planned') {
    throw new AppError('Idea is already being processed', 400, 'ALREADY_PROCESSING');
  }

  const now = new Date().toISOString();
  const executionId = crypto.randomUUID();

  // Create execution record
  await c.env.DB.prepare(`
    INSERT INTO idea_executions (
      id, tenant_id, user_id, idea_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).bind(executionId, tenantId, userId, ideaId, now, now).run();

  // Trigger the workflow
  const instance = await c.env.IDEA_TO_PLAN_WORKFLOW.create({
    id: executionId,
    params: {
      idea_id: ideaId,
      tenant_id: tenantId,
      user_id: userId,
      execution_id: executionId,
    },
  });

  // Update execution with workflow instance ID
  await c.env.DB.prepare(`
    UPDATE idea_executions
    SET workflow_instance_id = ?, updated_at = ?
    WHERE id = ?
  `).bind(instance.id, now, executionId).run();

  return c.json({
    success: true,
    data: {
      execution_id: executionId,
      workflow_instance_id: instance.id,
      status: 'pending',
    },
  });
});

// ========================================
// Trigger Task Execution
// ========================================

// POST /api/execution/tasks/:id/execute - Execute a specific task
execution.post('/tasks/:id/execute', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const taskId = c.req.param('id');

  // Load task
  const task = await c.env.DB.prepare(`
    SELECT * FROM idea_tasks
    WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
  `).bind(taskId, tenantId).first<IdeaTask>();

  if (!task || task.user_id !== userId) {
    throw new NotFoundError('Task', taskId);
  }

  // Check task is ready
  if (task.status !== 'ready' && task.status !== 'failed') {
    throw new AppError(`Task is not ready for execution (status: ${task.status})`, 400, 'TASK_NOT_READY');
  }

  // Get the execution record
  const exec = await c.env.DB.prepare(`
    SELECT id FROM idea_executions
    WHERE idea_id = ? AND tenant_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(task.idea_id, tenantId).first<{ id: string }>();

  if (!exec) {
    throw new AppError('No execution found for this idea', 400, 'NO_EXECUTION');
  }

  // Trigger execution workflow
  const instance = await c.env.TASK_EXECUTOR_WORKFLOW.create({
    id: `${exec.id}-${taskId}`,
    params: {
      task_id: taskId,
      tenant_id: tenantId,
      user_id: userId,
      idea_id: task.idea_id,
      execution_id: exec.id,
    },
  });

  const now = new Date().toISOString();
  await c.env.DB.prepare(`
    UPDATE idea_tasks
    SET status = 'in_progress', started_at = ?, updated_at = ?
    WHERE id = ?
  `).bind(now, now, taskId).run();

  return c.json({
    success: true,
    data: {
      task_id: taskId,
      workflow_instance_id: instance.id,
      status: 'in_progress',
    },
  });
});

// POST /api/execution/ideas/:id/execute-all - Execute all ready tasks for an idea
execution.post('/ideas/:id/execute-all', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const ideaId = c.req.param('id');

  // Verify idea exists
  const idea = await findById<Idea>(c.env.DB, 'ideas', ideaId, { tenantId });
  if (!idea || idea.user_id !== userId) {
    throw new NotFoundError('Idea', ideaId);
  }

  // Get execution record
  const exec = await c.env.DB.prepare(`
    SELECT id FROM idea_executions
    WHERE idea_id = ? AND tenant_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(ideaId, tenantId).first<{ id: string }>();

  if (!exec) {
    throw new AppError('No execution found for this idea. Run plan first.', 400, 'NO_EXECUTION');
  }

  // Get ready tasks
  const readyTasks = await c.env.DB.prepare(`
    SELECT id FROM idea_tasks
    WHERE idea_id = ? AND tenant_id = ? AND status = 'ready' AND deleted_at IS NULL
    ORDER BY sequence_order
  `).bind(ideaId, tenantId).all<{ id: string }>();

  const results: Array<{ task_id: string; workflow_instance_id: string }> = [];
  const now = new Date().toISOString();

  // Trigger execution for each ready task
  for (const task of readyTasks.results) {
    const instance = await c.env.TASK_EXECUTOR_WORKFLOW.create({
      id: `${exec.id}-${task.id}`,
      params: {
        task_id: task.id,
        tenant_id: tenantId,
        user_id: userId,
        idea_id: ideaId,
        execution_id: exec.id,
      },
    });

    await c.env.DB.prepare(`
      UPDATE idea_tasks
      SET status = 'in_progress', started_at = ?, updated_at = ?
      WHERE id = ?
    `).bind(now, now, task.id).run();

    results.push({
      task_id: task.id,
      workflow_instance_id: instance.id,
    });
  }

  // Update idea status
  await c.env.DB.prepare(`
    UPDATE ideas
    SET execution_status = 'executing', updated_at = ?
    WHERE id = ?
  `).bind(now, ideaId).run();

  return c.json({
    success: true,
    data: {
      idea_id: ideaId,
      tasks_started: results.length,
      tasks: results,
    },
  });
});

// ========================================
// Get Idea Status (with tasks and outputs)
// ========================================

// GET /api/execution/ideas/:id/status - Get full execution status
execution.get('/ideas/:id/status', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const ideaId = c.req.param('id');

  // Load idea
  const idea = await findById<Idea>(c.env.DB, 'ideas', ideaId, { tenantId });
  if (!idea || idea.user_id !== userId) {
    throw new NotFoundError('Idea', ideaId);
  }

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decryptedIdea = await decryptFields(idea, ENCRYPTED_IDEA_FIELDS, key);

  // Get latest execution
  const exec = await c.env.DB.prepare(`
    SELECT * FROM idea_executions
    WHERE idea_id = ? AND tenant_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(ideaId, tenantId).first<IdeaExecution>();

  // Get all tasks
  const tasksResult = await c.env.DB.prepare(`
    SELECT * FROM idea_tasks
    WHERE idea_id = ? AND tenant_id = ? AND deleted_at IS NULL
    ORDER BY sequence_order
  `).bind(ideaId, tenantId).all<IdeaTask>();

  // Decrypt tasks
  const tasks = await Promise.all(
    tasksResult.results.map(async (task) => {
      const decrypted = await decryptFields(task, ENCRYPTED_TASK_FIELDS, key);
      // Parse result if present
      if (decrypted.result) {
        try {
          decrypted.result = JSON.parse(decrypted.result as string);
        } catch {
          // Keep as string if not valid JSON
        }
      }
      return decrypted;
    })
  );

  // Calculate completion percentage
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(t => t.status === 'completed').length;
  const failedTasks = tasks.filter(t => t.status === 'failed').length;
  const blockedTasks = tasks.filter(t => t.status === 'blocked').length;
  const completionPct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  // Get blockers
  const blockers = tasks
    .filter(t => t.status === 'blocked')
    .map(t => ({ task_id: t.id, title: t.title, agent_type: t.agent_type }));

  return c.json({
    success: true,
    data: {
      idea: {
        id: decryptedIdea.id,
        title: decryptedIdea.title,
        description: decryptedIdea.description,
        execution_status: decryptedIdea.execution_status,
        category: decryptedIdea.category,
        domain: decryptedIdea.domain,
      },
      execution: exec ? {
        id: exec.id,
        status: exec.status,
        workflow_instance_id: exec.workflow_instance_id,
        started_at: exec.started_at,
        planned_at: exec.planned_at,
        completed_at: exec.completed_at,
      } : null,
      tasks,
      stats: {
        total: totalTasks,
        completed: completedTasks,
        failed: failedTasks,
        blocked: blockedTasks,
        completion_pct: completionPct,
      },
      blockers,
    },
  });
});

// ========================================
// List Ideas by Execution Status
// ========================================

// GET /api/execution/ideas - List ideas with execution info
execution.get('/ideas', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const status = c.req.query('status'); // new, planned, executing, done, blocked

  let query = `
    SELECT i.*, e.status as exec_status, e.total_tasks, e.completed_tasks, e.failed_tasks
    FROM ideas i
    LEFT JOIN (
      SELECT idea_id, status, total_tasks, completed_tasks, failed_tasks,
             ROW_NUMBER() OVER (PARTITION BY idea_id ORDER BY created_at DESC) as rn
      FROM idea_executions
      WHERE tenant_id = ?
    ) e ON i.id = e.idea_id AND e.rn = 1
    WHERE i.tenant_id = ? AND i.user_id = ? AND i.deleted_at IS NULL
  `;

  const bindings: string[] = [tenantId, tenantId, userId];

  if (status) {
    query += ` AND i.execution_status = ?`;
    bindings.push(status);
  }

  query += ` ORDER BY i.created_at DESC`;

  const results = await c.env.DB.prepare(query).bind(...bindings).all<Idea & {
    exec_status: string | null;
    total_tasks: number | null;
    completed_tasks: number | null;
    failed_tasks: number | null;
  }>();

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decrypted = await Promise.all(
    results.results.map(item => decryptFields(item, ENCRYPTED_IDEA_FIELDS, key))
  );

  return c.json({
    success: true,
    data: decrypted.map(item => ({
      id: item.id,
      title: item.title,
      description: item.description,
      category: item.category,
      domain: item.domain,
      execution_status: item.execution_status || 'new',
      exec_status: item.exec_status,
      total_tasks: item.total_tasks || 0,
      completed_tasks: item.completed_tasks || 0,
      failed_tasks: item.failed_tasks || 0,
      created_at: item.created_at,
    })),
  });
});

// ========================================
// Needs Input (Blocked/Human Tasks)
// ========================================

// GET /api/execution/needs-input - Get tasks requiring human input
execution.get('/needs-input', async (c) => {
  const { tenantId, userId } = getAuth(c);

  const results = await c.env.DB.prepare(`
    SELECT t.*, i.title as idea_title
    FROM idea_tasks t
    JOIN ideas i ON t.idea_id = i.id
    WHERE t.tenant_id = ? AND t.user_id = ?
    AND (t.status = 'blocked' OR t.agent_type = 'human')
    AND t.deleted_at IS NULL
    ORDER BY t.created_at DESC
  `).bind(tenantId, userId).all<IdeaTask & { idea_title: string }>();

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decrypted = await Promise.all(
    results.results.map(async (task) => {
      const decryptedTask = await decryptFields(task, ENCRYPTED_TASK_FIELDS, key);
      const ideaTitle = await decryptField(task.idea_title, key);
      return { ...decryptedTask, idea_title: ideaTitle };
    })
  );

  return c.json({
    success: true,
    data: decrypted,
  });
});

// ========================================
// Complete Human Task
// ========================================

// POST /api/execution/tasks/:id/complete - Mark a human task as completed
execution.post('/tasks/:id/complete', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const taskId = c.req.param('id');

  const task = await c.env.DB.prepare(`
    SELECT * FROM idea_tasks
    WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
  `).bind(taskId, tenantId).first<IdeaTask>();

  if (!task || task.user_id !== userId) {
    throw new NotFoundError('Task', taskId);
  }

  if (task.agent_type !== 'human' && task.status !== 'blocked') {
    throw new AppError('This task cannot be manually completed', 400, 'NOT_HUMAN_TASK');
  }

  const body = await c.req.json<{ result?: string }>();
  const now = new Date().toISOString();

  // Encrypt result if provided
  let encryptedResult = null;
  if (body.result) {
    const key = await getEncryptionKey(c.env.KV, tenantId);
    const { encryptField } = await import('../lib/encryption.ts');
    encryptedResult = await encryptField(JSON.stringify({ output: body.result, success: true }), key);
  }

  await c.env.DB.prepare(`
    UPDATE idea_tasks
    SET status = 'completed', result = ?, completed_at = ?, updated_at = ?
    WHERE id = ?
  `).bind(encryptedResult, now, now, taskId).run();

  // Update execution
  const exec = await c.env.DB.prepare(`
    SELECT id FROM idea_executions
    WHERE idea_id = ? ORDER BY created_at DESC LIMIT 1
  `).bind(task.idea_id).first<{ id: string }>();

  if (exec) {
    await c.env.DB.prepare(`
      UPDATE idea_executions
      SET completed_tasks = completed_tasks + 1, updated_at = ?
      WHERE id = ?
    `).bind(now, exec.id).run();

    // Check if all done
    const stats = await c.env.DB.prepare(`
      SELECT COUNT(*) as remaining
      FROM idea_tasks
      WHERE idea_id = ? AND status IN ('pending', 'ready', 'in_progress') AND deleted_at IS NULL
    `).bind(task.idea_id).first<{ remaining: number }>();

    if (stats && stats.remaining === 0) {
      await c.env.DB.prepare(`
        UPDATE idea_executions
        SET status = 'completed', completed_at = ?, blockers = NULL, updated_at = ?
        WHERE id = ?
      `).bind(now, now, exec.id).run();

      await c.env.DB.prepare(`
        UPDATE ideas
        SET execution_status = 'done', updated_at = ?
        WHERE id = ?
      `).bind(now, task.idea_id).run();
    } else {
      // Clear blockers and resume
      await c.env.DB.prepare(`
        UPDATE idea_executions
        SET status = 'executing', blockers = NULL, updated_at = ?
        WHERE id = ?
      `).bind(now, exec.id).run();
    }
  }

  return c.json({ success: true });
});

// ========================================
// Retry Failed Task
// ========================================

// POST /api/execution/tasks/:id/retry - Retry a failed task
execution.post('/tasks/:id/retry', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const taskId = c.req.param('id');

  const task = await c.env.DB.prepare(`
    SELECT * FROM idea_tasks
    WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
  `).bind(taskId, tenantId).first<IdeaTask>();

  if (!task || task.user_id !== userId) {
    throw new NotFoundError('Task', taskId);
  }

  if (task.status !== 'failed') {
    throw new AppError('Only failed tasks can be retried', 400, 'NOT_FAILED');
  }

  if (task.retry_count >= task.max_retries) {
    throw new AppError('Maximum retries exceeded', 400, 'MAX_RETRIES');
  }

  const now = new Date().toISOString();

  // Reset to ready and increment retry count
  await c.env.DB.prepare(`
    UPDATE idea_tasks
    SET status = 'ready', error_message = NULL, retry_count = retry_count + 1, updated_at = ?
    WHERE id = ?
  `).bind(now, taskId).run();

  return c.json({
    success: true,
    data: {
      task_id: taskId,
      status: 'ready',
      retry_count: task.retry_count + 1,
    },
  });
});

export default execution;
