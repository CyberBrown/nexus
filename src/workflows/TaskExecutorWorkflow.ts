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
  agent_type: 'ai' | 'human' | 'human-ai';
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

// Failure indicators in AI responses that indicate the task wasn't actually completed
// These phrases suggest the AI couldn't accomplish the task even if it responded successfully
// IMPORTANT: Keep this in sync with nexus-callback.ts and /workflow-callback handler in index.ts
const FAILURE_INDICATORS = [
  // Resource not found patterns
  "couldn't find",
  "could not find",
  "can't find",
  "cannot find",
  "doesn't have",
  "does not have",
  "not found",
  "no such file",
  "doesn't exist",
  "does not exist",
  "file not found",
  "directory not found",
  "repo not found",
  "repository not found",
  "project not found",
  "reference not found",
  "idea not found",
  // Failure action patterns
  "failed to",
  "unable to",
  "i can't",
  "i cannot",
  "i'm unable",
  "i am unable",
  "cannot locate",
  "couldn't locate",
  "couldn't create",
  "could not create",
  "wasn't able",
  "was not able",
  // Empty/missing result patterns
  "no matching",
  "nothing found",
  "no results",
  "empty result",
  "no data",
  // Explicit error indicators
  "error:",
  "error occurred",
  "exception:",
  // Access/permission patterns
  "missing",
  "not available",
  "no access",
  "permission denied",
  "i don't have access",
  "i cannot access",
  "isn't available",
  "is not available",
  // Task incomplete patterns
  "task incomplete",
  "could not complete",
  "couldn't complete",
  "unable to complete",
  "did not complete",
  "didn't complete",
  // Missing reference patterns (for idea-based tasks)
  "reference doesn't have",
  "reference does not have",
  "doesn't have a corresponding",
  "does not have a corresponding",
  "no corresponding file",
  "no corresponding project",
  "missing reference",
  "invalid reference",
];

/**
 * Check if an AI response contains failure indicators
 * Returns true if the response suggests the task wasn't actually completed
 */
