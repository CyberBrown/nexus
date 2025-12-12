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
  title: string;
  description: string;
  agent_type: 'claude' | 'local' | 'human';
  estimated_effort: 'xs' | 's' | 'm' | 'l' | 'xl';
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

    // Step 3: Call Claude API to break down idea into tasks
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
        const prompt = buildPlanningPrompt(idea);

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 2048,
            system: PLANNING_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: prompt }],
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Claude API error: ${response.status} - ${error}`);
        }

        const data = await response.json() as {
          content: Array<{ type: string; text: string }>;
        };

        let text = data.content[0]?.text;
        if (!text) {
          throw new Error('No response from Claude');
        }

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

    // Step 4: Store tasks in D1
    const taskCount = await step.do('store-tasks', async () => {
      const key = await getEncryptionKey(this.env.KV, tenant_id);
      const now = new Date().toISOString();

      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i]!;
        const taskId = crypto.randomUUID();

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
          i,
          now,
          now
        ).run();
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
1. title: A clear, actionable title (imperative mood, e.g., "Research X", "Implement Y")
2. description: Detailed description of what needs to be done
3. agent_type: Who/what should execute this task:
   - "claude": Complex analysis, coding, writing, research that requires AI
   - "local": Quick tasks that could run on a local model (future capability)
   - "human": Requires human judgment, approval, or physical action
4. estimated_effort: T-shirt size estimate:
   - "xs": < 15 minutes
   - "s": 15-60 minutes
   - "m": 1-4 hours
   - "l": 4-8 hours
   - "xl": > 8 hours

Guidelines:
- Break complex ideas into 3-10 tasks
- Keep tasks atomic and independently executable where possible
- Order tasks logically (dependencies should come first)
- Be specific about what each task should produce/accomplish
- Tasks marked "human" should be decision points or actions requiring user input

Return ONLY valid JSON with this structure:
{
  "tasks": [
    {
      "title": "string",
      "description": "string",
      "agent_type": "claude" | "local" | "human",
      "estimated_effort": "xs" | "s" | "m" | "l" | "xl"
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
