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
  // Code execution fields
  repo: string | null;
  branch: string | null;
  commit_message: string | null;
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
  commit?: {
    sha: string;
    url: string;
    branch: string;
  };
}

// Sandbox executor response
interface SandboxExecutorResponse {
  success: boolean;
  execution_id: string;
  result?: {
    output: string;
    files?: Array<{ path: string; content: string; type?: string }>;
    metadata?: { tokens_used?: number; execution_time_ms?: number };
  };
  commit?: {
    success: boolean;
    sha?: string;
    url?: string;
    branch?: string;
    error?: string;
  };
  error?: string;
  error_code?: string;
}

// Code task detection patterns
const CODE_TASK_PATTERNS = [
  /^\[implement\]/i,
  /^\[deploy\]/i,
  /^\[fix\]/i,
  /^\[refactor\]/i,
  /^\[test\]/i,
  /^\[debug\]/i,
  /^\[code\]/i,
  /^\[CC\]/i,
];

export class TaskExecutorWorkflow extends WorkflowEntrypoint<Env, TaskExecutorParams> {
  override async run(event: WorkflowEvent<TaskExecutorParams>, step: WorkflowStep) {
    const { task_id, tenant_id, user_id, idea_id, execution_id } = event.payload;

    // Step 1: Load task from D1
    const task = await step.do('load-task', async () => {
      const row = await this.env.DB.prepare(`
        SELECT id, idea_id, title, description, agent_type, estimated_effort, status,
               retry_count, max_retries, repo, branch, commit_message
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

    // Step 4: Determine if this is a code task
    const isCodeTask = this.isCodeTask(task);

    // Step 5: Execute based on task type
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
    } else if (isCodeTask) {
      // Code task - route to sandbox-executor
      result = await this.executeWithSandbox(step, task, ideaContext);
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
        // Workflows can't use service bindings - must use TEXT_GEN_URL
        const textGenUrl = this.env.TEXT_GEN_URL;
        if (!textGenUrl) {
          throw new Error('TEXT_GEN_URL not configured. Set TEXT_GEN_URL in wrangler.toml [vars]');
        }

        const userPrompt = buildExecutionPrompt(task, ideaContext);
        const prompt = `System: ${EXECUTION_SYSTEM_PROMPT}\n\nUser: ${userPrompt}\n\nAssistant:`;

        const response = await fetch(`${textGenUrl}/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt,
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4096,
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

        return {
          success: true,
          output: data.text,
        };
      }
    );
  }

  /**
   * Execute a code task via sandbox-executor
   */
  private async executeWithSandbox(
    step: WorkflowStep,
    task: IdeaTask,
    ideaContext: IdeaContext
  ): Promise<ExecutionResult> {
    return step.do(
      'execute-with-sandbox',
      {
        retries: {
          limit: 2,
          delay: '30 seconds',
          backoff: 'exponential',
        },
        timeout: '10 minutes', // Code tasks can take longer
      },
      async () => {
        const sandboxUrl = this.env.SANDBOX_EXECUTOR_URL;
        if (!sandboxUrl) {
          throw new Error('SANDBOX_EXECUTOR_URL not configured. Set SANDBOX_EXECUTOR_URL in wrangler.toml [vars]');
        }

        // Parse repo/branch from task fields or description
        const repoInfo = this.extractRepoInfo(task);

        // Build the task prompt
        const taskPrompt = buildCodeTaskPrompt(task, ideaContext);

        const requestBody: Record<string, unknown> = {
          task: taskPrompt,
          context: `Idea: ${ideaContext.title}\n${ideaContext.description || ''}`,
          options: {
            max_tokens: 8192,
            temperature: 0.3,
          },
        };

        // Add repo info if available
        if (repoInfo.repo) {
          requestBody.repo = repoInfo.repo;
          requestBody.branch = repoInfo.branch || 'main';
          if (task.commit_message) {
            requestBody.commitMessage = task.commit_message;
          } else {
            requestBody.commitMessage = `${task.title.slice(0, 50)}`;
          }
        }

        console.log(`Calling sandbox-executor with repo: ${repoInfo.repo}, branch: ${repoInfo.branch}`);

        const response = await fetch(`${sandboxUrl}/execute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Sandbox executor error: ${response.status} - ${error}`);
        }

        const data = await response.json() as SandboxExecutorResponse;

        if (!data.success) {
          throw new Error(data.error || 'Sandbox executor returned failure');
        }

        // Build output summary
        let output = data.result?.output || 'Task completed';
        if (data.result?.files && data.result.files.length > 0) {
          output += `\n\nGenerated ${data.result.files.length} file(s):\n`;
          output += data.result.files.map(f => `- ${f.path}`).join('\n');
        }
        if (data.commit?.success && data.commit.sha) {
          output += `\n\nCommitted to ${data.commit.branch}: ${data.commit.sha}`;
          output += `\nURL: ${data.commit.url}`;
        }

        return {
          success: true,
          output,
          commit: data.commit?.success ? {
            sha: data.commit.sha!,
            url: data.commit.url!,
            branch: data.commit.branch!,
          } : undefined,
        };
      }
    );
  }

