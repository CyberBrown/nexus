/**
 * MCP Tool Definitions for Nexus
 *
 * These tools allow Claude.ai to interact with the Nexus execution loop.
 */

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
    }>;
    required?: string[];
  };
}

export const tools: MCPTool[] = [
  {
    name: 'nexus_create_idea',
    description: 'Create a new idea in Nexus for future planning and execution. Ideas are captured for later review and can be turned into execution plans.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short, descriptive title for the idea',
        },
        description: {
          type: 'string',
          description: 'Detailed description of the idea, including goals, context, and any relevant details',
        },
        category: {
          type: 'string',
          description: 'Category for the idea',
          enum: ['feature', 'improvement', 'bug', 'documentation', 'research', 'infrastructure', 'random'],
        },
        domain: {
          type: 'string',
          description: 'Domain area for the idea',
          enum: ['work', 'personal', 'side_project', 'family', 'health'],
        },
        excitement_level: {
          type: 'number',
          description: 'How excited are you about this idea? (1-5)',
        },
        feasibility: {
          type: 'number',
          description: 'How feasible is this idea? (1-5)',
        },
        potential_impact: {
          type: 'number',
          description: 'What is the potential impact? (1-5)',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'nexus_plan_idea',
    description: 'Trigger AI planning for an idea. This generates an execution plan with steps, effort estimates, risks, and dependencies. The plan can then be executed to create tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        idea_id: {
          type: 'string',
          description: 'The UUID of the idea to plan',
        },
      },
      required: ['idea_id'],
    },
  },
  {
    name: 'nexus_execute_idea',
    description: 'Execute a planned idea by creating tasks from the generated plan. Each step in the plan becomes a task that can be worked on.',
    inputSchema: {
      type: 'object',
      properties: {
        idea_id: {
          type: 'string',
          description: 'The UUID of the idea to execute (must have a plan)',
        },
      },
      required: ['idea_id'],
    },
  },
  {
    name: 'nexus_get_status',
    description: 'Get the current execution status for an idea, including plan details, task progress, and any blockers.',
    inputSchema: {
      type: 'object',
      properties: {
        idea_id: {
          type: 'string',
          description: 'The UUID of the idea to check',
        },
      },
      required: ['idea_id'],
    },
  },
  {
    name: 'nexus_list_ideas',
    description: 'List all ideas in the system with their execution status. Can filter by various criteria.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by execution status',
          enum: ['all', 'no_execution', 'planning', 'in_progress', 'completed', 'blocked'],
        },
        category: {
          type: 'string',
          description: 'Filter by idea category',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of ideas to return (default: 20)',
        },
      },
    },
  },
  {
    name: 'nexus_list_active',
    description: 'List all active executions currently in progress or blocked.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'nexus_list_blocked',
    description: 'List all executions that are currently blocked and need human input.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'nexus_resolve_blocker',
    description: 'Resolve a blocker on an execution by providing a resolution. This allows the execution to continue.',
    inputSchema: {
      type: 'object',
      properties: {
        idea_id: {
          type: 'string',
          description: 'The UUID of the idea with the blocker',
        },
        blocker_id: {
          type: 'string',
          description: 'The UUID of the specific blocker to resolve',
        },
        resolution: {
          type: 'string',
          description: 'How the blocker was resolved (decision made, info provided, etc.)',
        },
      },
      required: ['idea_id', 'blocker_id', 'resolution'],
    },
  },
  {
    name: 'nexus_cancel_execution',
    description: 'Cancel an in-progress execution with a reason.',
    inputSchema: {
      type: 'object',
      properties: {
        idea_id: {
          type: 'string',
          description: 'The UUID of the idea to cancel execution for',
        },
        reason: {
          type: 'string',
          description: 'Why the execution is being cancelled',
        },
      },
      required: ['idea_id'],
    },
  },
  {
    name: 'nexus_log_decision',
    description: 'Log a CEO decision for the decision log. This helps track reasoning and learn patterns over time.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: {
          type: 'string',
          description: 'Type of entity the decision is about',
          enum: ['idea', 'task', 'project', 'execution'],
        },
        entity_id: {
          type: 'string',
          description: 'UUID of the entity',
        },
        decision: {
          type: 'string',
          description: 'The decision made',
          enum: ['approved', 'rejected', 'deferred', 'modified', 'cancelled'],
        },
        reasoning: {
          type: 'string',
          description: 'Why this decision was made',
        },
      },
      required: ['entity_type', 'entity_id', 'decision'],
    },
  },
  {
    name: 'nexus_list_tasks',
    description: 'List tasks, optionally filtered by status or source.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by task status',
          enum: ['inbox', 'next', 'scheduled', 'waiting', 'someday', 'completed', 'cancelled'],
        },
        source_type: {
          type: 'string',
          description: 'Filter by source (e.g., "idea_execution" for auto-generated tasks)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of tasks to return (default: 50)',
        },
      },
    },
  },
  {
    name: 'nexus_capture',
    description: 'Capture raw input for AI classification. The input will be analyzed and potentially auto-promoted to a task, idea, or other entity.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The raw content to capture (voice transcription, note, etc.)',
        },
        source_type: {
          type: 'string',
          description: 'Source of the capture',
          enum: ['voice', 'email', 'webhook', 'manual', 'sms', 'claude'],
        },
      },
      required: ['content'],
    },
  },
];

export function getToolByName(name: string): MCPTool | undefined {
  return tools.find(t => t.name === name);
}

/**
 * MCP Prompts - These become slash commands in Claude Code
 * Usage: /mcp__nexus__<prompt_name> [args]
 */
export interface MCPPrompt {
  name: string;
  description: string;
  arguments?: Array<{
    name: string;
    description: string;
    required?: boolean;
  }>;
}

export const prompts: MCPPrompt[] = [
  {
    name: 'quick_capture',
    description: 'Quickly capture content to Nexus inbox for AI classification',
    arguments: [
      {
        name: 'content',
        description: 'The content to capture (will be AI-classified)',
        required: true,
      },
    ],
  },
  {
    name: 'new_idea',
    description: 'Create a new idea in Nexus',
    arguments: [
      {
        name: 'title',
        description: 'Title of the idea',
        required: true,
      },
      {
        name: 'description',
        description: 'Detailed description of the idea',
        required: false,
      },
      {
        name: 'category',
        description: 'Category: feature, improvement, bug, documentation, research, infrastructure, random',
        required: false,
      },
    ],
  },
  {
    name: 'check_status',
    description: 'Check Nexus status - active executions, blocked items, and recent ideas',
  },
  {
    name: 'plan_and_execute',
    description: 'Plan an idea and optionally execute it to create tasks',
    arguments: [
      {
        name: 'idea_id',
        description: 'UUID of the idea to plan',
        required: true,
      },
    ],
  },
  {
    name: 'daily_review',
    description: 'Do a daily review - see blocked items, in-progress work, inbox, and recent ideas',
  },
];
