# Task Review Loop Framework

## Overview

When a task is created or submitted, it must go through a review loop before execution. This is the "triage" phase that determines routing, priority, and feasibility.

The review loop ensures tasks are:
- Properly categorized for the right executor
- Well-defined enough to be actionable
- Prioritized against other work
- Scheduled appropriately

## Task Review Questions

These questions are evaluated when a task enters the system (via capture, manual creation, or plan decomposition).

### Routing Questions

| # | Question | Possible Values |
|---|----------|-----------------|
| 1 | Is this a task for CEO (human) to do? | Yes / No |
| 2 | Is this a task for Nexus (CPU/automated) to do? | Yes / No |
| 3 | Is this a task for CEO to assign to someone else? | Yes / No |
| 4 | Is this a task that Nexus will assign to an agent? | Yes / No |

**Routing Decision Matrix:**
- CEO-only: Requires human judgment, relationships, or physical presence
- Nexus-automated: Can be fully automated (code generation, research, analysis)
- CEO-delegated: Human work but not CEO specifically (contractors, team)
- Agent-assigned: AI agent work (Claude, specialized agents via DE)

### SMART Criteria

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
- Clarified (request more info)
- Rejected (not actionable)

### Complexity & Priority

| # | Question | Scale/Values |
|---|----------|--------------|
| 10 | How complex is this task? | 1-5 (1=trivial, 5=major project) |
| 11 | Priority relative to other tasks? | 1-5 or High/Medium/Low |
| 12 | Priority relative to strategic directions? | Aligns / Neutral / Conflicts |
| 13 | Does this task need specific scheduling? | Yes (calendar) / No (queue) |
| 14 | Does this task require additional humans? | Yes / No |

## Loop Hierarchy

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
- **Trigger**: Task with `type: code` or `type: document` marked ready
- **Process**:
  1. Analyze task requirements
  2. Execute code changes or documentation
  3. Run tests/validation
  4. Create PR or commit
  5. Report completion to parent
- **Status**: Tasks created but manual execution (TODO: auto-execute)

#### ResearchLoop (Child - Future)
- **Trigger**: Task with `type: research` marked ready
- **Process**: Web search, document analysis, synthesis, report generation

#### ContentLoop (Child - Future)
- **Trigger**: Task with `type: content` marked ready
- **Process**: Writing, editing, media creation

#### OutreachLoop (Child - Future)
- **Trigger**: Task with `type: outreach` marked ready
- **Process**: Email drafts, scheduling, follow-ups

## Trigger System

### Task States for Loop Triggering

```
inbox → review → ready → executing → completed
                  │         │
                  │         └→ blocked → (escalate)
                  │
                  └→ deferred (not now)
```

### Trigger Rules (TODO)

1. **Ready → Execute**: Tasks marked `status: ready` with appropriate routing trigger their child loop
2. **Autonomous Execution**: Child loops run without human intervention until complete or blocked
3. **Completion Callback**: On task completion, notify parent loop to continue
4. **Escalation Path**: On block, escalate through hierarchy:
   - Child loop → Parent loop (can it resolve?)
   - Parent loop → Nexus (internal resolution?)
   - Nexus → Bridge (human needed via UI)

### Escalation Triggers

- **Missing Information**: Can't proceed without clarification
- **Permission Required**: Needs approval for action
- **Resource Unavailable**: API limit, service down, etc.
- **Decision Point**: Multiple valid approaches, need human choice
- **Error/Failure**: Unexpected error requiring investigation

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| IdeaExecutionLoop | ✅ Implemented | Manual trigger via API |
| Task Review Questions | ⏳ Planned | Schema additions needed |
| CodeExecutionLoop | ⏳ Partial | Tasks created, execution manual |
| Auto-trigger System | ❌ Not started | Needs cron or event system |
| Escalation to Bridge | ❌ Not started | Bridge project not yet built |

## Database Schema Additions (TODO)

```sql
-- Add review fields to tasks
ALTER TABLE tasks ADD COLUMN routing TEXT; -- ceo, nexus, delegated, agent
ALTER TABLE tasks ADD COLUMN smart_score INTEGER; -- 0-5 (SMART criteria met)
ALTER TABLE tasks ADD COLUMN complexity INTEGER; -- 1-5
ALTER TABLE tasks ADD COLUMN strategic_alignment TEXT; -- aligns, neutral, conflicts
ALTER TABLE tasks ADD COLUMN requires_scheduling INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN requires_humans INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN loop_type TEXT; -- code, research, content, outreach
ALTER TABLE tasks ADD COLUMN parent_loop_id TEXT; -- execution that spawned this
```

## API Endpoints (TODO)

```
POST /api/tasks/:id/review     - Submit task through review loop
POST /api/tasks/:id/ready      - Mark task ready for execution
POST /api/tasks/:id/block      - Mark task blocked with reason
GET  /api/loops/active         - List all active execution loops
GET  /api/loops/:type/queue    - Get queue for specific loop type
```

## Next Steps

1. Add review question fields to task schema
2. Implement review evaluation (AI-assisted)
3. Build CodeExecutionLoop auto-trigger
4. Connect to Claude Code for code task execution
5. Build Bridge escalation path