  /**
   * Check if a task is a code task based on title patterns or repo field
   */
  private isCodeTask(task: IdeaTask): boolean {
    // If repo field is set, it's definitely a code task
    if (task.repo) {
      return true;
    }

    // Check title patterns
    for (const pattern of CODE_TASK_PATTERNS) {
      if (pattern.test(task.title)) {
        return true;
      }
    }

    // Check description for repo info
    if (task.description) {
      const repoPattern = /(?:repo(?:sitory)?|github)[:\s]+([a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)/i;
      if (repoPattern.test(task.description)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Extract repo and branch info from task fields and description
   */
  private extractRepoInfo(task: IdeaTask): { repo: string | null; branch: string | null } {
    // First check explicit fields
    if (task.repo) {
      return {
        repo: task.repo,
        branch: task.branch || 'main',
      };
    }

    // Parse from description
    if (task.description) {
      // Pattern: repo: owner/repo or Repository: owner/repo
      const repoPattern = /(?:repo(?:sitory)?)[:\s]+([a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)/i;
      const repoMatch = task.description.match(repoPattern);

      // Pattern: branch: branch-name or Branch: branch-name
      const branchPattern = /(?:branch)[:\s]+([a-zA-Z0-9_\-\/]+)/i;
      const branchMatch = task.description.match(branchPattern);

      // Pattern: GitHub URL
      const githubUrlPattern = /github\.com\/([a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)/i;
      const githubMatch = task.description.match(githubUrlPattern);

      const repo = repoMatch?.[1] || githubMatch?.[1] || null;
      const branch = branchMatch?.[1] || null;

      return { repo, branch };
    }

    return { repo: null, branch: null };
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

function buildCodeTaskPrompt(task: IdeaTask, ideaContext: IdeaContext): string {
  // Strip the [implement], [fix], etc. prefix from title for cleaner prompts
  let cleanTitle = task.title;
  for (const pattern of CODE_TASK_PATTERNS) {
    cleanTitle = cleanTitle.replace(pattern, '').trim();
  }

  let prompt = `## Task: ${cleanTitle}\n\n`;

  if (task.description) {
    prompt += `## Description\n${task.description}\n\n`;
  }

  prompt += `## Context\n`;
  prompt += `This task is part of: "${ideaContext.title}"\n`;
  if (ideaContext.description) {
    prompt += `${ideaContext.description}\n`;
  }

  prompt += `\n## Instructions\n`;
  prompt += `Complete this coding task. Generate complete, production-ready code.\n`;
  prompt += `Use the existing codebase patterns and structure.\n`;
  prompt += `Include all necessary files with their full content.`;

  return prompt;
}
