import { WorkflowEntrypoint, WorkflowStep, type WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '../types/index.ts';
import { getEncryptionKey, decryptField, encryptField } from '../lib/encryption.ts';

// Parameters passed to the workflow
interface IdeaToPlanParams {
  idea_id: string;
  tenant_id: string;
  user_id: string;
  execution_id: string;
}

// Task generated from Claude's planning
interface PlannedTask {
  order: number;
  title: string;
  description: string;
  agent_type: 'ai' | 'human' | 'human-ai';
  estimated_effort: 'xs' | 's' | 'm' | 'l' | 'xl';
  depends_on?: number[]; // Step order numbers this task depends on
}

// Idea data from database
interface IdeaData {
  id: string;
  title: string;
  description: string | null;
  category: string;
  domain: string | null;
}

export class IdeaToPlanWorkflow extends WorkflowEntrypoint<Env, IdeaToPlanParams> {
  override async run(event: WorkflowEvent<IdeaToPlanParams>, step: WorkflowStep) {
    const { idea_id, tenant_id, user_id, execution_id } = event.payload;

    // Step 1: Load idea from D1
    const idea = await step.do('load-idea', async () => {
      const row = await this.env.DB.prepare(`
        SELECT id, title, description, category, domain
        FROM ideas
        WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
      `).bind(idea_id, tenant_id).first<IdeaData>();

      if (!row) {
        throw new Error(`Idea not found: ${idea_id}`);
      }

      // Decrypt fields
      const key = await getEncryptionKey(this.env.KV, tenant_id);
      const title = await decryptField(row.title, key);
      const description = row.description ? await decryptField(row.description, key) : null;

      return { ...row, title, description };
    });

    // Step 2: Update execution status to 'planning'
    await step.do('update-status-planning', async () => {
      const now = new Date().toISOString();
      await this.env.DB.prepare(`
        UPDATE idea_executions
        SET status = 'planning', started_at = ?, updated_at = ?
        WHERE id = ?
      `).bind(now, now, execution_id).run();

      await this.env.DB.prepare(`
        UPDATE ideas
        SET execution_status = 'planned', updated_at = ?
        WHERE id = ?
      `).bind(now, idea_id).run();
    });

    // Step 3: Call DE text-gen worker to break down idea into tasks
    const tasks = await step.do(
      'generate-plan',
      {
        retries: {
          limit: 3,
          delay: '5 seconds',
          backoff: 'exponential',
        },
        timeout: '2 minutes',
      },
      async () => {
        // Workflows can't use service bindings - must use TEXT_GEN_URL
        const textGenUrl = this.env.TEXT_GEN_URL;
        if (!textGenUrl) {
          throw new Error('TEXT_GEN_URL not configured. Set TEXT_GEN_URL in wrangler.toml [vars]');
        }

        const userPrompt = buildPlanningPrompt(idea);
        const prompt = `System: ${PLANNING_SYSTEM_PROMPT}\n\nUser: ${userPrompt}\n\nAssistant:`;

        const response = await fetch(`${textGenUrl}/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt,
            model: 'claude-sonnet-4-20250514',
            max_tokens: 2048,
            temperature: 0.7,
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`DE text-gen error: ${response.status} - ${error}`);
        }

        const data = await response.json() as {
          success: boolean;
          text: string;
          metadata: {
            provider: string;
            model: string;
            tokens_used: number;
          };
        };

        if (!data.success || !data.text) {
          throw new Error('DE returned empty response');
        }

        let text = data.text;

        // Strip markdown code blocks
        text = text.trim();
        if (text.startsWith('```json')) {
          text = text.slice(7);
        } else if (text.startsWith('```')) {
          text = text.slice(3);
        }
        if (text.endsWith('```')) {
          text = text.slice(0, -3);
        }
        text = text.trim();

        const parsed = JSON.parse(text) as { tasks: PlannedTask[] };
        return parsed.tasks;
      }
    );

    // Step 4: Store tasks in D1 with dependencies
    const taskCount = await step.do('store-tasks', async () => {
      const key = await getEncryptionKey(this.env.KV, tenant_id);
      const now = new Date().toISOString();

      // Map order → taskId for dependency creation
      const orderToTaskId = new Map<number, string>();

      // First pass: create all tasks
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i]!;
        const taskId = crypto.randomUUID();
        const order = task.order ?? (i + 1);
        orderToTaskId.set(order, taskId);

        // Encrypt sensitive fields
        const encryptedTitle = await encryptField(task.title, key);
        const encryptedDescription = task.description
          ? await encryptField(task.description, key)
          : null;

        await this.env.DB.prepare(`
          INSERT INTO idea_tasks (
            id, tenant_id, user_id, idea_id,
            title, description, agent_type, estimated_effort,
            sequence_order, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
        `).bind(
          taskId,
          tenant_id,
          user_id,
          idea_id,
          encryptedTitle,
          encryptedDescription,
          task.agent_type,
          task.estimated_effort,
          order,
          now,
          now
        ).run();

        // Also create regular task for execution
        // Tasks with dependencies start as 'inbox', others as 'next'
        const hasDependencies = task.depends_on && task.depends_on.length > 0;
        const initialStatus = hasDependencies ? 'inbox' : 'next';

        await this.env.DB.prepare(`
          INSERT INTO tasks (
            id, tenant_id, user_id, title, description, status,
            source_type, source_reference, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'idea_execution', ?, ?, ?)
        `).bind(
          taskId,
          tenant_id,
          user_id,
          encryptedTitle,
          encryptedDescription,
          initialStatus,
          execution_id,
          now,
          now
        ).run();
      }

      // Second pass: create task dependencies
      for (const task of tasks) {
        if (task.depends_on && task.depends_on.length > 0) {
          const order = task.order ?? 0;
          const taskId = orderToTaskId.get(order);
          if (!taskId) continue;

          for (const dependsOnOrder of task.depends_on) {
            const dependsOnTaskId = orderToTaskId.get(dependsOnOrder);
            if (!dependsOnTaskId) {
              console.warn(`Task ${order} depends on non-existent task ${dependsOnOrder}`);
              continue;
            }

            const depId = crypto.randomUUID();
            await this.env.DB.prepare(`
              INSERT INTO task_dependencies (id, tenant_id, task_id, depends_on_task_id, dependency_type, created_at)
              VALUES (?, ?, ?, ?, 'blocks', ?)
            `).bind(depId, tenant_id, taskId, dependsOnTaskId, now).run();

            console.log(`Created dependency: Task ${order} blocked by task ${dependsOnOrder}`);
          }
        }
      }

      return tasks.length;
    });

    // Step 5: Update execution status to 'planned'
    await step.do('update-status-planned', async () => {
      const now = new Date().toISOString();
      await this.env.DB.prepare(`
        UPDATE idea_executions
        SET status = 'planned', planned_at = ?, total_tasks = ?, updated_at = ?
        WHERE id = ?
      `).bind(now, taskCount, now, execution_id).run();
    });

    return {
      success: true,
      idea_id,
      execution_id,
      tasks_created: taskCount,
    };
  }
}

