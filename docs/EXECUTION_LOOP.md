# Nexus Execution Loop Framework

## Overview

This document covers the complete pipeline from idea capture through task execution. Ideas and tasks flow through review loops that determine sizing, routing, and execution strategy.

```
Capture → Idea Triage → [Quick Win | Planning] → Task Review → Execution → Done
```

**Core Principle**: Not everything needs a plan. Quick wins should flow fast. Big ideas need decomposition.

## Part 1: Idea Triage

When an idea enters the system (via capture, MCP, voice, etc.), it goes through triage to determine the right path.

### Idea Classification Questions

| # | Question | Values | Purpose |
|---|----------|--------|---------|
| 1 | Is this actionable as-is? | Yes / No / Needs clarification | Can we act on this immediately? |
| 2 | What's the scope? | Quick-win / Small / Medium / Large / Epic | Size determines path |
| 3 | Can this be done in one session? | Yes / No | Single task vs multi-step |
| 4 | Does this need research first? | Yes / No | Research before planning |
| 5 | Who can execute this? | Me / Agent / Delegate / Team | Routing hint |
| 6 | Is there a deadline? | Date / ASAP / Someday / None | Urgency factor |
| 7 | Does this block other work? | Yes / No | Priority boost |

### Scope Definitions

| Scope | Time Estimate | Examples | Path |
|-------|---------------|----------|------|
| **Quick-win** | < 30 min | Fix typo, send email, quick config | Direct to task, skip planning |
| **Small** | 30 min - 2 hrs | Write function, update doc, simple feature | Direct to task or 1-step plan |
| **Medium** | 2 hrs - 1 day | New feature, refactor, integration | Needs planning (3-7 tasks) |
| **Large** | 1 day - 1 week | Major feature, new service, redesign | Full planning (7-15 tasks) |
| **Epic** | > 1 week | New product, architecture change | Break into multiple ideas first |

### Idea Triage Decision Tree

```
                        ┌─────────────────┐
                        │  New Idea       │
                        └────────┬────────┘
                                 │
                    ┌────────────▼────────────┐
                    │ Is it actionable as-is? │
                    └────────────┬────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │ No               │ Needs Research   │ Yes
              ▼                  ▼                  ▼
     ┌────────────────┐  ┌──────────────┐  ┌───────────────┐
     │ Park in Ideas  │  │ Create       │  │ What's the    │
     │ (needs more    │  │ Research     │  │ scope?        │
     │ thinking)      │  │ Task first   │  │               │
     └────────────────┘  └──────────────┘  └───────┬───────┘
                                                   │
                    ┌──────────────────────────────┼─────────┐
                    │ Quick-win/Small              │ Medium+ │
                    ▼                              ▼         │
           ┌────────────────┐            ┌─────────────────┐ │
           │ Create Task    │            │ Run Planning    │ │
           │ (skip planning)│            │ Workflow        │ │
           └────────────────┘            └─────────────────┘ │
                                                   │         │
                                                   │ Epic    │
                                                   ▼         │
                                          ┌────────────────┐ │
                                          │ Break into     │◄┘
                                          │ smaller ideas  │
                                          └────────────────┘
```

### Idea States

```
new → triaged → [quick_win | planning | parked | researching]
                     │           │
                     │           └→ planned → executing → done
                     │
                     └→ task_created → (task states)
```

## Part 2: Task Review

Tasks come from two sources:
1. **Direct creation**: Quick-wins and small ideas become tasks directly
2. **Plan decomposition**: Medium+ ideas get broken into tasks by AI planning

All tasks go through review before execution.

### Task Review Questions

#### Routing Questions

| # | Question | Possible Values |
|---|----------|-----------------|
| 1 | Is this a task for CEO (human) to do? | Yes / No |
| 2 | Is this a task for Nexus (CPU/automated) to do? | Yes / No |
| 3 | Is this a task for CEO to assign to someone else? | Yes / No |
| 4 | Is this a task that Nexus will assign to an agent? | Yes / No |