function containsFailureIndicators(text: string): boolean {
  const lowerText = text.toLowerCase();
  return FAILURE_INDICATORS.some(indicator => lowerText.includes(indicator));
}

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
    } else {
      // AI execution via DE text-gen
      result = await this.executeWithClaude(step, task, ideaContext);
    }

    // Step 5: Store result and update status
    await step.do('store-result', async () => {
      const now = new Date().toISOString();
      const key = await getEncryptionKey(this.env.KV, tenant_id);

      // Check if this is a dispatched async workflow (INTAKE code tasks)
      // These should be marked as 'dispatched', not 'completed' or 'failed'
      // The callback from DE will update the final status
      const isDispatched = result.output?.startsWith('DISPATCHED:');

      // Determine status: dispatched tasks stay in 'dispatched' state until callback
      // IMPORTANT: Even if result.success is true, we MUST validate the output doesn't contain
      // failure indicators. This is a secondary check to catch edge cases where the AI "succeeds"
      // but actually reports it couldn't complete the task. This matches the validation in the
      // /workflow-callback handler in index.ts (lines 1674-1687).
      let newStatus: string;
      if (isDispatched) {
        newStatus = 'dispatched';
      } else if (result.success) {
        // Secondary validation: check if "successful" output actually contains failure indicators
        // This catches cases where executeWithClaude returned success but the content indicates failure
        const hasFailureIndicators = result.output ? containsFailureIndicators(result.output) : false;
        if (hasFailureIndicators) {
          console.log(`Task ${task_id} marked success but output contains failure indicators - marking as failed`);
          newStatus = 'failed';
          result.success = false; // Update result object to reflect actual failure
        } else {
          newStatus = 'completed';
        }
      } else {
        newStatus = 'failed';
      }

      // Encrypt result AFTER status validation (so result.success reflects actual outcome)
      const encryptedResult = result.output
        ? await encryptField(JSON.stringify(result), key)
        : null;

      await this.env.DB.prepare(`
        UPDATE idea_tasks
        SET status = ?,
            result = ?,
            completed_at = CASE WHEN ? = 'completed' THEN ? ELSE NULL END,
            error_message = CASE WHEN ? = 'failed' AND ? NOT LIKE 'DISPATCHED:%' THEN ? ELSE NULL END,
            updated_at = ?
        WHERE id = ?
      `).bind(
        newStatus,
        encryptedResult,
        newStatus,
        now,
        newStatus,
        result.output || '',
        result.success ? null : result.output,
        now,
        task_id
      ).run();

      // Update execution counts - only for final states (not dispatched)
      if (result.success && !isDispatched) {
        await this.env.DB.prepare(`
          UPDATE idea_executions
          SET completed_tasks = completed_tasks + 1, updated_at = ?
          WHERE id = ?
        `).bind(now, execution_id).run();
      } else if (!result.success && !isDispatched) {
        await this.env.DB.prepare(`
          UPDATE idea_executions
          SET failed_tasks = failed_tasks + 1, updated_at = ?
          WHERE id = ?
        `).bind(now, execution_id).run();
      }
      // Note: dispatched tasks will have their counts updated by the workflow callback
    });

    // Step 6: Check if all tasks are done
    await step.do('check-completion', async () => {
      const stats = await this.env.DB.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked,
          SUM(CASE WHEN status = 'dispatched' THEN 1 ELSE 0 END) as dispatched,
          SUM(CASE WHEN status IN ('pending', 'ready', 'in_progress') THEN 1 ELSE 0 END) as remaining
        FROM idea_tasks
        WHERE idea_id = ? AND deleted_at IS NULL
      `).bind(idea_id).first<{
        total: number;
        completed: number;
        failed: number;
        blocked: number;
        dispatched: number;
        remaining: number;
      }>();

      const now = new Date().toISOString();

      if (stats) {
        // Include dispatched tasks as "still in progress" - they haven't finished yet
        const stillPending = stats.remaining + stats.dispatched;

        if (stillPending === 0) {
          // All tasks done (no pending or dispatched tasks remaining)
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
        } else if (stats.dispatched > 0) {
          // Some tasks are dispatched (running async) - mark execution as 'executing'
          await this.env.DB.prepare(`
            UPDATE idea_executions
            SET status = 'executing', updated_at = ?
            WHERE id = ? AND status != 'executing'
          `).bind(now, execution_id).run();
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

        // Check if the AI response contains failure indicators
        // This catches cases where the AI "succeeds" but says "I couldn't find..." or similar
        if (containsFailureIndicators(data.text)) {
          console.log(`Task execution response contains failure indicators: ${data.text.substring(0, 200)}`);
          return {
            success: false,
            output: data.text,
          };
        }

        return {
          success: true,
          output: data.text,
        };
      }
    );
  }

  /**
   * Execute a code task via INTAKE (routes to PrimeWorkflow → CodeExecutionWorkflow → sandbox-executor)
   * Workflows can't use service bindings, so we use INTAKE_URL for HTTP access.
   */
  private async executeWithSandbox(
    step: WorkflowStep,
    task: IdeaTask,
    ideaContext: IdeaContext
  ): Promise<ExecutionResult> {
    return step.do(
      'execute-with-intake',
      {
        retries: {
          limit: 2,
          delay: '30 seconds',
          backoff: 'exponential',
        },
        timeout: '10 minutes', // Code tasks can take longer
      },
      async () => {
        const intakeUrl = this.env.INTAKE_URL;
        if (!intakeUrl) {
          throw new Error('INTAKE_URL not configured. Set INTAKE_URL in wrangler.toml [vars]');
        }

        // Parse repo/branch from task fields or description
        const repoInfo = this.extractRepoInfo(task);

        // Build the task prompt
        const taskPrompt = buildCodeTaskPrompt(task, ideaContext);

        // INTAKE request format
        const intakeRequest = {
          query: `Execute code task: ${task.title}`,
          task_type: 'code',
          task_id: task.id,
          prompt: taskPrompt,
          repo_url: repoInfo.repo ? `https://github.com/${repoInfo.repo}` : undefined,
          callback_url: `${this.env.NEXUS_URL || 'https://nexus-mcp.solamp.workers.dev'}/workflow-callback`,
          timeout_ms: 600000, // 10 minutes
          metadata: {
            idea_id: task.idea_id,
            idea_title: ideaContext.title,
            branch: repoInfo.branch || 'main',
            commit_message: task.commit_message || task.title.slice(0, 50),
          },
        };

        console.log(`Calling INTAKE for code task: ${task.id}, repo: ${repoInfo.repo}`);

        const response = await fetch(`${intakeUrl}/intake`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(intakeRequest),
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`INTAKE error: ${response.status} - ${error}`);
        }

        const data = await response.json() as {
          success: boolean;
          request_id?: string;
          workflow_instance_id?: string;
          error?: string;
        };

        if (!data.success) {
          throw new Error(data.error || 'INTAKE returned failure');
        }

        // INTAKE triggers async workflow - mark as 'dispatched' (not completed)
        // The workflow callback will update the final status when execution completes
        // IMPORTANT: Return success=false with a special status to prevent premature completion
        return {
          success: false, // Not yet complete - workflow is async
          output: `DISPATCHED:${data.workflow_instance_id || data.request_id}`, // Special marker for dispatched state
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
