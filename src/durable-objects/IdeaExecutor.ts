import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/index.ts';

/**
 * IdeaExecutor Durable Object
 *
 * Manages the lifecycle of idea → execution pipeline:
 * 1. Planning phase: AI generates a plan/spec from the idea
 * 2. Task generation: Break plan into concrete tasks
 * 3. Execution: Track task completion
 * 4. Review: Surface results for CEO review
 */

interface ExecutionState {
  executionId: string;
  ideaId: string;
  tenantId: string;
  userId: string;
  status: 'pending' | 'planning' | 'in_progress' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  phase: 'init' | 'planning' | 'task_generation' | 'execution' | 'review';
  plan: ExecutionPlan | null;
  tasks: GeneratedTask[];
  blockers: Blocker[];
  result: ExecutionResult | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ExecutionPlan {
  summary: string;
  approach: string;
  steps: PlanStep[];
  estimatedEffort: string; // xs, s, m, l, xl
  risks: string[];
  dependencies: string[];
}

interface PlanStep {
  order: number;
  description: string;
  type: 'research' | 'design' | 'implement' | 'test' | 'deploy' | 'document';
  estimatedMinutes: number;
}

interface GeneratedTask {
  taskId: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

interface Blocker {
  id: string;
  type: 'decision_needed' | 'missing_info' | 'dependency' | 'error';
  description: string;
  options?: string[];
  createdAt: string;
  resolvedAt?: string;
  resolution?: string;
}

interface ExecutionResult {
  summary: string;
  tasksCompleted: number;
  tasksTotal: number;
  outputs: string[]; // URLs, file paths, or descriptions of what was created
  nextSteps?: string[];
}

export class IdeaExecutor extends DurableObject<Env> {
  private state: ExecutionState | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Restore state from storage
    this.ctx.blockConcurrencyWhile(async () => {
      this.state = await this.ctx.storage.get('state') ?? null;
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (request.method) {
        case 'POST':
          if (path === '/init') return this.handleInit(request);
          if (path === '/plan') return this.handleGeneratePlan(request);
          if (path === '/execute') return this.handleStartExecution(request);
          if (path === '/resolve-blocker') return this.handleResolveBlocker(request);
          if (path === '/cancel') return this.handleCancel(request);
          break;
        case 'GET':
          if (path === '/status') return this.handleGetStatus();
          break;
        case 'PATCH':
          if (path === '/task-update') return this.handleTaskUpdate(request);
          break;
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error('IdeaExecutor error:', error);
      return Response.json({ success: false, error: String(error) }, { status: 500 });
    }
  }

  // Initialize a new execution
  private async handleInit(request: Request): Promise<Response> {
    const body = await request.json() as {
      executionId: string;
      ideaId: string;
      tenantId: string;
      userId: string;
      ideaTitle: string;
      ideaDescription: string;
    };

    if (this.state && this.state.status !== 'completed' && this.state.status !== 'failed' && this.state.status !== 'cancelled') {
      return Response.json({
        success: false,
        error: 'Execution already in progress',
        currentStatus: this.state.status,
      }, { status: 409 });
    }

    const now = new Date().toISOString();
    this.state = {
      executionId: body.executionId,
      ideaId: body.ideaId,
      tenantId: body.tenantId,
      userId: body.userId,
      status: 'pending',
      phase: 'init',
      plan: null,
      tasks: [],
      blockers: [],
      result: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    await this.saveState();

    return Response.json({
      success: true,
      data: {
        executionId: this.state.executionId,
        status: this.state.status,
        phase: this.state.phase,
      },
    });
  }

  // Generate a plan from the idea using AI
  private async handleGeneratePlan(request: Request): Promise<Response> {
    if (!this.state) {
      return Response.json({ success: false, error: 'No execution initialized' }, { status: 400 });
    }

    const body = await request.json() as {
      ideaTitle: string;
      ideaDescription: string;
    };

    this.state.status = 'planning';
    this.state.phase = 'planning';
    this.state.startedAt = new Date().toISOString();
    await this.saveState();

    try {
      // Call Claude to generate a plan
      const plan = await this.generatePlanWithAI(body.ideaTitle, body.ideaDescription);

      this.state.plan = plan;
      this.state.phase = 'task_generation';
      this.state.updatedAt = new Date().toISOString();
      await this.saveState();

      // Sync to database
      await this.syncToDatabase();

      return Response.json({
        success: true,
        data: {
          executionId: this.state.executionId,
          status: this.state.status,
          phase: this.state.phase,
          plan: this.state.plan,
        },
      });
    } catch (error) {
      this.state.status = 'failed';
      this.state.error = String(error);
      this.state.updatedAt = new Date().toISOString();
      await this.saveState();
      await this.syncToDatabase();

      return Response.json({ success: false, error: String(error) }, { status: 500 });
    }
  }

  // Start execution (create tasks from plan)
  private async handleStartExecution(request: Request): Promise<Response> {
    if (!this.state) {
      return Response.json({ success: false, error: 'No execution initialized' }, { status: 400 });
    }

    if (!this.state.plan) {
      return Response.json({ success: false, error: 'No plan generated yet' }, { status: 400 });
    }

    this.state.status = 'in_progress';
    this.state.phase = 'execution';
    this.state.updatedAt = new Date().toISOString();

    try {
      // Create tasks from plan steps
      const tasks = await this.createTasksFromPlan();
      this.state.tasks = tasks;

      await this.saveState();
      await this.syncToDatabase();

      return Response.json({
        success: true,
        data: {
          executionId: this.state.executionId,
          status: this.state.status,
          phase: this.state.phase,
          tasksCreated: tasks.length,
          tasks: tasks,
        },
      });
    } catch (error) {
      this.state.status = 'blocked';
      this.state.blockers.push({
        id: crypto.randomUUID(),
        type: 'error',
        description: `Failed to create tasks: ${error}`,
        createdAt: new Date().toISOString(),
      });
      await this.saveState();
      await this.syncToDatabase();

      return Response.json({ success: false, error: String(error) }, { status: 500 });
    }
  }

  // Update task status (called when a task completes)
  private async handleTaskUpdate(request: Request): Promise<Response> {
    if (!this.state) {
      return Response.json({ success: false, error: 'No execution initialized' }, { status: 400 });
    }

    const body = await request.json() as {
      taskId: string;
      status: 'pending' | 'in_progress' | 'completed' | 'failed';
    };

    const task = this.state.tasks.find(t => t.taskId === body.taskId);
    if (task) {
      task.status = body.status;
    }

    // Check if all tasks are complete
    const allCompleted = this.state.tasks.every(t => t.status === 'completed');
    const anyFailed = this.state.tasks.some(t => t.status === 'failed');

    if (allCompleted) {
      this.state.status = 'completed';
      this.state.phase = 'review';
      this.state.completedAt = new Date().toISOString();
      this.state.result = {
        summary: `Completed ${this.state.tasks.length} tasks for idea execution`,
        tasksCompleted: this.state.tasks.length,
        tasksTotal: this.state.tasks.length,
        outputs: [],
      };
    } else if (anyFailed && !this.state.tasks.some(t => t.status === 'in_progress' || t.status === 'pending')) {
      this.state.status = 'failed';
      this.state.completedAt = new Date().toISOString();
    }

    this.state.updatedAt = new Date().toISOString();
    await this.saveState();
    await this.syncToDatabase();

    return Response.json({
      success: true,
      data: {
        executionId: this.state.executionId,
        status: this.state.status,
        tasksCompleted: this.state.tasks.filter(t => t.status === 'completed').length,
        tasksTotal: this.state.tasks.length,
      },
    });
  }

  // Resolve a blocker
  private async handleResolveBlocker(request: Request): Promise<Response> {
    if (!this.state) {
      return Response.json({ success: false, error: 'No execution initialized' }, { status: 400 });
    }

    const body = await request.json() as {
      blockerId: string;
      resolution: string;
    };

    const blocker = this.state.blockers.find(b => b.id === body.blockerId);
    if (!blocker) {
      return Response.json({ success: false, error: 'Blocker not found' }, { status: 404 });
    }

    blocker.resolvedAt = new Date().toISOString();
    blocker.resolution = body.resolution;

    // If all blockers are resolved, resume execution
    const unresolvedBlockers = this.state.blockers.filter(b => !b.resolvedAt);
    if (unresolvedBlockers.length === 0 && this.state.status === 'blocked') {
      this.state.status = 'in_progress';
    }

    this.state.updatedAt = new Date().toISOString();
    await this.saveState();
    await this.syncToDatabase();

    return Response.json({
      success: true,
      data: {
        executionId: this.state.executionId,
        status: this.state.status,
        unresolvedBlockers: unresolvedBlockers.length,
      },
    });
  }

  // Cancel execution
  private async handleCancel(request: Request): Promise<Response> {
    if (!this.state) {
      return Response.json({ success: false, error: 'No execution initialized' }, { status: 400 });
    }

    const body = await request.json() as { reason?: string };

    this.state.status = 'cancelled';
    this.state.completedAt = new Date().toISOString();
    this.state.error = body.reason || 'Cancelled by user';
    this.state.updatedAt = new Date().toISOString();

    await this.saveState();
    await this.syncToDatabase();

    return Response.json({
      success: true,
      data: {
        executionId: this.state.executionId,
        status: this.state.status,
      },
    });
  }

  // Get current status
  private async handleGetStatus(): Promise<Response> {
    if (!this.state) {
      return Response.json({
        success: true,
        data: null,
      });
    }

    return Response.json({
      success: true,
      data: {
        executionId: this.state.executionId,
        ideaId: this.state.ideaId,
        status: this.state.status,
        phase: this.state.phase,
        plan: this.state.plan,
        tasks: this.state.tasks,
        blockers: this.state.blockers.filter(b => !b.resolvedAt),
        result: this.state.result,
        error: this.state.error,
        startedAt: this.state.startedAt,
        completedAt: this.state.completedAt,
        progress: this.state.tasks.length > 0
          ? {
              completed: this.state.tasks.filter(t => t.status === 'completed').length,
              total: this.state.tasks.length,
              percentage: Math.round((this.state.tasks.filter(t => t.status === 'completed').length / this.state.tasks.length) * 100),
            }
          : null,
      },
    });
  }

  // Generate plan using Claude AI
  private async generatePlanWithAI(title: string, description: string): Promise<ExecutionPlan> {
    // Debug: log available env keys (not values for security)
    console.log('IdeaExecutor env keys:', Object.keys(this.env));

    const apiKey = this.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not configured. Available env keys: ' + Object.keys(this.env).join(', '));
    }

    const systemPrompt = `You are a technical project planner. Given an idea, create a detailed execution plan.

Output JSON in this exact format:
{
  "summary": "One sentence summary of the plan",
  "approach": "2-3 sentences describing the overall approach",
  "steps": [
    {
      "order": 1,
      "description": "What to do in this step",
      "type": "research|design|implement|test|deploy|document",
      "estimatedMinutes": 30
    }
  ],
  "estimatedEffort": "xs|s|m|l|xl",
  "risks": ["Risk 1", "Risk 2"],
  "dependencies": ["Dependency 1"]
}

Effort scale:
- xs: < 1 hour
- s: 1-4 hours
- m: 4-16 hours (1-2 days)
- l: 2-5 days
- xl: > 1 week`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: `Create an execution plan for this idea:\n\nTitle: ${title}\n\nDescription: ${description || 'No additional description provided'}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Claude API error: ${error}`);
    }

