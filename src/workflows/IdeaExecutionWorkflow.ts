/**
 * IdeaExecutionWorkflow - Cloudflare Workflow for Idea Execution
 *
 * This workflow handles the durable execution of ideas through multiple steps:
 * 1. Generate plan via DE LLM
 * 2. Create tasks from plan
 * 3. Execute tasks (or queue for human review)
 * 4. Report completion
 *
 * Benefits over Durable Objects:
 * - Automatic retries with backoff
 * - Survives Worker restarts
 * - Built-in sleep/delay
 * - Observable via dashboard
 */

import {
  WorkflowEntrypoint,
  WorkflowStep,
} from 'cloudflare:workers';
import type { WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '../types/index.ts';
import { DEClient } from '../lib/de-client.ts';
import { getEncryptionKey, encryptField } from '../lib/encryption.ts';

// Workflow parameters
export interface IdeaExecutionParams {
  ideaId: string;
  tenantId: string;
  userId: string;
  ideaTitle: string;
  ideaDescription: string;
}

// Plan structure from LLM
interface ExecutionPlan {
  summary: string;
  approach: string;
  steps: Array<{
    order: number;
    description: string;
    type: 'research' | 'design' | 'implement' | 'test' | 'deploy' | 'document';
    estimatedMinutes: number;
  }>;
  estimatedEffort: 'xs' | 's' | 'm' | 'l' | 'xl';
  risks: string[];
  dependencies: string[];
}

// Generated task
interface GeneratedTask {
  id: string;
  title: string;
  description: string;
  type: string;
  estimatedMinutes: number;
  order: number;
}

// Workflow result
interface WorkflowResult {
  executionId: string;
  ideaId: string;
  status: 'completed' | 'failed' | 'blocked';
  plan: ExecutionPlan | null;
  tasksCreated: number;
  error?: string;
}

export class IdeaExecutionWorkflow extends WorkflowEntrypoint<Env, IdeaExecutionParams> {
  override async run(
    event: WorkflowEvent<IdeaExecutionParams>,
    step: WorkflowStep
  ): Promise<WorkflowResult> {
    const { ideaId, tenantId, userId, ideaTitle, ideaDescription } = event.payload;
    const executionId = crypto.randomUUID();

    // Step 1: Create execution record in database
    await step.do('create-execution-record', async () => {
      const now = new Date().toISOString();
      await this.env.DB.prepare(`
        INSERT INTO idea_executions (id, idea_id, tenant_id, user_id, status, phase, started_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(executionId, ideaId, tenantId, userId, 'in_progress', 'planning', now, now, now).run();

      return { executionId };
    });

    // Step 2: Generate plan via DE LLM (with retries)
    const plan = await step.do(
      'generate-plan',
      {
        retries: {
          limit: 3,
          delay: '10 seconds',
          backoff: 'exponential',
        },
        timeout: '5 minutes',
      },
      async () => {
        const deClient = new DEClient(this.env);

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

        const response = await deClient.chatCompletion({
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: `Create an execution plan for this idea:\n\nTitle: ${ideaTitle}\n\nDescription: ${ideaDescription || 'No additional description provided'}`,
            },
          ],
          max_tokens: 2000,
        });

        const text = response.content || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('Failed to parse plan from AI response');
        }

        return JSON.parse(jsonMatch[0]) as ExecutionPlan;
      }
    );

    // Step 3: Update execution with plan
    await step.do('save-plan', async () => {
      const now = new Date().toISOString();
      await this.env.DB.prepare(`
        UPDATE idea_executions
        SET plan = ?, phase = ?, updated_at = ?
        WHERE id = ?
      `).bind(JSON.stringify(plan), 'task_generation', now, executionId).run();
    });

    // Step 4: Create tasks from plan
    const tasks = await step.do('create-tasks', async () => {
      const encryptionKey = await getEncryptionKey(this.env.KV, tenantId);
      const createdTasks: GeneratedTask[] = [];
      const now = new Date().toISOString();

      for (const planStep of plan.steps) {
        const taskId = crypto.randomUUID();
        const taskTitle = `[${ideaTitle}] Step ${planStep.order}: ${planStep.description.slice(0, 50)}`;
        const taskDescription = `Part of idea execution: ${ideaTitle}\n\n${planStep.description}`;

        // Encrypt sensitive fields
        const encryptedTitle = await encryptField(taskTitle, encryptionKey);
        const encryptedDescription = await encryptField(taskDescription, encryptionKey);

        await this.env.DB.prepare(`
          INSERT INTO tasks (
            id, tenant_id, user_id, title, description, status, domain,
            urgency, importance, energy_required, time_estimate_minutes,
            source_type, source_reference, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          taskId,
          tenantId,
          userId,
          encryptedTitle,
          encryptedDescription,
          'inbox',
          'side_project',
          3, // urgency
          3, // importance
          'medium',
          planStep.estimatedMinutes,
          'idea_execution',
          `idea:${ideaId}:execution:${executionId}`,
          now,
          now
        ).run();

        createdTasks.push({
          id: taskId,
          title: taskTitle,
          description: taskDescription,
          type: planStep.type,
          estimatedMinutes: planStep.estimatedMinutes,
          order: planStep.order,
        });
      }

      return createdTasks;
    });

    // Step 5: Update execution status to completed
    await step.do('complete-execution', async () => {
      const now = new Date().toISOString();
      await this.env.DB.prepare(`
        UPDATE idea_executions
        SET status = ?, phase = ?, tasks_generated = ?, completed_at = ?, updated_at = ?
        WHERE id = ?
      `).bind(
        'completed',
        'done',
        JSON.stringify(tasks.map((t) => t.id)),
        now,
        now,
        executionId
      ).run();

      // Also update the idea to link to execution
      await this.env.DB.prepare(`
        UPDATE ideas SET updated_at = ? WHERE id = ?
      `).bind(now, ideaId).run();
    });

    // Step 6: Log decision
    await step.do('log-decision', async () => {
      const now = new Date().toISOString();
      await this.env.DB.prepare(`
        INSERT INTO decisions (id, tenant_id, user_id, entity_type, entity_id, decision, reasoning, context, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        tenantId,
        userId,
        'idea',
        ideaId,
        'executed',
        `Generated ${tasks.length} tasks from execution plan`,
        JSON.stringify({ executionId, planSummary: plan.summary }),
        now
      ).run();
    });

    return {
      executionId,
      ideaId,
      status: 'completed',
      plan,
      tasksCreated: tasks.length,
    };
  }
}
