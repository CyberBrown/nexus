import { WorkflowEntrypoint, WorkflowStep, type WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '../types/index.ts';
import { getEncryptionKey, decryptField, encryptField } from '../lib/encryption.ts';

// Parameters passed to the workflow
interface TaskExecutorParams {
  task_id: string;
  tenant_id: string;
  user_id: string;
  idea_id: string;
  execution_id: string;
}

// Task data from database
interface IdeaTask {
  id: string;
  idea_id: string;
  title: string;
  description: string | null;
  agent_type: 'claude' | 'local' | 'human';
  estimated_effort: string;
  status: string;
  retry_count: number;
  max_retries: number;
}

// Idea context for execution
interface IdeaContext {
  title: string;
  description: string | null;
}

// Execution result
interface ExecutionResult {
  success: boolean;
  output: string;
  artifacts?: string[];
}

export class TaskExecutorWorkflow extends WorkflowEntrypoint<Env, TaskExecutorParams> {
  override async run(event: WorkflowEvent<TaskExecutorParams>, step: WorkflowStep) {
    const { task_id, tenant_id, user_id, idea_id, execution_id } = event.payload;

    // Step 1: Load task from D1
    const task = await step.do('load-task', async () => {
      const row = await this.env.DB.prepare(`
        SELECT id, idea_id, title, description, agent_type, estimated_effort, status, retry_count, max_retries
        FROM idea_tasks
        WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
      `).bind(task_id, tenant_id).first<IdeaTask>();

      if (!row) {
        throw new Error(`Task not found: ${task_id}`);
      }

      // Decrypt fields
      const key = await getEncryptionKey(this.env.KV, tenant_id);
      const title = await decryptField(row.title, key);
      const description = row.description ? await decryptField(row.description, key) : null;

      return { ...row, title, description };
    });

    // Step 2: Load idea context
    const ideaContext = await step.do('load-idea-context', async () => {
      const row = await this.env.DB.prepare(`
        SELECT title, description FROM ideas WHERE id = ? AND tenant_id = ?
      `).bind(idea_id, tenant_id).first<{ title: string; description: string | null }>();

      if (!row) {
        return { title: 'Unknown idea', description: null };
      }

      const key = await getEncryptionKey(this.env.KV, tenant_id);
      const title = await decryptField(row.title, key);
      const description = row.description ? await decryptField(row.description, key) : null;

      return { title, description };
    });

    // Step 3: Update task status to 'in_progress'
    await step.do('update-status-in-progress', async () => {
      const now = new Date().toISOString();
      await this.env.DB.prepare(`
        UPDATE idea_tasks
        SET status = 'in_progress', started_at = ?, updated_at = ?
        WHERE id = ?
      `).bind(now, now, task_id).run();

      // Update execution status
      await this.env.DB.prepare(`
        UPDATE idea_executions
        SET status = 'executing', updated_at = ?
        WHERE id = ?
      `).bind(now, execution_id).run();

      // Update idea status
      await this.env.DB.prepare(`
        UPDATE ideas
        SET execution_status = 'executing', updated_at = ?
        WHERE id = ?
      `).bind(now, idea_id).run();
    });

    // Step 4: Execute based on agent type
    let result: ExecutionResult;

    if (task.agent_type === 'human') {
      // Human tasks get marked as blocked for CEO review
      result = await step.do('mark-human-task', async () => {
        const now = new Date().toISOString();
        await this.env.DB.prepare(`
          UPDATE idea_tasks
          SET status = 'blocked', updated_at = ?
          WHERE id = ?
        `).bind(now, task_id).run();

        // Update execution blockers
        await this.env.DB.prepare(`
          UPDATE idea_executions
          SET status = 'blocked',
              blockers = json_array(?),
              updated_at = ?
          WHERE id = ?
        `).bind(`Human input required: ${task.title}`, now, execution_id).run();

        return {
          success: false,
          output: 'Task requires human input. Marked for CEO review.',
        };
      });
    } else if (task.agent_type === 'local') {
      // Local model execution (future - for now, fall back to Claude)
      result = await this.executeWithClaude(step, task, ideaContext);
    } else {
      // Claude execution
      result = await this.executeWithClaude(step, task, ideaContext);
    }

    // Step 5: Store result and update status
    await step.do('store-result', async () => {
      const now = new Date().toISOString();
      const key = await getEncryptionKey(this.env.KV, tenant_id);

      // Encrypt result if present
      const encryptedResult = result.output
        ? await encryptField(JSON.stringify(result), key)
        : null;

      const newStatus = result.success ? 'completed' : 'failed';

      await this.env.DB.prepare(`
        UPDATE idea_tasks
        SET status = ?,
            result = ?,
            completed_at = CASE WHEN ? = 'completed' THEN ? ELSE NULL END,
            error_message = CASE WHEN ? = 'failed' THEN ? ELSE NULL END,
            updated_at = ?
        WHERE id = ?
      `).bind(
        newStatus,
        encryptedResult,
        newStatus,
        now,
        newStatus,
        result.success ? null : result.output,
        now,
        task_id
      ).run();

      // Update execution counts
      if (result.success) {
        await this.env.DB.prepare(`
          UPDATE idea_executions
          SET completed_tasks = completed_tasks + 1, updated_at = ?
          WHERE id = ?
        `).bind(now, execution_id).run();
      } else {
        await this.env.DB.prepare(`
          UPDATE idea_executions
          SET failed_tasks = failed_tasks + 1, updated_at = ?
          WHERE id = ?
        `).bind(now, execution_id).run();
      }
    });

    // Step 6: Check if all tasks are done
    await step.do('check-completion', async () => {
      const stats = await this.env.DB.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked,
          SUM(CASE WHEN status IN ('pending', 'ready', 'in_progress') THEN 1 ELSE 0 END) as remaining
        FROM idea_tasks
        WHERE idea_id = ? AND deleted_at IS NULL
      `).bind(idea_id).first<{
        total: number;
        completed: number;
        failed: number;
        blocked: number;
        remaining: number;
      }>();

      const now = new Date().toISOString();

      if (stats) {
        if (stats.remaining === 0) {
          // All tasks done
          const finalStatus = stats.blocked > 0 ? 'blocked' :
                             stats.failed > 0 ? 'completed' : // completed with failures
                             'completed';

          await this.env.DB.prepare(`
            UPDATE idea_executions
            SET status = ?, completed_at = ?, updated_at = ?
            WHERE id = ?
          `).bind(finalStatus, now, now, execution_id).run();

          const ideaStatus = stats.blocked > 0 ? 'blocked' : 'done';
          await this.env.DB.prepare(`
            UPDATE ideas
            SET execution_status = ?, updated_at = ?
            WHERE id = ?
          `).bind(ideaStatus, now, idea_id).run();
        }
      }
    });

    return {
      success: result.success,
      task_id,
      execution_id,
      output: result.output,
    };
  }

  private async executeWithClaude(
    step: WorkflowStep,
    task: IdeaTask,
    ideaContext: IdeaContext
  ): Promise<ExecutionResult> {
    return step.do(
      'execute-with-claude',
      {
        retries: {
          limit: 3,
          delay: '10 seconds',
          backoff: 'exponential',
        },
        timeout: '5 minutes',
      },
      async () => {
        const prompt = buildExecutionPrompt(task, ideaContext);

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4096,
            system: EXECUTION_SYSTEM_PROMPT,
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

        const text = data.content[0]?.text;
        if (!text) {
          throw new Error('No response from Claude');
        }

        return {
          success: true,
          output: text,
        };
      }
    );
  }
}

const EXECUTION_SYSTEM_PROMPT = `You are an AI assistant executing a specific task as part of a larger idea/project.

Your job is to:
1. Execute the task to the best of your ability
2. Provide a clear, actionable output
3. Note any follow-up actions or considerations

For research tasks: Provide summarized findings with key points.
For writing tasks: Provide the written content.
For analysis tasks: Provide structured analysis with conclusions.
For coding tasks: Provide code with explanations.

Be thorough but concise. Focus on delivering value.`;

function buildExecutionPrompt(task: IdeaTask, ideaContext: IdeaContext): string {
  let prompt = `## Context\n`;
  prompt += `You're working on the idea: "${ideaContext.title}"\n`;
  if (ideaContext.description) {
    prompt += `Idea description: ${ideaContext.description}\n`;
  }
  prompt += `\n## Your Task\n`;
  prompt += `**${task.title}**\n`;
  if (task.description) {
    prompt += `\n${task.description}\n`;
  }
  prompt += `\nEstimated effort: ${task.estimated_effort}\n`;
  prompt += `\nPlease execute this task and provide your output.`;
  return prompt;
}
