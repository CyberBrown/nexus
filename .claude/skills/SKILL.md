# Nexus MCP Integration Skill

This skill teaches Claude how to interact with the Nexus task and idea management system via its MCP server.

## When to Use This Skill

Use this skill when the user:
- Wants to capture ideas, tasks, or notes
- Asks about what's in progress or blocked
- Wants to plan or execute an idea
- Asks for a daily/weekly review of their work
- References "Nexus", "my ideas", "my tasks", or "execution pipeline"

## MCP Server Connection

The Nexus MCP server is available at:
- **URL**: `https://nexus.solamp.workers.dev/api/mcp`
- **Authentication**: Cloudflare Access service token (CF-Access-Client-Id, CF-Access-Client-Secret headers)

## Available Tools

### Idea Management
- `nexus_create_idea` - Create a new idea with title, description, category, domain, and scoring
- `nexus_list_ideas` - List ideas filtered by status, category, limit
- `nexus_plan_idea` - Generate AI execution plan for an idea (requires idea_id)
- `nexus_execute_idea` - Create tasks from a planned idea (requires idea_id)
- `nexus_get_status` - Get detailed status for an idea including plan and tasks

### Execution Management
- `nexus_list_active` - List all active/in-progress executions
- `nexus_list_blocked` - List executions blocked waiting for human input
- `nexus_resolve_blocker` - Resolve a blocker with a decision/resolution
- `nexus_cancel_execution` - Cancel an execution with reason

### Task Management
- `nexus_list_tasks` - List tasks filtered by status, source_type, limit
- `nexus_capture` - Capture raw content for AI classification (auto-promotes to task/idea)

### Decision Logging
- `nexus_log_decision` - Log a CEO decision for future reference

## Available Prompts (Slash Commands)

When connected as MCP server, these become `/mcp__nexus__<name>`:

- `/mcp__nexus__quick_capture <content>` - Fast capture to inbox
- `/mcp__nexus__new_idea <title>` - Create new idea
- `/mcp__nexus__check_status` - See what needs attention
- `/mcp__nexus__plan_and_execute <idea_id>` - Plan and execute an idea
- `/mcp__nexus__daily_review` - Full daily review

## Typical Workflows

### Capture Something
```
User: "I should add dark mode to the app"
Action: Use nexus_capture or nexus_create_idea based on clarity
```

### Check What's Happening
```
User: "What's going on with my ideas?"
Action: Use nexus_list_active, nexus_list_blocked, nexus_list_ideas
```

### Plan and Execute
```
User: "Plan out the auth refactor idea"
Action:
1. nexus_list_ideas to find it
2. nexus_plan_idea to generate plan
3. Show plan and ask for approval
4. nexus_execute_idea to create tasks
```

### Daily Review
```
User: "What should I focus on today?"
Action: Use nexus_list_blocked, nexus_list_active, nexus_list_tasks (inbox)
```

## Categories

Ideas use these categories:
- `feature` - New functionality
- `improvement` - Enhancement to existing
- `bug` - Fix something broken
- `documentation` - Docs and guides
- `research` - Investigation/exploration
- `infrastructure` - DevOps, tooling, setup
- `random` - Miscellaneous

## Domains

Ideas can be tagged with domains:
- `work` - Professional/job related
- `personal` - Personal projects
- `side_project` - Side hustles
- `family` - Family related
- `health` - Health/fitness

## Response Style

When interacting with Nexus:
1. Be concise - summarize results, don't dump raw JSON
2. Highlight what needs attention (blocked items, decisions needed)
3. Suggest next actions when appropriate
4. Use emoji sparingly for status indicators if user prefers