    const result = await response.json() as {
      content: Array<{ type: string; text: string }>;
    };

    const text = result.content[0]?.text || '';

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to parse plan from AI response');
    }

    return JSON.parse(jsonMatch[0]) as ExecutionPlan;
  }

  // Create tasks in the database from plan steps
  private async createTasksFromPlan(): Promise<GeneratedTask[]> {
    if (!this.state?.plan) return [];

    const tasks: GeneratedTask[] = [];

    for (const step of this.state.plan.steps) {
      const taskId = crypto.randomUUID();
      const now = new Date().toISOString();

      // Insert task into database
      await this.env.DB.prepare(`
        INSERT INTO tasks (
          id, tenant_id, user_id, title, description, status,
          source_type, source_reference, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        taskId,
        this.state.tenantId,
        this.state.userId,
        `[${step.type}] ${step.description}`,
        `Part of execution for idea: ${this.state.ideaId}\nEstimated: ${step.estimatedMinutes} minutes`,
        'inbox',
        'idea_execution',
        this.state.executionId,
        now,
        now
      ).run();

      tasks.push({
        taskId,
        title: step.description,
        status: 'pending',
      });
    }

    return tasks;
  }

  // Sync state to database
  private async syncToDatabase(): Promise<void> {
    if (!this.state) return;

    const now = new Date().toISOString();

    await this.env.DB.prepare(`
      INSERT INTO idea_executions (
        id, idea_id, tenant_id, user_id, status, phase,
        plan, tasks_generated, started_at, completed_at,
        result, blockers, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        phase = excluded.phase,
        plan = excluded.plan,
        tasks_generated = excluded.tasks_generated,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        result = excluded.result,
        blockers = excluded.blockers,
        error = excluded.error,
        updated_at = excluded.updated_at
    `).bind(
      this.state.executionId,
      this.state.ideaId,
      this.state.tenantId,
      this.state.userId,
      this.state.status,
      this.state.phase,
      this.state.plan ? JSON.stringify(this.state.plan) : null,
      this.state.tasks.length > 0 ? JSON.stringify(this.state.tasks) : null,
      this.state.startedAt,
      this.state.completedAt,
      this.state.result ? JSON.stringify(this.state.result) : null,
      this.state.blockers.length > 0 ? JSON.stringify(this.state.blockers) : null,
      this.state.error,
      this.state.createdAt,
      now
    ).run();
  }

  // Save state to durable storage
  private async saveState(): Promise<void> {
    await this.ctx.storage.put('state', this.state);
  }
}