**Routing Decision Matrix:**
- **CEO-only**: Requires human judgment, relationships, or physical presence
- **Nexus-automated**: Can be fully automated (code generation, research, analysis)
- **CEO-delegated**: Human work but not CEO specifically (contractors, team)
- **Agent-assigned**: AI agent work (Claude, specialized agents via DE)

#### SMART Criteria

| # | Question | Evaluation |
|---|----------|------------|
| 5 | Is this task **Specific**? | Clear scope and deliverable |
| 6 | Is this task **Measurable**? | Has success criteria |
| 7 | Is this task **Achievable**? | Within capability/resources |
| 8 | Is this task **Relevant**? | Aligns with goals/priorities |
| 9 | Is this task **Time-bound**? | Has deadline or timeframe |

Tasks failing SMART criteria should be:
- Refined (make more specific)
- Decomposed (break into smaller tasks)
- Clarified (request more info from CEO)
- Rejected (not actionable)

#### Complexity & Priority

| # | Question | Scale/Values |
|---|----------|--------------|
| 10 | How complex is this task? | 1-5 (1=trivial, 5=major) |
| 11 | Priority relative to other tasks? | 1-5 or High/Medium/Low |
| 12 | Priority relative to strategic directions? | Aligns / Neutral / Conflicts |
| 13 | Does this task need specific scheduling? | Yes (calendar) / No (queue) |
| 14 | Does this task require additional humans? | Yes / No |

### Task States

```
inbox → review → ready → executing → completed
                  │         │
                  │         └→ blocked → (escalate)
                  │
                  └→ deferred (not now)
```

## Part 3: Execution Loops

Nexus operates through a hierarchy of execution loops, each specialized for different work types.

```
                    ┌─────────────────────────┐
                    │   IdeaExecutionLoop     │  ← Parent Loop
                    │   (Idea → Plan → Tasks) │
                    └───────────┬─────────────┘
                                │
            ┌───────────────────┼───────────────────┐
            │                   │                   │
            ▼                   ▼                   ▼
┌───────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ CodeExecutionLoop │ │  ResearchLoop   │ │  ContentLoop    │
│ (Code/Docs tasks) │ │ (Investigation) │ │ (Writing/Media) │
└───────────────────┘ └─────────────────┘ └─────────────────┘
            │
            ▼
    (Future child loops)
```

### Loop Definitions

#### IdeaExecutionLoop (Parent)
- **Trigger**: Idea marked for execution, or manual `/api/execution/ideas/:id/plan`
- **Process**:
  1. Generate execution plan via AI
  2. Decompose plan into tasks
  3. Route tasks to appropriate child loops
  4. Monitor child loop completion
  5. Aggregate results
- **Status**: Implemented (manual trigger, auto-plans, creates tasks)

#### CodeExecutionLoop (Child)
- **Trigger**: Task with `loop_type: code` marked ready
- **Process**:
  1. Analyze task requirements
  2. Execute code changes or documentation
  3. Run tests/validation
  4. Create PR or commit
  5. Report completion to parent
- **Status**: Tasks created but manual execution (TODO: auto-execute via Claude Code)

#### ResearchLoop (Child - Future)
- **Trigger**: Task with `loop_type: research` marked ready
- **Process**: Web search, document analysis, synthesis, report generation

#### ContentLoop (Child - Future)
- **Trigger**: Task with `loop_type: content` marked ready
- **Process**: Writing, editing, media creation

#### OutreachLoop (Child - Future)
- **Trigger**: Task with `loop_type: outreach` marked ready
- **Process**: Email drafts, scheduling, follow-ups

### Escalation System

When a loop gets blocked, it escalates through the hierarchy:

```
Child Loop → Parent Loop → Nexus → Bridge (Human)
```