const PLANNING_SYSTEM_PROMPT = `You are an AI assistant that breaks down ideas into executable tasks.

Given an idea, analyze it and break it down into a series of concrete, actionable tasks.

For each task, determine:
1. order: Sequential number starting at 1
2. title: A clear, actionable title (imperative mood, e.g., "Research X", "Implement Y")
3. description: Detailed description of what needs to be done
4. agent_type: Who/what should execute this task:
   - "ai": Can be executed by AI (coding, writing, research, analysis)
   - "human": Requires human action, judgment, approval, or physical action
   - "human-ai": Collaborative task requiring both human and AI input
5. estimated_effort: T-shirt size estimate:
   - "xs": < 15 minutes
   - "s": 15-60 minutes
   - "m": 1-4 hours
   - "l": 4-8 hours
   - "xl": > 8 hours
6. depends_on: Array of order numbers this task depends on (empty if independent)

Task dependencies (depends_on field):
- Use depends_on to specify which tasks must complete BEFORE this task can start
- List the order numbers of blocking tasks, e.g. "depends_on": [1, 2]
- Tasks with empty depends_on: [] can run immediately
- This enables parallel execution of independent tasks
- Example: If task 3 needs output from task 1, set "depends_on": [1]

Guidelines:
- Break complex ideas into 3-10 tasks
- Keep tasks atomic and independently executable where possible
- Use depends_on to express task ordering instead of assuming sequential execution
- Be specific about what each task should produce/accomplish
- Tasks marked "human" should be decision points or actions requiring user input
- Maximize parallelism: only add dependencies where truly required

Return ONLY valid JSON with this structure:
{
  "tasks": [
    {
      "order": 1,
      "title": "First task (no dependencies)",
      "description": "string",
      "agent_type": "ai",
      "estimated_effort": "s",
      "depends_on": []
    },
    {
      "order": 2,
      "title": "Task that needs task 1",
      "description": "string",
      "agent_type": "ai",
      "estimated_effort": "m",
      "depends_on": [1]
    }
  ]
}`;

function buildPlanningPrompt(idea: IdeaData): string {
  let prompt = `Break down this idea into executable tasks:\n\n`;
  prompt += `Title: ${idea.title}\n`;
  if (idea.description) {
    prompt += `Description: ${idea.description}\n`;
  }
  if (idea.category && idea.category !== 'random') {
    prompt += `Category: ${idea.category}\n`;
  }
  if (idea.domain) {
    prompt += `Domain: ${idea.domain}\n`;
  }
  return prompt;
}