**Escalation Triggers:**
- **Missing Information**: Can't proceed without clarification
- **Permission Required**: Needs approval for action
- **Resource Unavailable**: API limit, service down, etc.
- **Decision Point**: Multiple valid approaches, need human choice
- **Error/Failure**: Unexpected error requiring investigation

## Part 4: Quick Win Fast Path

Quick wins bypass the full loop for speed. This is the "just do it" path.

### Quick Win Criteria (ALL must be true)
- Scope is "quick-win" (< 30 min)
- Actionable as-is (no research needed)
- Single executor (no coordination)
- No blockers or dependencies
- Clear success criteria

### Quick Win Flow

```
Idea (quick-win) → Create Task → Auto-mark Ready → Execute → Done
```

No planning phase. No complex review. Just triage → do → done.

### Examples of Quick Wins
- "Fix the typo in README.md"
- "Update the API key in .env"
- "Reply to John's email about the meeting"
- "Add a comment explaining this function"
- "Run the test suite and report results"

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| Idea Triage Questions | ⏳ Planned | Need schema + MCP tool |
| Quick Win Fast Path | ⏳ Planned | Skip planning for small items |
| IdeaExecutionLoop | ✅ Implemented | Manual trigger via API |
| Task Review Questions | ⏳ Planned | Schema additions needed |
| CodeExecutionLoop | ✅ Implemented | Via DE Workflows with HTTP triggers |
| Auto-trigger System | ✅ Implemented | Cron (15 min) + manual dispatch via MCP |
| Escalation to Bridge | ❌ Not started | Bridge project not yet built |

## DE Integration - Event-Driven Execution

### Architecture (Implemented)

Nexus dispatches tasks to the execution queue, then triggers DE Workflows via HTTP.
DE Workflows execute autonomously and report back to Nexus via callback endpoints.

**Key insight**: Cloudflare Workflows cannot be triggered cross-worker via bindings,
so we use HTTP triggers instead. This decouples the services while maintaining reliability.

### Current Architecture

```
Nexus (Brain/Orchestrator)
    ↓ dispatches task to queue
    ↓ calls POST /workflow/execute
DE Workflows Worker
    ↓ triggers CodeExecutionWorkflow
    ↓ sandbox-executor runs Claude Code
    ↓ calls POST /api/workflow/callback
Nexus receives result, updates task status
```

### Implemented Components

1. **Nexus Side**
   - `nexus_dispatch_task` / `nexus_dispatch_ready` - Queue tasks for execution
   - `nexus_execute_task` - Trigger DE workflow execution immediately
   - `POST /api/workflow/callback` - Receive execution results from DE
   - Auto-dispatch on task completion (chains ready tasks)

2. **DE Workflows Side**
   - `POST /workflow/execute` - HTTP trigger for CodeExecutionWorkflow
   - `CodeExecutionWorkflow` - Durable workflow with retry/timeout handling
   - Calls sandbox-executor with task context
   - Reports back to Nexus callback URL on completion

3. **Execution Flow**
   ```
   Task created with status="next"
           ↓
   Cron (15 min) OR manual: nexus_dispatch_task
           ↓
   Queue entry created with executor type
           ↓
   nexus_execute_task triggers DE workflow
           ↓
   CodeExecutionWorkflow runs in sandbox-executor
           ↓
   Callback to Nexus with result
           ↓
   Task marked complete, auto-dispatch checks for next tasks
   ```

### MCP Tools for Execution

```typescript
// Dispatch single task immediately
nexus_dispatch_task({ task_id: '...', passphrase: '...' })

// Dispatch all ready tasks
nexus_dispatch_ready({ executor_type: 'claude-code', passphrase: '...' })

// Execute queued task via DE workflow
nexus_execute_task({ queue_id: '...', passphrase: '...' })

// Run batch executor (processes multiple queued tasks)
nexus_run_executor({ executor_type: 'claude-code', limit: 10, passphrase: '...' })
```

### Remaining Work

Core execution loop is functional. Remaining enhancements:

1. ✅ ~~Build container execution service in DE~~ - sandbox-executor implemented
2. ✅ ~~Add Nexus → DE execution API call~~ - nexus_execute_task implemented
3. ✅ ~~Add callback handler in Nexus for results~~ - /api/workflow/callback implemented
4. ✅ ~~Wire up queue → DE dispatch~~ - nexus_run_executor implemented
5. ⏳ Add streaming status updates (nice-to-have)
6. ⏳ Improve error handling and retry logic
7. ⏳ Add execution metrics and monitoring

See: https://github.com/CyberBrown/distributed-electrons

## Database Schema Additions

### Ideas Table Additions
```sql
-- Triage fields
ALTER TABLE ideas ADD COLUMN scope TEXT; -- quick_win, small, medium, large, epic
ALTER TABLE ideas ADD COLUMN is_actionable INTEGER DEFAULT 1; -- 0/1
ALTER TABLE ideas ADD COLUMN needs_research INTEGER DEFAULT 0; -- 0/1
ALTER TABLE ideas ADD COLUMN suggested_executor TEXT; -- ceo, agent, delegate
ALTER TABLE ideas ADD COLUMN has_deadline INTEGER DEFAULT 0;
ALTER TABLE ideas ADD COLUMN deadline_date TEXT;
ALTER TABLE ideas ADD COLUMN blocks_other_work INTEGER DEFAULT 0;
ALTER TABLE ideas ADD COLUMN triage_status TEXT DEFAULT 'pending'; -- pending, triaged, skipped
ALTER TABLE ideas ADD COLUMN triage_notes TEXT;
```

### Tasks Table Additions
```sql
-- Review fields
ALTER TABLE tasks ADD COLUMN routing TEXT; -- ceo, nexus, delegated, agent
ALTER TABLE tasks ADD COLUMN smart_score INTEGER; -- 0-5 (SMART criteria met)
ALTER TABLE tasks ADD COLUMN complexity INTEGER; -- 1-5
ALTER TABLE tasks ADD COLUMN strategic_alignment TEXT; -- aligns, neutral, conflicts
ALTER TABLE tasks ADD COLUMN requires_scheduling INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN requires_humans INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN loop_type TEXT; -- code, research, content, outreach
ALTER TABLE tasks ADD COLUMN parent_loop_id TEXT; -- execution that spawned this
ALTER TABLE tasks ADD COLUMN is_quick_win INTEGER DEFAULT 0; -- fast path flag
```

## API Endpoints

### Idea Triage
```
POST /api/ideas/:id/triage      - Submit idea through triage
POST /api/ideas/:id/quick-win   - Fast-path: create task directly
POST /api/ideas/:id/plan        - Trigger planning workflow
```

### Task Review
```
POST /api/tasks/:id/review      - Submit task through review loop
POST /api/tasks/:id/ready       - Mark task ready for execution
POST /api/tasks/:id/block       - Mark task blocked with reason
```

### Loop Management
```
GET  /api/loops/active          - List all active execution loops
GET  /api/loops/:type/queue     - Get queue for specific loop type
POST /api/loops/:id/escalate    - Manually escalate to next level
```

## MCP Tools (TODO)

```
nexus_triage_idea     - Run triage questions on an idea
nexus_quick_win       - Fast-path idea to task (skip planning)
nexus_review_task     - Run review questions on a task
nexus_escalate        - Escalate a blocked item
```

## Next Steps

1. Add triage fields to ideas schema
2. Implement `nexus_triage_idea` MCP tool
3. Add quick-win fast path
4. Add review fields to tasks schema
5. Implement review evaluation (AI-assisted)
6. Build CodeExecutionLoop auto-trigger
7. Connect to Claude Code for code task execution
8. Build Bridge escalation path
