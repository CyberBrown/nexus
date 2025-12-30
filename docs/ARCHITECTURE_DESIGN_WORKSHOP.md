# Architecture Design Workshop
## AI Integration Strategy, Data Flow, and Search Routing

**Date:** 2025-12-29
**Reference:** e99b8670-5074-4c9a-93fe-60dd263fc807
**Idea ID:** 1c8fb1ed-d4da-42ff-8376-443179d680af

---

## Table of Contents

1. [Current Architecture Overview](#1-current-architecture-overview)
2. [Identified Gaps & Issues](#2-identified-gaps--issues)
3. [Search Routing Logic](#3-search-routing-logic)
4. [Data Flow Patterns](#4-data-flow-patterns)
5. [Integration Strategy](#5-integration-strategy)
6. [Implementation Recommendations](#6-implementation-recommendations)
7. [Architecture Decision Records](#7-architecture-decision-records)

---

## 1. Current Architecture Overview

### Service Ecosystem

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            USER INTERFACES                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ Claude Code  │  │ Claude.ai    │  │ Voice (future)│  │ Web Dashboard│     │
│  │   (MCP)      │  │   (MCP)      │  │   (Bridge)   │  │   (Qwik)     │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
└─────────┼─────────────────┼─────────────────┼─────────────────┼─────────────┘
          │                 │                 │                 │
          ▼                 ▼                 ▼                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            NEXUS (The Brain)                                 │
│                     nexus-mcp.solamp.workers.dev                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ Tier 1      │  │ Memory      │  │ Task        │  │ MCP         │         │
│  │ Processing  │  │ Management  │  │ Orchestrat. │  │ Server      │         │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘         │
│                                                                              │
│  Durable Objects: InboxManager, CaptureBuffer, SyncManager,                 │
│                   UserSession, IdeaExecutor                                  │
│                                                                              │
│  Workflows: IdeaExecutionWorkflow, IdeaToPlanWorkflow,                      │
│             TaskExecutorWorkflow, IdeaPlanningWorkflow                       │
└────────────┬────────────────────────────────────────────────────────────────┘
             │
             │ Service Bindings / HTTP
             │
┌────────────┼────────────────────────────────────────────────────────────────┐
│            ▼                                                                 │
│  ┌─────────────────────┐    ┌─────────────────────┐   ┌──────────────────┐  │
│  │  DE Text-Gen        │    │  DE Workflows       │   │ Sandbox Executor │  │
│  │  (LLM Routing)      │    │  (Durable Exec)     │   │ (Claude Code)    │  │
│  │                     │    │                     │   │                  │  │
│  │  - Chat completion  │    │  - CodeExecution    │   │  - Git ops       │  │
│  │  - Text generation  │    │  - PrimeWorkflow    │   │  - Code changes  │  │
│  │  - Provider routing │    │  - Task execution   │   │  - Test running  │  │
│  └─────────────────────┘    └─────────────────────┘   └──────────────────┘  │
│                                                                              │
│                     DE (Distributed Electrons)                               │
│                       Arms & Legs Layer                                      │
└─────────────────────────────────────────────────────────────────────────────┘
             │
             │ (Future)
             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            MNEMO (Working Memory)                            │
│                         Context Caching Layer                                │
│  - Entity cache                                                              │
│  - Session context                                                           │
│  - HOT/WARM/COLD tiers                                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Current Service Bindings (wrangler.toml)

| Binding | Service | Purpose |
|---------|---------|---------|
| `DE` | `de-text-gen` | LLM chat/text generation |
| `SANDBOX_EXECUTOR` | `sandbox-executor` | Claude Code task execution |
| `INTAKE` | `intake` | Workflow-based durable execution |

### Current HTTP Endpoints

| URL | Service | Purpose |
|-----|---------|---------|
| `https://nexus-mcp.solamp.workers.dev` | Nexus | Brain/orchestration |
| `https://de-text-gen.solamp.workers.dev` | DE Text-Gen | LLM operations |
| `https://de-workflows.solamp.workers.dev` | DE Workflows | Durable execution |
| `https://sandbox-executor.solamp.workers.dev` | Sandbox | Code execution |

---

## 2. Identified Gaps & Issues

### 2.1 Routing Bypass Problem (CRITICAL)

**Status:** CONFIRMED BYPASS (per ROUTING_BYPASS_REPORT.md)

**Issue:** Nexus bypasses PrimeWorkflow in two locations, calling `/workflows/code-execution` directly instead of the unified `/execute` endpoint.

**Bypass Locations:**
1. `src/scheduled/task-executor.ts:657` - `executeCodeTaskViaWorkflow()`
2. `src/mcp/index.ts:376-378` - `nexus_create_task` with `auto_dispatch=true`

**Expected Pattern:**
```
Nexus → POST de-workflows/execute → PrimeWorkflow → routes to correct sub-workflow
```

**Current (Wrong) Pattern:**
```
Nexus → POST de-workflows/workflows/code-execution → (PrimeWorkflow SKIPPED)
```

### 2.2 Missing Search Infrastructure

**Gap:** No unified search routing system exists across the ecosystem.

**Current State:**
- No dedicated search service
- No semantic search/embeddings pipeline
- No cross-entity search capability
- D1 provides only basic SQL LIKE queries

**Needed Capabilities:**
- Full-text search across tasks, ideas, notes, projects
- Semantic search for context retrieval
- Memory/context search for Mnemo integration
- Search result ranking and relevance scoring

### 2.3 Mnemo Integration Not Implemented

**Gap:** Mnemo (working memory) is documented but not integrated.

**Needed:**
- HOT/WARM/COLD context tier management
- Entity detection → context pre-loading
- Session-aware caching
- Cross-session knowledge persistence

### 2.4 Inconsistent Executor Routing

**Issue:** Multiple naming conventions for executors exist.

**Current (Messy):**
- `claude-code`, `claude-ai`, `de-agent`, `human`, `human-ai`
- Legacy tags: `[CC]`, `[DE]`
- Task title prefix parsing

**Recommended (Clean):**
- `ai` - All AI execution (DE figures out how)
- `human` - Human only
- `human-ai` - Human with AI assist

### 2.5 Missing Task Type Classification

**Gap:** No formal task type taxonomy for routing decisions.

**Current:** Ad-hoc title prefix matching `[implement]`, `[research]`, etc.

**Needed:** Formal `task_type` field with defined values:
- `code` - Code generation/modification
- `research` - Information gathering
- `content` - Writing/documentation
- `outreach` - Communication/email
- `review` - Human review required
- `decision` - CEO decision required

---

## 3. Search Routing Logic

### 3.1 Search Architecture Options

#### Option A: D1-Based Search (Simple, Limited)
```
Search Query → Nexus → D1 LIKE queries → Results
```
- **Pros:** Already have D1, no new services
- **Cons:** No semantic search, poor relevance, slow at scale

#### Option B: Vectorize Integration (Recommended)
```
                    ┌────────────────────────┐
                    │   Cloudflare Vectorize │
                    │   (Embeddings Store)   │
                    └───────────┬────────────┘
                                │
Search Query → Nexus → DE (embed) → Vectorize → Semantic Results
                │                               │
                └───────────────────────────────┘
                        Combine & Rank
```
- **Pros:** Semantic search, CF-native, scales well
- **Cons:** New service to manage, embedding costs

#### Option C: Hybrid Search (Best of Both)
```
                    ┌─────────────────┐
                    │  D1 (Keyword)   │
                    └────────┬────────┘
                             │
Search Query → Nexus ────────┼──────────────► Merge & Rank
                             │
                    ┌────────┴────────┐
                    │ Vectorize       │
                    │ (Semantic)      │
                    └─────────────────┘
```

### 3.2 Recommended: Phased Hybrid Approach

**Phase 1:** Enhanced D1 Search (Immediate)
- Add FTS5 full-text search tables
- Implement search across all entities
- Basic relevance scoring

**Phase 2:** Vectorize Integration (Near-term)
- Embed notes, ideas, tasks on create/update
- Semantic search for context retrieval
- Feed Mnemo's context loading

**Phase 3:** Unified Search API (Future)
- Single `/api/search` endpoint
- Query routing based on search type
- Cross-entity result merging

### 3.3 Search Routing Decision Tree

```
                    ┌─────────────────────┐
                    │   Search Request    │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
         ┌────┴────┐     ┌────┴────┐     ┌────┴────┐
         │ Keyword │     │ Semantic│     │ Entity  │
         │  Search │     │  Search │     │  Lookup │
         └────┬────┘     └────┬────┘     └────┬────┘
              │               │               │
              ▼               ▼               ▼
         ┌─────────┐    ┌─────────┐    ┌─────────┐
         │   D1    │    │Vectorize│    │   D1    │
         │  FTS5   │    │         │    │  Direct │
         └────┬────┘    └────┬────┘    └────┬────┘
              │               │               │
              └───────────────┼───────────────┘
                              │
                       ┌──────┴──────┐
                       │   Merger    │
                       │  & Ranker   │
                       └──────┬──────┘
                              │
                              ▼
                       ┌─────────────┐
                       │   Results   │
                       └─────────────┘
```

### 3.4 Search API Contract

```typescript
// POST /api/search
interface SearchRequest {
  query: string;
  search_type: 'keyword' | 'semantic' | 'hybrid';
  entity_types?: ('task' | 'idea' | 'note' | 'project' | 'person')[];
  filters?: {
    status?: string[];
    date_range?: { start: string; end: string };
    tags?: string[];
  };
  limit?: number;
  offset?: number;
}

interface SearchResponse {
  results: SearchResult[];
  total_count: number;
  search_type_used: string;
  query_time_ms: number;
}

interface SearchResult {
  entity_type: string;
  entity_id: string;
  title: string;
  snippet: string;
  relevance_score: number;
  matched_fields: string[];
}
```

---

## 4. Data Flow Patterns

### 4.1 Capture → Classification → Action Flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          INPUT SOURCES                                      │
│  Voice │ Text │ Email │ Claude MCP │ API │ Web Dashboard                   │
└────────────────────────────────────────┬───────────────────────────────────┘
                                         │
                                         ▼
                        ┌────────────────────────────────┐
                        │        CaptureBuffer DO        │
                        │  - Batching                    │
                        │  - Deduplication               │
                        │  - Source tracking             │
                        └────────────────┬───────────────┘
                                         │
                                         ▼
                        ┌────────────────────────────────┐
                        │         InboxManager DO        │
                        │  - Queue management            │
                        │  - WebSocket notifications     │
                        └────────────────┬───────────────┘
                                         │
                                         ▼
                        ┌────────────────────────────────┐
                        │     AI Classification          │
                        │     (via DE text-gen)          │
                        │                                │
                        │  Determines:                   │
                        │  - Entity type (task/idea/etc) │
                        │  - Confidence score            │
                        │  - Suggested tags              │
                        │  - Routing hints               │
                        └────────────────┬───────────────┘
                                         │
              ┌──────────────────────────┼──────────────────────────┐
              │ High Confidence          │ Medium                   │ Low
              │ (≥80%)                   │ (50-80%)                 │ (<50%)
              ▼                          ▼                          ▼
    ┌─────────────────┐      ┌─────────────────┐       ┌─────────────────┐
    │ Auto-create     │      │ Create + Flag   │       │ Leave in Inbox  │
    │ Task/Idea/Note  │      │ for Review      │       │ for Human Triage│
    └─────────────────┘      └─────────────────┘       └─────────────────┘
```

### 4.2 Idea → Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           IDEA LIFECYCLE                                     │
└─────────────────────────────────────────────────────────────────────────────┘

    ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
    │  Capture │ ──▶ │  Triage  │ ──▶ │ Planning │ ──▶ │ Execute  │
    └──────────┘     └──────────┘     └──────────┘     └──────────┘
         │               │                 │                │
         │               │                 │                │
         ▼               ▼                 ▼                ▼
    ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
    │  inbox   │     │ triaged  │     │ planned  │     │executing │
    │  items   │     │  ideas   │     │   +      │     │  tasks   │
    │          │     │          │     │  tasks   │     │          │
    └──────────┘     └──────────┘     └──────────┘     └──────────┘

TRIAGE DECISION POINTS:
┌────────────────────────────────────────────────────────────────────────────┐
│ Is it actionable? ─── No ──▶ Park in Ideas (needs thinking)               │
│        │                                                                   │
│       Yes                                                                  │
│        │                                                                   │
│ What's the scope?                                                          │
│   │                                                                        │
│   ├─── Quick-win (<30m) ──▶ Create Task ──▶ Skip Planning ──▶ Execute     │
│   │                                                                        │
│   ├─── Small (30m-2hr) ──▶ Create Task ──▶ Maybe 1-step plan              │
│   │                                                                        │
│   ├─── Medium (2hr-1d) ──▶ Run Planning Workflow ──▶ 3-7 Tasks            │
│   │                                                                        │
│   ├─── Large (1d-1wk) ──▶ Full Planning ──▶ 7-15 Tasks                    │
│   │                                                                        │
│   └─── Epic (>1wk) ──▶ Break into Multiple Ideas First                    │
└────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Task Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          TASK EXECUTION FLOW                                 │
└─────────────────────────────────────────────────────────────────────────────┘

    Task (status: next)
           │
           ▼
    ┌──────────────────┐
    │  Task Dispatcher │ ◄──── Cron (every 15 min) OR Manual MCP
    │  (Nexus)         │
    └────────┬─────────┘
             │
    ┌────────┴────────────────────────────────────────┐
    │                                                  │
    ▼                                                  ▼
┌───────────┐                                    ┌───────────┐
│ executor: │                                    │ executor: │
│ 'human'   │                                    │ 'ai'      │
└─────┬─────┘                                    └─────┬─────┘
      │                                                │
      ▼                                                ▼
┌──────────────┐                          ┌───────────────────────┐
│ Queue for    │                          │ POST /execute         │
│ Human Review │                          │ (DE Workflows)        │
│              │                          └───────────┬───────────┘
│ - Dashboard  │                                      │
│ - Notification│                                     ▼
│ - Email      │                          ┌───────────────────────┐
└──────────────┘                          │    PrimeWorkflow      │
                                          │                       │
                                          │  Routes to:           │
                                          │  - CodeExecution      │
                                          │  - TextGeneration     │
                                          │  - Research (future)  │
                                          │  - Content (future)   │
                                          └───────────┬───────────┘
                                                      │
                                                      ▼
                                          ┌───────────────────────┐
                                          │  Child Workflow       │
                                          │  Execution            │
                                          │                       │
                                          │  Uses:                │
                                          │  - Sandbox Executor   │
                                          │  - DE Text-Gen        │
                                          │  - External APIs      │
                                          └───────────┬───────────┘
                                                      │
                                                      ▼
                                          ┌───────────────────────┐
                                          │  Callback to Nexus    │
                                          │  POST /api/workflow/  │
                                          │       callback        │
                                          └───────────────────────┘
```

### 4.4 Memory/Context Flow (Future - Mnemo)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CONTEXT MANAGEMENT FLOW                              │
└─────────────────────────────────────────────────────────────────────────────┘

User Input arrives at Nexus
           │
           ▼
┌──────────────────────────────────────┐
│   Active Memory Manager (AMM)        │
│   (Nexus)                            │
│                                      │
│   1. Entity Detection                │
│      - People mentions               │
│      - Project references            │
│      - Task IDs                      │
│      - Temporal markers              │
│                                      │
│   2. Context Requirements Calc       │
│      - What entities are relevant?   │
│      - What history is needed?       │
│      - What's the confidence level?  │
└─────────────────┬────────────────────┘
                  │
                  │ Tell Mnemo what to load
                  ▼
┌──────────────────────────────────────┐
│          MNEMO                       │
│     (Working Memory Cache)           │
│                                      │
│   ┌──────────────────────┐           │
│   │   HOT (In-session)   │ ◄─ Most recent context, current task
│   │   TTL: Session       │
│   └──────────────────────┘
│   ┌──────────────────────┐           │
│   │  WARM (Recent)       │ ◄─ Related entities, recent history
│   │  TTL: Hours          │
│   └──────────────────────┘
│   ┌──────────────────────┐           │
│   │  COLD (Background)   │ ◄─ User preferences, patterns
│   │  TTL: Days           │
│   └──────────────────────┘
│                                      │
│   Mnemo ONLY caches                  │
│   Mnemo does NOT make decisions      │
│   Nexus tells Mnemo what to load     │
└─────────────────┬────────────────────┘
                  │
                  │ Return requested context
                  ▼
┌──────────────────────────────────────┐
│   Nexus enriches request with        │
│   context and routes appropriately   │
└──────────────────────────────────────┘
```

---

## 5. Integration Strategy

### 5.1 Service Communication Patterns

#### Pattern 1: Service Binding (Preferred for CF Workers)
```typescript
// Zero-cost, low-latency, CF-native
// Use for: DE Text-Gen, Sandbox Executor, Intake
const response = await env.DE.fetch(request);
```

#### Pattern 2: HTTP with Callbacks (For Workflows)
```typescript
// For cross-worker workflow triggers (CF limitation)
// Use for: DE Workflows, External services
const response = await fetch(`${DE_WORKFLOWS_URL}/execute`, {
  method: 'POST',
  body: JSON.stringify({
    task_id,
    callback_url: `${NEXUS_URL}/api/workflow/callback`
  })
});
```

#### Pattern 3: Durable Object RPC (For State)
```typescript
// For stateful operations within same worker
// Use for: InboxManager, UserSession, IdeaExecutor
const stub = env.INBOX_MANAGER.get(id);
await stub.capture(item);
```

### 5.2 Integration Contracts

#### Nexus ↔ DE Text-Gen

```typescript
// Request (via service binding)
interface TextGenRequest {
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  model?: string;       // Default: claude-3-5-sonnet
  max_tokens?: number;  // Default: 4096
  temperature?: number; // Default: 0.7
}

// Response
interface TextGenResponse {
  content: string;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}
```

#### Nexus ↔ DE Workflows

```typescript
// Request (HTTP POST /execute)
interface WorkflowExecuteRequest {
  task_id: string;
  task_type: 'code' | 'research' | 'content' | 'outreach';
  context: {
    title: string;
    description: string;
    repo_url?: string;
    files?: string[];
    instructions?: string;
  };
  callback_url: string;
  timeout_ms?: number;  // Default: 600000 (10 min)
}

// Callback (POST to callback_url)
interface WorkflowCallback {
  task_id: string;
  status: 'completed' | 'failed' | 'blocked';
  result?: {
    summary: string;
    outputs?: string[];
    pr_url?: string;
    commit_sha?: string;
  };
  error?: {
    code: string;
    message: string;
  };
  blocker?: {
    type: 'decision' | 'information' | 'permission';
    description: string;
  };
  execution_time_ms: number;
}
```

#### Nexus ↔ Sandbox Executor

```typescript
// Request (via service binding)
interface SandboxExecuteRequest {
  task_id: string;
  prompt: string;
  repo_url?: string;
  working_directory?: string;
  allowed_commands?: string[];
  timeout_ms?: number;  // Default: 300000 (5 min)
}

// Response
interface SandboxExecuteResponse {
  success: boolean;
  output: string;
  files_changed?: string[];
  error?: string;
}
```

### 5.3 Error Handling Strategy

```typescript
// Unified error response format
interface ErrorResponse {
  error: {
    code: string;        // e.g., 'VALIDATION_ERROR', 'NOT_FOUND'
    message: string;     // Human-readable message
    details?: unknown;   // Additional context
    request_id: string;  // For tracing
  };
}

// Retry policy
interface RetryPolicy {
  max_attempts: 3;
  base_delay_ms: 1000;
  max_delay_ms: 30000;
  exponential_backoff: true;
  retryable_codes: ['TIMEOUT', 'SERVICE_UNAVAILABLE', 'RATE_LIMITED'];
}
```

### 5.4 Authentication Flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│                        AUTHENTICATION LAYERS                                │
└────────────────────────────────────────────────────────────────────────────┘

External Requests (Users/MCP Clients):
┌─────────────┐    ┌─────────────────┐    ┌──────────────┐
│   Client    │───▶│ Cloudflare      │───▶│   Nexus      │
│             │    │ Access JWT      │    │              │
└─────────────┘    └─────────────────┘    └──────────────┘

Service-to-Service (Internal):
┌─────────────┐    ┌─────────────────┐    ┌──────────────┐
│   Nexus     │───▶│ Service Binding │───▶│   DE         │
│             │    │ (No auth needed)│    │              │
└─────────────┘    └─────────────────┘    └──────────────┘

MCP Write Operations:
┌─────────────┐    ┌─────────────────┐    ┌──────────────┐
│   MCP       │───▶│ Passphrase      │───▶│   Nexus      │
│   Client    │    │ Validation      │    │              │
└─────────────┘    └─────────────────┘    └──────────────┘
```

---

## 6. Implementation Recommendations

### 6.1 Priority 1: Fix Routing Bypass (Immediate)

**Files to Modify:**
1. `src/scheduled/task-executor.ts` - Change `executeCodeTaskViaWorkflow()` to call `/execute`
2. `src/mcp/index.ts` - Change `nexus_create_task` auto_dispatch to call `/execute`

**Expected Outcome:**
```typescript
// Before (bypass)
fetch(`${workflowsUrl}/workflows/code-execution`, ...)

// After (correct)
fetch(`${workflowsUrl}/execute`, {
  body: JSON.stringify({
    task_id,
    task_type: 'code',
    context: { ... },
    callback_url: `${NEXUS_URL}/api/workflow/callback`
  })
})
```

### 6.2 Priority 2: Implement Unified Search (Near-term)

**Phase 1: D1 FTS5 (1-2 days)**
```sql
-- Create FTS5 virtual tables
CREATE VIRTUAL TABLE tasks_fts USING fts5(
  title, description, tags,
  content='tasks',
  content_rowid='rowid'
);

CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, content, tags,
  content='notes',
  content_rowid='rowid'
);

-- Similar for ideas, projects
```

**Phase 2: Search API Endpoint**
```
GET /api/search?q=term&types=task,note&limit=20
```

### 6.3 Priority 3: Standardize Executor Routing (Near-term)

**Database Migration:**
```sql
-- Simplify executor types
ALTER TABLE tasks ADD COLUMN executor_type TEXT DEFAULT 'human';
-- Values: 'ai', 'human', 'human-ai'

-- Add formal task type
ALTER TABLE tasks ADD COLUMN task_type TEXT;
-- Values: 'code', 'research', 'content', 'outreach', 'review', 'decision'
```

**Routing Logic Update:**
```typescript
function routeTask(task: Task): ExecutorType {
  // Explicit executor takes precedence
  if (task.executor_type) return task.executor_type;

  // Route by task type
  switch (task.task_type) {
    case 'code':
    case 'research':
    case 'content':
      return 'ai';
    case 'review':
    case 'decision':
      return 'human';
    case 'outreach':
      return 'human-ai';
    default:
      return 'human'; // Safe default
  }
}
```

### 6.4 Priority 4: Mnemo Integration (Future)

**Step 1:** Define Mnemo API contract
**Step 2:** Implement AMM entity detection in Nexus
**Step 3:** Add context loading triggers
**Step 4:** Build cache tier management

### 6.5 Priority 5: Bridge Development (Future)

**Purpose:** Unified user interface layer
**Components:**
- Voice input/output
- Real-time notifications
- Mobile-responsive web
- Push notifications

---

## 7. Architecture Decision Records

### ADR-001: Use PrimeWorkflow as Single Entry Point

**Status:** Proposed

**Context:** Nexus currently bypasses PrimeWorkflow by calling specific workflow endpoints directly.

**Decision:** All task execution should route through DE Workflows' `/execute` endpoint, which triggers PrimeWorkflow for routing.

**Consequences:**
- (+) Single point of routing logic
- (+) Easier to add new workflow types
- (+) Centralized metrics/logging
- (-) Slight latency increase for simple tasks

### ADR-002: Hybrid Search Strategy

**Status:** Proposed

**Context:** Need search across all entities with both keyword and semantic capabilities.

**Decision:** Implement phased hybrid search:
1. D1 FTS5 for keyword search (immediate)
2. Vectorize for semantic search (future)
3. Unified API that combines both

**Consequences:**
- (+) Progressive enhancement
- (+) Works without new infrastructure immediately
- (-) Dual maintenance during transition

### ADR-003: Simplified Executor Types

**Status:** Proposed

**Context:** Multiple overlapping executor naming conventions exist.

**Decision:** Consolidate to three executor types:
- `ai` - Fully autonomous AI execution
- `human` - Human only
- `human-ai` - Human with AI assistance

**Consequences:**
- (+) Simpler routing logic
- (+) Clear responsibility boundaries
- (-) Need migration for existing tasks

### ADR-004: Task Type Taxonomy

**Status:** Proposed

**Context:** Tasks need classification for proper routing to execution loops.

**Decision:** Implement formal `task_type` enum:
- `code` → CodeExecutionLoop
- `research` → ResearchLoop (future)
- `content` → ContentLoop (future)
- `outreach` → OutreachLoop (future)
- `review` → Human queue
- `decision` → CEO queue

**Consequences:**
- (+) Deterministic routing
- (+) Enables specialized execution paths
- (-) Need AI classifier update

### ADR-005: Callback-Based Workflow Communication

**Status:** Accepted (Implemented)

**Context:** Cloudflare Workflows cannot be triggered via service bindings across workers.

**Decision:** Use HTTP endpoints with callback URLs for cross-worker workflow execution.

**Consequences:**
- (+) Works within CF limitations
- (+) Enables async long-running tasks
- (-) More complex error handling

---

## 8. Workshop Session: 2025-12-29

### Status Updates

#### Routing Bypass - RESOLVED
**Status:** ✅ Fixed (Documentation was stale)

Investigation revealed that `src/mcp/index.ts:377` already correctly routes through `/execute`:
```typescript
const workflowUrl = `${env.DE_WORKFLOWS_URL}/execute`;
```

The `ROUTING_BYPASS_REPORT.md` documentation was outdated. The bypass no longer exists in the MCP path.

#### Dual Execution Paths - IDENTIFIED

Current state has two paths:
1. **Cron dispatcher** → IntakeClient (service binding) → `intake` worker
2. **MCP auto-dispatch** → HTTP POST → `DE_WORKFLOWS_URL/execute`

**Decision:** Consolidate to Intake service binding for consistency.

**Rationale:**
- Service bindings are zero-cost, lower latency
- Intake handles failover, retries, crash recovery
- Single path simplifies debugging

### Implementation Roadmap

| Priority | Task | Status | Notes |
|----------|------|--------|-------|
| P1 | Update stale docs | 🔄 In Progress | This file + ROUTING_BYPASS_REPORT.md |
| P2 | Consolidate to Intake | 📋 Planned | Modify MCP to use IntakeClient |
| P3 | Add `task_type` field | 📋 Planned | DB migration + classification update |
| P4 | D1 FTS5 search | 📋 Planned | Virtual tables + API endpoint |
| P5 | Simplify executor types | 📋 Planned | Normalize to ai/human/human-ai |

---

## Summary: Key Takeaways

1. ~~**Fix the bypass**~~ ✅ - MCP already routes through `/execute`
2. **Consolidate execution** - Use Intake service binding everywhere
3. **Implement search** - Start with D1 FTS5, plan for Vectorize
4. **Simplify routing** - Three executor types, formal task types
5. **Standardize contracts** - Document all service interfaces
6. **Plan for Mnemo** - Design context management architecture

---

## 9. Architecture Design Session: 2025-12-30

### Session Focus: Finalize Integration Strategy, Data Flow, and Search Routing

This session finalizes the architectural decisions and creates actionable implementation plans.

---

### 9.1 Integration Strategy - Finalized Decisions

#### Decision 1: Execution Path Consolidation

**Current State Analysis:**
- **Cron dispatcher** → `IntakeClient` (service binding) → `intake` worker
- **MCP auto-dispatch** → HTTP POST → `DE_WORKFLOWS_URL/execute`

**Problem:** Two different execution paths create inconsistency, duplicate error handling, and debugging complexity.

**Final Decision: Hybrid Approach (Not Full Consolidation)**

After reviewing the implementation, the dual-path approach is actually **intentional** for different use cases:

| Path | Use Case | Rationale |
|------|----------|-----------|
| **IntakeClient (Service Binding)** | Cron-dispatched batch execution | Zero-cost, best for scheduled bulk dispatching |
| **HTTP to DE Workflows** | MCP real-time execution | Allows callback URLs, cross-worker workflow triggers |

**Action:** Document this as the intended architecture, not consolidate. Both paths ultimately reach PrimeWorkflow, just via different entry points.

```
┌─────────────────────────────────────────────────────────────────────┐
│                      DUAL EXECUTION PATHS                           │
│                     (Both are Valid)                                │
└─────────────────────────────────────────────────────────────────────┘

PATH A: Scheduled Execution (Cron)
┌─────────┐     ┌──────────────┐     ┌─────────┐     ┌──────────────┐
│ Cron    │ ──▶ │ IntakeClient │ ──▶ │ Intake  │ ──▶ │ PrimeWorkflow│
│ Trigger │     │ (svc bind)   │     │ Worker  │     │              │
└─────────┘     └──────────────┘     └─────────┘     └──────────────┘

PATH B: Real-time Execution (MCP)
┌─────────┐     ┌──────────────┐     ┌──────────────┐
│ MCP     │ ──▶ │ HTTP POST    │ ──▶ │ PrimeWorkflow│
│ Request │     │ /execute     │     │              │
└─────────┘     └──────────────┘     └──────────────┘
                     │
                     └──▶ callback_url on completion
```

---

#### Decision 2: Service Communication Contracts

**Finalized Contract Specifications:**

##### A. Nexus → DE Text-Gen (via Service Binding)

```typescript
// env.DE.fetch() - zero-cost service binding
interface DETextGenRequest {
  endpoint: '/chat/completions';
  body: {
    messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string;
    }>;
    model?: string;        // Default: 'claude-sonnet-4-20250514'
    max_tokens?: number;   // Default: 4096
    temperature?: number;  // Default: 0.7
    stream?: boolean;      // Default: false
  };
}
```

##### B. Nexus → Intake (via Service Binding)

```typescript
// env.INTAKE.fetch() - for code execution workflows
interface IntakeRequest {
  query: string;           // The execution prompt
  task_type: 'code';       // Currently only 'code' supported
  app_id?: string;         // Application identifier
  task_id: string;         // Nexus task ID for tracking
  prompt?: string;         // Additional context
  repo_url?: string;       // Git repository to work in
  executor?: 'claude' | 'gemini';  // AI provider preference
  callback_url?: string;   // Where to POST results
  metadata?: Record<string, unknown>;
  timeout_ms?: number;     // Default: 300000 (5 min)
}
```

##### C. Nexus → DE Workflows (via HTTP)

```typescript
// POST to DE_WORKFLOWS_URL/execute
interface WorkflowExecuteRequest {
  params: {
    task_id: string;
    title: string;
    description: string;
    context: {
      repo?: string;
      files?: string[];
      instructions?: string;
    };
    hints: {
      workflow: 'code-execution' | 'research' | 'content';
      provider: 'claude' | 'gemini';
    };
    callback_url: string;
    timeout_ms: number;
  };
}

// Callback POST to callback_url
interface WorkflowCallback {
  task_id: string;
  status: 'completed' | 'failed' | 'blocked';
  result?: {
    summary: string;
    outputs?: string[];
    pr_url?: string;
    commit_sha?: string;
  };
  error?: {
    code: string;
    message: string;
    stack?: string;
  };
  blocker?: {
    type: 'decision' | 'information' | 'permission';
    description: string;
    options?: string[];
  };
  execution_time_ms: number;
  tokens_used?: {
    input: number;
    output: number;
  };
}
```

---

### 9.2 Search Routing Logic - Detailed Design

#### Phase 1: D1 FTS5 Implementation (Immediate)

**Why FTS5:**
- Native D1 support, no external dependencies
- Performant for keyword search up to millions of rows
- Supports ranking, snippets, prefix matching
- Already have D1 infrastructure

**Implementation Plan:**

```sql
-- Step 1: Create FTS5 virtual tables (external content)

-- Tasks FTS
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  title,
  description,
  tags,
  content='tasks',
  content_rowid='rowid'
);

-- Ideas FTS
CREATE VIRTUAL TABLE IF NOT EXISTS ideas_fts USING fts5(
  title,
  description,
  tags,
  content='ideas',
  content_rowid='rowid'
);

-- Notes FTS (when notes table exists)
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title,
  content,
  tags,
  content='notes',
  content_rowid='rowid'
);

-- Projects FTS
CREATE VIRTUAL TABLE IF NOT EXISTS projects_fts USING fts5(
  name,
  description,
  objective,
  tags,
  content='projects',
  content_rowid='rowid'
);

-- Step 2: Create triggers to keep FTS in sync

-- Tasks triggers
CREATE TRIGGER IF NOT EXISTS tasks_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(rowid, title, description, tags)
  VALUES (NEW.rowid, NEW.title, NEW.description, NEW.tags);
END;

CREATE TRIGGER IF NOT EXISTS tasks_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description, tags)
  VALUES ('delete', OLD.rowid, OLD.title, OLD.description, OLD.tags);
END;

CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description, tags)
  VALUES ('delete', OLD.rowid, OLD.title, OLD.description, OLD.tags);
  INSERT INTO tasks_fts(rowid, title, description, tags)
  VALUES (NEW.rowid, NEW.title, NEW.description, NEW.tags);
END;

-- (Similar triggers for ideas, notes, projects)
```

**Search API Endpoint:**

```typescript
// GET /api/search
interface SearchParams {
  q: string;              // Search query
  types?: string[];       // Entity types: task, idea, note, project
  status?: string[];      // Filter by status
  domain?: string;        // Filter by domain
  limit?: number;         // Default: 20, max: 100
  offset?: number;        // Pagination offset
}

// Implementation in src/routes/search.ts
const search = new Hono<AppType>();

search.get('/', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const { q, types, status, domain, limit = 20, offset = 0 } = c.req.query();

  if (!q || q.length < 2) {
    return c.json({ success: false, error: 'Query too short' }, 400);
  }

  const results: SearchResult[] = [];
  const entityTypes = types?.split(',') || ['task', 'idea', 'project'];

  // Search tasks
  if (entityTypes.includes('task')) {
    const taskResults = await c.env.DB.prepare(`
      SELECT t.id, t.title, t.description, t.status, t.domain,
             snippet(tasks_fts, 0, '<mark>', '</mark>', '...', 32) as snippet,
             bm25(tasks_fts) as rank
      FROM tasks_fts f
      JOIN tasks t ON t.rowid = f.rowid
      WHERE tasks_fts MATCH ?
        AND t.tenant_id = ?
        AND t.user_id = ?
        AND t.deleted_at IS NULL
      ORDER BY rank
      LIMIT ? OFFSET ?
    `).bind(q, tenantId, userId, limit, offset).all();

    results.push(...taskResults.results.map(r => ({
      entity_type: 'task',
      entity_id: r.id,
      title: r.title,
      snippet: r.snippet,
      relevance_score: Math.abs(r.rank),
      metadata: { status: r.status, domain: r.domain }
    })));
  }

  // Similar for ideas, projects, notes...

  // Sort by relevance across all types
  results.sort((a, b) => b.relevance_score - a.relevance_score);

  return c.json({
    success: true,
    data: results.slice(0, limit),
    meta: {
      query: q,
      total: results.length,
      limit,
      offset
    }
  });
});
```

#### Phase 2: Vectorize Integration (Future)

**Architecture for Semantic Search:**

```
┌─────────────────────────────────────────────────────────────────────┐
│                    HYBRID SEARCH ARCHITECTURE                        │
└─────────────────────────────────────────────────────────────────────┘

                    ┌─────────────────────┐
                    │   Search Request    │
                    │   { q: "..." }      │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
    ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
    │   D1 FTS5       │ │ CF Vectorize    │ │ Entity Lookup   │
    │   (Keyword)     │ │ (Semantic)      │ │ (ID/mention)    │
    └────────┬────────┘ └────────┬────────┘ └────────┬────────┘
             │                   │                   │
             ▼                   ▼                   ▼
    ┌─────────────────────────────────────────────────────────────────┐
    │                    Result Merger & Ranker                        │
    │   - Deduplicate by entity_id                                     │
    │   - Combine scores: final = 0.6*keyword + 0.4*semantic          │
    │   - Entity lookup results get boost                             │
    │   - Apply filters (status, domain, date)                        │
    └─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   Ranked Results    │
                    └─────────────────────┘
```

**Vectorize Integration Points:**

1. **Embedding on Write:**
   ```typescript
   // In task/idea/note create/update handlers
   async function onEntityWrite(entity: Entity, env: Env) {
     // Queue embedding generation (async, don't block)
     await env.EMBEDDING_QUEUE.send({
       action: 'embed',
       entity_type: entity.type,
       entity_id: entity.id,
       content: `${entity.title} ${entity.description}`,
     });
   }
   ```

2. **Background Embedding Worker:**
   ```typescript
   // Separate worker or queue consumer
   async function processEmbedding(message: EmbeddingMessage, env: Env) {
     const embedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
       text: message.content
     });

     await env.VECTORIZE.insert({
       id: `${message.entity_type}:${message.entity_id}`,
       values: embedding.data[0],
       metadata: {
         entity_type: message.entity_type,
         entity_id: message.entity_id,
       }
     });
   }
   ```

3. **Semantic Search:**
   ```typescript
   async function semanticSearch(query: string, env: Env) {
     const queryEmbedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
       text: query
     });

     const results = await env.VECTORIZE.query(queryEmbedding.data[0], {
       topK: 20,
       returnMetadata: true,
     });

     return results.matches.map(m => ({
       entity_type: m.metadata.entity_type,
       entity_id: m.metadata.entity_id,
       score: m.score,
     }));
   }
   ```

---

### 9.3 Executor Type Standardization

#### Current State Analysis

From codebase review, current executor handling:
- `executor` field in `execution_queue` table
- Values seen: `claude-code`, `claude-ai`, `de-agent`, `human`, `human-ai`
- Title prefixes: `[CC]`, `[DE]`
- Classification logic in `src/lib/classifier.ts`

#### Finalized Executor Type Taxonomy

**Three Canonical Types:**

| Type | Description | Execution Path |
|------|-------------|----------------|
| `ai` | Fully autonomous AI execution | IntakeClient → PrimeWorkflow → CodeExecution |
| `human` | Human-only task | Queue for dashboard, notifications |
| `human-ai` | Human primary with AI assistance | Dashboard with AI suggestions |

**Migration Strategy:**

```sql
-- Step 1: Add new normalized column
ALTER TABLE execution_queue ADD COLUMN executor_type TEXT;

-- Step 2: Migrate existing values
UPDATE execution_queue SET executor_type = CASE
  WHEN executor IN ('claude-code', 'claude-ai', 'de-agent') THEN 'ai'
  WHEN executor = 'human' THEN 'human'
  WHEN executor = 'human-ai' THEN 'human-ai'
  ELSE 'human'  -- Safe default
END;

-- Step 3: Update tasks table
ALTER TABLE tasks ADD COLUMN executor_type TEXT DEFAULT 'human';
ALTER TABLE tasks ADD COLUMN task_type TEXT;

-- Step 4: Create index
CREATE INDEX IF NOT EXISTS idx_tasks_executor ON tasks(tenant_id, executor_type);
CREATE INDEX IF NOT EXISTS idx_tasks_task_type ON tasks(tenant_id, task_type);
```

**Task Type Classification:**

| Task Type | Executor Routing | Description |
|-----------|------------------|-------------|
| `code` | → `ai` | Code generation, modification, deployment |
| `research` | → `ai` | Information gathering, analysis |
| `content` | → `ai` | Writing, documentation |
| `outreach` | → `human-ai` | Communication requiring human review |
| `review` | → `human` | Requires human judgment |
| `decision` | → `human` | CEO/owner decision required |

**Routing Function:**

```typescript
// src/lib/routing.ts
export function routeTask(task: Task): ExecutorType {
  // Explicit override takes precedence
  if (task.executor_type) {
    return task.executor_type as ExecutorType;
  }

  // Route by task type
  switch (task.task_type) {
    case 'code':
    case 'research':
    case 'content':
      return 'ai';
    case 'outreach':
      return 'human-ai';
    case 'review':
    case 'decision':
      return 'human';
    default:
      // Classify from title/description
      return classifyExecutor(task.title, task.description);
  }
}

function classifyExecutor(title: string, description?: string): ExecutorType {
  const text = `${title} ${description || ''}`.toLowerCase();

  // AI indicators
  const aiPatterns = [
    /\b(implement|code|develop|build|create|fix|debug|deploy|test)\b/,
    /\b(research|analyze|investigate|explore|find)\b/,
    /\b(write|document|draft|generate)\b/,
  ];

  // Human indicators
  const humanPatterns = [
    /\b(decide|approve|review|sign|call|meet|discuss)\b/,
    /\b(personal|family|health)\b/,
  ];

  if (humanPatterns.some(p => p.test(text))) return 'human';
  if (aiPatterns.some(p => p.test(text))) return 'ai';

  return 'human'; // Safe default
}
```

---

### 9.4 Data Flow Patterns - Sequence Diagrams

#### Pattern A: MCP Task Creation with Auto-Dispatch

```
┌────────┐     ┌───────┐     ┌────────────┐     ┌────────────┐
│ Claude │     │ Nexus │     │ DE-Workflows│     │ Sandbox    │
│ Code   │     │ MCP   │     │ /execute   │     │ Executor   │
└───┬────┘     └───┬───┘     └─────┬──────┘     └─────┬──────┘
    │               │               │                  │
    │ nexus_create_task             │                  │
    │ (auto_dispatch=true)          │                  │
    │──────────────>│               │                  │
    │               │               │                  │
    │               │ INSERT task   │                  │
    │               │ INSERT queue  │                  │
    │               │───────┐       │                  │
    │               │       │       │                  │
    │               │<──────┘       │                  │
    │               │               │                  │
    │               │ POST /execute │                  │
    │               │──────────────>│                  │
    │               │               │                  │
    │               │   202 Accepted│                  │
    │               │<──────────────│                  │
    │               │               │                  │
    │  response:    │               │ PrimeWorkflow    │
    │  task_id,     │               │ routes to        │
    │  workflow_    │               │ CodeExecution    │
    │  triggered    │               │───────┐          │
    │<──────────────│               │       │          │
    │               │               │       │          │
    │               │               │<──────┘          │
    │               │               │                  │
    │               │               │ Run Claude Code  │
    │               │               │─────────────────>│
    │               │               │                  │
    │               │               │    Results       │
    │               │               │<─────────────────│
    │               │               │                  │
    │               │  POST /workflow-callback         │
    │               │<──────────────│                  │
    │               │               │                  │
    │               │ UPDATE task   │                  │
    │               │ status=done   │                  │
    │               │───────┐       │                  │
    │               │       │       │                  │
    │               │<──────┘       │                  │
    │               │               │                  │
```

#### Pattern B: Cron-Dispatched Batch Execution

```
┌────────┐     ┌───────┐     ┌────────────┐     ┌────────────┐
│ Cron   │     │ Nexus │     │  Intake    │     │ Prime      │
│ Trigger│     │ Worker│     │  Worker    │     │ Workflow   │
└───┬────┘     └───┬───┘     └─────┬──────┘     └─────┬──────┘
    │               │               │                  │
    │ */15 * * * *  │               │                  │
    │──────────────>│               │                  │
    │               │               │                  │
    │               │ SELECT tasks  │                  │
    │               │ WHERE status  │                  │
    │               │ = 'next' AND  │                  │
    │               │ executor_type │                  │
    │               │ = 'ai'        │                  │
    │               │───────┐       │                  │
    │               │       │       │                  │
    │               │<──────┘       │                  │
    │               │               │                  │
    │               │ for each task:│                  │
    │               │               │                  │
    │               │ IntakeClient  │                  │
    │               │ .triggerWorkflow()               │
    │               │──────────────>│                  │
    │               │               │                  │
    │               │               │ Create workflow  │
    │               │               │─────────────────>│
    │               │               │                  │
    │               │ workflow_id   │                  │
    │               │<──────────────│                  │
    │               │               │                  │
    │               │ UPDATE task   │                  │
    │               │ status =      │                  │
    │               │ 'scheduled'   │                  │
    │               │───────┐       │                  │
    │               │       │       │                  │
    │               │<──────┘       │                  │
    │               │               │                  │
```

#### Pattern C: Idea → Planning → Execution Flow

```
┌────────┐     ┌───────┐     ┌────────────┐     ┌────────────┐
│ User   │     │ Nexus │     │IdeaToPlan  │     │Task        │
│        │     │       │     │Workflow    │     │Executor    │
└───┬────┘     └───┬───┘     └─────┬──────┘     └─────┬──────┘
    │               │               │                  │
    │ POST /execution/              │                  │
    │ ideas/:id/plan│               │                  │
    │──────────────>│               │                  │
    │               │               │                  │
    │               │ Create        │                  │
    │               │ idea_execution│                  │
    │               │───────┐       │                  │
    │               │       │       │                  │
    │               │<──────┘       │                  │
    │               │               │                  │
    │               │ IDEA_TO_PLAN_ │                  │
    │               │ WORKFLOW.     │                  │
    │               │ create()      │                  │
    │               │──────────────>│                  │
    │               │               │                  │
    │   execution_id│               │ Claude analyzes  │
    │   workflow_id │               │ idea, generates  │
    │<──────────────│               │ task breakdown   │
    │               │               │───────┐          │
    │               │               │       │          │
    │               │               │<──────┘          │
    │               │               │                  │
    │               │ INSERT tasks  │                  │
    │               │<──────────────│                  │
    │               │               │                  │
    │               │ UPDATE idea   │                  │
    │               │ execution_    │                  │
    │               │ status=       │                  │
    │               │ 'planned'     │                  │
    │               │<──────────────│                  │
    │               │               │                  │
    │ GET /execution/ideas/:id/status                  │
    │──────────────>│               │                  │
    │               │               │                  │
    │   { tasks: [  │               │                  │
    │     ...       │               │                  │
    │   ]}          │               │                  │
    │<──────────────│               │                  │
    │               │               │                  │
    │ POST /execution/              │                  │
    │ ideas/:id/    │               │                  │
    │ execute-all   │               │                  │
    │──────────────>│               │                  │
    │               │               │                  │
    │               │ For each ready task:             │
    │               │               │                  │
    │               │ TASK_EXECUTOR │                  │
    │               │ _WORKFLOW.    │                  │
    │               │ create()      │                  │
    │               │─────────────────────────────────>│
    │               │               │                  │
    │   tasks_      │               │    Execute...    │
    │   started: N  │               │                  │
    │<──────────────│               │                  │
    │               │               │                  │
```

---

### 9.5 Mnemo Integration Design (Future State)

**Purpose:** Working memory cache for context-aware AI operations.

**Design Principle:** Nexus controls what gets loaded; Mnemo only caches.

```
┌─────────────────────────────────────────────────────────────────────┐
│                   MNEMO INTEGRATION ARCHITECTURE                     │
└─────────────────────────────────────────────────────────────────────┘

User Input: "Update the auth flow in the nexus project"
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                NEXUS - Active Memory Manager (AMM)                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. ENTITY DETECTION                                                 │
│     ┌─────────────────────────────────────────────────────────────┐ │
│     │ Detected:                                                    │ │
│     │ - project: "nexus" (confidence: 0.95)                       │ │
│     │ - concept: "auth flow" (confidence: 0.87)                   │ │
│     │ - action: "update" → task_type: "code"                      │ │
│     └─────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  2. CONTEXT REQUIREMENTS                                             │
│     ┌─────────────────────────────────────────────────────────────┐ │
│     │ Load:                                                        │ │
│     │ - Project "nexus" details, repo URL                         │ │
│     │ - Recent tasks in "nexus" (last 5)                          │ │
│     │ - User preferences for code style                           │ │
│     │ - Memory items tagged "auth", "nexus"                       │ │
│     │ - Last 3 conversations about "nexus"                        │ │
│     └─────────────────────────────────────────────────────────────┘ │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
                    │
                    │ Tell Mnemo what to load
                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                           MNEMO                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ HOT CACHE (In-session, TTL: until session ends)              │   │
│  │ ├── Current task context                                     │   │
│  │ ├── Active project details                                   │   │
│  │ └── Conversation history (last 10 turns)                     │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ WARM CACHE (TTL: 4 hours)                                    │   │
│  │ ├── Related project memories                                 │   │
│  │ ├── Recent similar tasks                                     │   │
│  │ └── User coding preferences                                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ COLD CACHE (TTL: 24 hours, on-demand loading)                │   │
│  │ ├── User patterns and habits                                 │   │
│  │ ├── Historical decisions                                     │   │
│  │ └── Cross-project learnings                                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
                    │
                    │ Return loaded context
                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     ENRICHED REQUEST                                 │
├─────────────────────────────────────────────────────────────────────┤
│ {                                                                    │
│   "original_query": "Update the auth flow in the nexus project",   │
│   "resolved_entities": {                                             │
│     "project": { "id": "...", "name": "nexus", "repo": "..." }     │
│   },                                                                 │
│   "context": {                                                       │
│     "recent_tasks": [...],                                          │
│     "memories": [...],                                              │
│     "preferences": {...}                                            │
│   },                                                                 │
│   "routing": {                                                       │
│     "task_type": "code",                                            │
│     "executor_type": "ai"                                           │
│   }                                                                  │
│ }                                                                    │
└─────────────────────────────────────────────────────────────────────┘
```

**Implementation Phases for Mnemo:**

1. **Phase 1: memory_items table** ✅ Already exists in schema
2. **Phase 2: Basic CRUD for memories** (API endpoints)
3. **Phase 3: Entity Detection Service** (in Nexus)
4. **Phase 4: Cache Layer** (Mnemo as separate worker or Durable Object)
5. **Phase 5: Semantic Memory Search** (Vectorize integration)

---

### 9.6 Implementation Roadmap - Finalized

| Priority | Task | Effort | Dependencies | Status |
|----------|------|--------|--------------|--------|
| **P1** | Create D1 FTS5 migration | 2h | None | 📋 Ready |
| **P1** | Implement `/api/search` endpoint | 4h | FTS5 tables | 📋 Ready |
| **P2** | Add `task_type` field + migration | 2h | None | 📋 Ready |
| **P2** | Add `executor_type` normalization | 2h | None | 📋 Ready |
| **P2** | Update classifier for task_type | 3h | task_type field | 📋 Ready |
| **P3** | Add MCP search tool | 2h | Search endpoint | 📋 Ready |
| **P3** | Update routing logic | 2h | executor_type | 📋 Ready |
| **P4** | Memory items CRUD endpoints | 4h | memory_items table | 📋 Ready |
| **P4** | Entity detection service | 6h | Memory endpoints | 📋 Planned |
| **P5** | Vectorize setup + embeddings | 4h | AI binding | 📋 Planned |
| **P5** | Hybrid search merger | 4h | Vectorize + FTS5 | 📋 Planned |
| **P6** | Mnemo cache layer | 8h | Entity detection | 📋 Planned |

---

### 9.7 Architecture Decision Records (Updated)

#### ADR-001: Dual Execution Paths (REVISED)
**Status:** ✅ Accepted (both paths are valid)

**Context:** Initially thought the dual paths were a problem.

**Decision:** Keep both paths as intentional:
- IntakeClient for cron-based batch dispatch
- HTTP for real-time MCP dispatch with callbacks

**Rationale:** Service bindings can't trigger cross-worker workflows with callbacks.

---

#### ADR-006: D1 FTS5 as Primary Search
**Status:** Proposed

**Context:** Need search capabilities across entities.

**Decision:** Use D1 FTS5 virtual tables for keyword search, with Vectorize as future enhancement.

**Consequences:**
- (+) No external dependencies
- (+) Good performance for current scale
- (+) Native D1 integration
- (-) Keyword-only until Vectorize added

---

#### ADR-007: Nexus Controls Memory Loading
**Status:** Proposed

**Context:** Mnemo integration design question - who decides what context to load?

**Decision:** Nexus (the brain) makes all context-loading decisions. Mnemo is a dumb cache.

**Rationale:** Centralized decision-making in Nexus simplifies architecture and ensures consistent context policies.

---

## Summary: 2025-12-30 Workshop Output

1. **Integration Strategy:** ✅ Finalized - dual execution paths are intentional
2. **Service Contracts:** ✅ Documented for all inter-service communication
3. **Search Architecture:** ✅ D1 FTS5 phase 1, Vectorize phase 2 planned
4. **Executor Taxonomy:** ✅ Standardized to ai/human/human-ai
5. **Task Types:** ✅ Defined 6 formal types with routing rules
6. **Data Flows:** ✅ Sequence diagrams for all major patterns
7. **Mnemo Design:** ✅ Cache architecture with Nexus control
8. **Implementation Roadmap:** ✅ Prioritized with effort estimates

---

*Last updated: 2025-12-30 - Architecture Design Workshop Session 2*

---

## 10. Final Architecture Workshop Session: 2025-12-30

### Session 3: Implementation Gap Analysis & Final Decisions

This session validates the architecture decisions against the current codebase implementation and produces concrete implementation tasks.

---

### 10.1 Implementation Status Audit

#### ✅ Already Implemented

| Component | Location | Status |
|-----------|----------|--------|
| Notes FTS5 | `migrations/0017_add_notes_fts.sql` | ✅ Complete with triggers |
| Executor Type Simplification | `migrations/0011_simplify_executor_types.sql` | ✅ `ai`, `human`, `human-ai` |
| Memory Items Schema | `migrations/0016_add_memory_items_table.sql` | ✅ Full schema with tags/environments |
| Task Dependencies | `migrations/0012_task_dependencies.sql` | ✅ Dependency tracking |
| Dual Execution Paths | `src/index.ts`, `src/mcp/index.ts` | ✅ IntakeClient + HTTP both working |
| Workflow Callbacks | `/workflow-callback` endpoint | ✅ Task completion/failure handling |
| Dependent Task Promotion | `promoteDependentTasks()` | ✅ Auto-triggers next tasks |
| 40+ MCP Tools | `src/mcp/index.ts` | ✅ Comprehensive toolset |
| AI Classification | `src/lib/classifier.ts` | ✅ Via DE Text-Gen |

#### 🔴 Not Yet Implemented

| Component | Gap | Priority |
|-----------|-----|----------|
| Tasks FTS5 | No FTS table for tasks | P1 |
| Ideas FTS5 | No FTS table for ideas | P1 |
| Projects FTS5 | No FTS table for projects | P1 |
| Unified `/api/search` | No cross-entity search endpoint | P1 |
| `task_type` field | Tasks table lacks formal task type | P2 |
| MCP Search Tool | No `nexus_search` MCP tool | P2 |
| Classifier Task Type | Classifier doesn't output task_type | P3 |
| Entity Detection | No AMM/entity detection service | P4 |
| Mnemo Cache | No working memory cache layer | P5 |

---

### 10.2 Critical Decision: Encrypted Field Search

**Problem Identified:** The notes FTS migration operates on encrypted data. Full-text search on encrypted fields will not produce useful results because:
1. Encrypted content is base64-encoded ciphertext
2. FTS5 will index gibberish, not actual content
3. Search queries won't match encrypted text

**Analysis of Current Implementation:**
```sql
-- Migration 0017 indexes encrypted fields!
INSERT INTO notes_fts(rowid, title, content, tags)
SELECT rowid,
       COALESCE(title, ''),      -- This is encrypted!
       COALESCE(content, ''),    -- This is encrypted!
       COALESCE(tags, '')        -- tags is NOT encrypted
FROM notes WHERE deleted_at IS NULL;
```

**ADR-008: Search on Encrypted Data**

**Status:** Approved

**Context:** All sensitive content (titles, descriptions) is encrypted at the application layer before storage. D1 FTS5 cannot search encrypted content meaningfully.

**Decision:** Implement a hybrid search strategy:

1. **Unencrypted Metadata Search (Immediate)**
   - FTS5 on non-sensitive fields: `tags`, `domain`, `status`, `category`
   - These fields provide sufficient filtering for most use cases

2. **Application-Layer Search (Current)**
   - Continue using post-decryption filtering (like `notes.ts:58-83`)
   - Works well for small-medium datasets (<10K items per user)

3. **Searchable Encryption (Future)**
   - If scale requires, implement searchable encryption or keyword-blind indexing
   - Store encrypted keyword hashes for deterministic search
   - More complex, defer unless needed

**Consequences:**
- (+) Security maintained - encrypted content stays encrypted
- (+) Existing approach works for current scale
- (-) FTS5 limited to metadata fields
- (-) Full-text on content requires decrypt + filter

**Immediate Action:** Create FTS tables for tasks/ideas/projects on **unencrypted fields only**:
- `tasks_fts`: tags, domain, status, contexts
- `ideas_fts`: tags, domain, category
- `projects_fts`: tags, domain, status

---

### 10.3 Revised Search Architecture

Given the encryption constraint, the search architecture is updated:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    HYBRID SEARCH ARCHITECTURE                        │
│                    (Encryption-Aware)                                │
└─────────────────────────────────────────────────────────────────────┘

Search Request → /api/search?q=keyword&types=task,note
                    │
                    ├──────────────────────────────────────────────┐
                    │                                              │
                    ▼                                              ▼
         ┌─────────────────────┐               ┌─────────────────────────┐
         │ PHASE 1: FTS5       │               │ PHASE 2: Decrypt+Filter │
         │ (Metadata)          │               │ (Encrypted Content)     │
         │                     │               │                         │
         │ - tags              │               │ - title                 │
         │ - domain            │               │ - description           │
         │ - status            │               │ - content               │
         │ - category          │               │                         │
         │ - contexts          │               │ (Only if needed)        │
         └─────────┬───────────┘               └───────────┬─────────────┘
                   │                                       │
                   │ Fast: ~1-5ms                          │ Slower: ~50-200ms
                   │                                       │
                   ▼                                       ▼
         ┌─────────────────────────────────────────────────────────────┐
         │                    Result Merger                             │
         │  - Combine results                                           │
         │  - Rank by relevance                                         │
         │  - Apply pagination                                          │
         └─────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌─────────────────────┐
                    │   Search Results    │
                    └─────────────────────┘
```

**Search Mode Options:**
- `mode: 'fast'` - FTS5 metadata only (default)
- `mode: 'full'` - FTS5 + decrypt content search (slower)

---

### 10.4 Final Implementation Roadmap

#### Sprint 1: Search Foundation (Priority 1)

**Task 1.1: Create FTS5 Tables for Tasks/Ideas/Projects**
- File: `migrations/0018_add_entity_fts.sql`
- Tables: `tasks_fts`, `ideas_fts`, `projects_fts`
- Fields: Unencrypted metadata only (tags, domain, status, etc.)
- Effort: 2 hours

**Task 1.2: Implement Unified Search Endpoint**
- File: `src/routes/search.ts`
- Endpoint: `GET /api/search`
- Features: Multi-entity search, FTS5 queries, result merging
- Effort: 4 hours

**Task 1.3: Add MCP Search Tool**
- File: `src/mcp/index.ts`
- Tool: `nexus_search`
- Description: Search across all entities from Claude.ai/Code
- Effort: 2 hours

#### Sprint 2: Task Type Classification (Priority 2)

**Task 2.1: Add task_type Field to Tasks**
- File: `migrations/0019_add_task_type.sql`
- Values: `code`, `research`, `content`, `outreach`, `review`, `decision`
- Effort: 1 hour

**Task 2.2: Update Classifier to Output task_type**
- File: `src/lib/classifier.ts`
- Logic: Infer task_type from content analysis
- Effort: 2 hours

**Task 2.3: Update Routing Logic**
- Files: `src/scheduled/task-dispatcher.ts`, `src/lib/routing.ts`
- Logic: Route by task_type instead of title prefix matching
- Effort: 3 hours

#### Sprint 3: Memory/Context Enhancement (Priority 3)

**Task 3.1: Memory Items CRUD Endpoints**
- File: `src/routes/memory.ts`
- Endpoints: CRUD for memory_items table
- Effort: 4 hours

**Task 3.2: Memory MCP Tools**
- File: `src/mcp/index.ts`
- Tools: `nexus_remember`, `nexus_recall`, `nexus_forget`
- Effort: 3 hours

#### Sprint 4: Future (Priority 4+)

- Entity Detection Service
- Mnemo Cache Layer
- Vectorize Semantic Search
- Bridge Development

---

### 10.5 Encryption Audit

**Encrypted Fields by Entity:**

| Table | Encrypted Fields | Unencrypted Fields |
|-------|------------------|-------------------|
| `tasks` | title, description | tags, domain, status, contexts, urgency, importance |
| `ideas` | title, description | tags, domain, category, excitement_level, feasibility |
| `projects` | name, description, objective | tags, domain, status, health |
| `notes` | title, content | tags, category, source_type |
| `people` | name, email, phone, notes | relationship, organization |
| `memory_items` | content, summary | memory_type, scope, tags, categories |

**Implication:** FTS5 indexes must be created on unencrypted columns only.

---

### 10.6 Updated ADR Summary

| ADR | Decision | Status |
|-----|----------|--------|
| ADR-001 | Dual Execution Paths (IntakeClient + HTTP) | ✅ Accepted |
| ADR-002 | Hybrid Search (FTS5 + Vectorize) | ✅ Accepted |
| ADR-003 | Simplified Executor Types (ai/human/human-ai) | ✅ Implemented |
| ADR-004 | Task Type Taxonomy (6 types) | ⏳ Pending Implementation |
| ADR-005 | Callback-Based Workflows | ✅ Implemented |
| ADR-006 | D1 FTS5 as Primary Search | ✅ Accepted |
| ADR-007 | Nexus Controls Memory Loading | ✅ Accepted |
| ADR-008 | Search on Encrypted Data (Metadata Only) | ✅ Accepted |

---

### 10.7 Session 3 Conclusions

1. **Encryption Constraint Identified:** FTS5 cannot meaningfully search encrypted content. Design updated to search metadata fields only.

2. **Implementation Status Clear:**
   - Core execution pipeline: ✅ Complete
   - Search infrastructure: 🔴 Not implemented
   - Task type routing: 🔴 Not implemented
   - Memory system: 🟡 Schema exists, no API

3. **Priority Order Validated:**
   1. Search endpoint (high user value, foundation for MCP)
   2. Task type classification (enables smarter routing)
   3. Memory CRUD (enables persistent context)
   4. Entity detection (enables proactive context loading)

4. **Next Immediate Actions:**
   - Create migration 0018 for entity FTS tables
   - Implement `/api/search` endpoint
   - Add `nexus_search` MCP tool

---

---

## 11. Final Workshop Session: 2025-12-30 (Session 4)

### Session Objective: Architecture Validation & Implementation Handoff

This final session validates all architectural decisions against the current implementation, confirms the encryption strategy, and produces a complete implementation handoff document.

---

### 11.1 Architecture Validation Checklist

#### ✅ Confirmed Architectural Decisions

| Decision | Status | Validation |
|----------|--------|------------|
| **Dual Execution Paths** | ✅ Validated | IntakeClient (cron) + HTTP (MCP) both working correctly |
| **Executor Type Simplification** | ✅ Implemented | Migration 0011 - `ai`, `human`, `human-ai` in production |
| **Notes FTS5 with search_text** | ✅ Implemented | Migration 0018 - Fixes encryption issue correctly |
| **Memory Items Schema** | ✅ Implemented | Migration 0016 - Complete schema with tags/environments |
| **Task Dependencies** | ✅ Implemented | Migration 0012 - Dependency tracking with promotion |
| **Callback-Based Workflows** | ✅ Implemented | `/workflow-callback` endpoint operational |
| **Cloudflare Access Auth** | ✅ Implemented | JWT validation + dev token fallback |
| **Service Binding Pattern** | ✅ Implemented | DE, INTAKE, SANDBOX_EXECUTOR bindings active |

#### 🔴 Confirmed Implementation Gaps

| Gap | Priority | Estimated Effort | Dependencies |
|-----|----------|------------------|--------------|
| `task_type` field in tasks table | P1 | 1h | None |
| Cross-entity FTS5 tables (tasks, ideas, projects) | P1 | 2h | None |
| Unified `/api/search` endpoint | P1 | 4h | FTS5 tables |
| `nexus_search` MCP tool (cross-entity) | P2 | 2h | Search endpoint |
| Classifier task_type output | P2 | 3h | task_type field |
| Memory items CRUD API | P3 | 4h | None |
| Memory MCP tools | P3 | 3h | Memory API |
| Entity detection service (AMM) | P4 | 8h | Memory system |
| Mnemo cache layer | P5 | 12h | Entity detection |

---

### 11.2 Encryption Strategy - Finalized

**ADR-008 Implementation Details:**

The encryption strategy is now fully validated:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    ENCRYPTION-AWARE SEARCH STRATEGY                      │
└─────────────────────────────────────────────────────────────────────────┘

ENCRYPTED FIELDS (AES-256-GCM at application layer):
├── tasks: title, description
├── ideas: title, description
├── projects: name, description, objective
├── notes: title, content → search_text (plaintext for FTS)
├── people: name, email, phone, notes
└── memory_items: content, summary

UNENCRYPTED FIELDS (Searchable via FTS5):
├── tasks: tags, domain, status, contexts, urgency, importance
├── ideas: tags, domain, category, excitement_level, feasibility
├── projects: tags, domain, status, health
├── notes: tags, category, source_type, search_text
└── memory_items: memory_type, scope, tags, categories, environments

SEARCH APPROACH:
1. FTS5 on unencrypted metadata fields (fast, ~1-5ms)
2. Application-level decrypt+filter for content search (slower, ~50-200ms)
3. Notes use search_text pattern for full-text on plaintext copy
```

**Why This Works:**
- Security is preserved - all PII/sensitive data remains encrypted at rest
- Metadata search handles 90%+ of use cases (filter by tags, domain, status)
- Full content search available when needed via decrypt+filter
- Notes pattern can be extended to other entities if content search demand grows

---

### 11.3 Search Architecture - Final Design

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        SEARCH REQUEST FLOW                               │
└─────────────────────────────────────────────────────────────────────────┘

GET /api/search?q=keyword&types=task,idea,note&mode=fast
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         SEARCH ROUTER                                    │
│                                                                          │
│  mode=fast (default):                                                   │
│    └── FTS5 metadata search only → Return immediately                  │
│                                                                          │
│  mode=full:                                                              │
│    ├── FTS5 metadata search (parallel)                                  │
│    └── Decrypt + content filter (parallel)                              │
│    └── Merge results → Return                                           │
│                                                                          │
│  Entity-specific routing:                                                │
│    ├── notes: Uses notes_fts (search_text column)                       │
│    ├── tasks: Uses tasks_fts (tags, domain, status, contexts)           │
│    ├── ideas: Uses ideas_fts (tags, domain, category)                   │
│    └── projects: Uses projects_fts (tags, domain, status)               │
└─────────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        RESPONSE                                          │
│  {                                                                       │
│    "success": true,                                                      │
│    "data": [                                                             │
│      { "entity_type": "task", "id": "...", "snippet": "...", ... },    │
│      { "entity_type": "note", "id": "...", "snippet": "...", ... }     │
│    ],                                                                    │
│    "meta": { "query": "keyword", "mode": "fast", "took_ms": 12 }       │
│  }                                                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### 11.4 Task Type Classification - Final Design

**Task Type Enum Values:**

| Type | Description | Default Executor | Execution Path |
|------|-------------|------------------|----------------|
| `code` | Code generation, modification, deployment | `ai` | IntakeClient → CodeExecution |
| `research` | Information gathering, analysis | `ai` | DE Text-Gen (future: ResearchLoop) |
| `content` | Writing, documentation, content creation | `ai` | DE Text-Gen (future: ContentLoop) |
| `outreach` | Communication, email, networking | `human-ai` | Dashboard + AI suggestions |
| `review` | Requires human judgment/approval | `human` | Dashboard queue |
| `decision` | CEO/owner decision required | `human` | Dashboard priority queue |

**Routing Logic Pseudocode:**

```typescript
function getExecutorType(task: Task): ExecutorType {
  // 1. Explicit executor override takes precedence
  if (task.executor_type) return task.executor_type;

  // 2. Route by task_type
  const routing: Record<TaskType, ExecutorType> = {
    'code': 'ai',
    'research': 'ai',
    'content': 'ai',
    'outreach': 'human-ai',
    'review': 'human',
    'decision': 'human'
  };

  if (task.task_type && routing[task.task_type]) {
    return routing[task.task_type];
  }

  // 3. Fallback: classify from title/description
  return classifyFromContent(task.title, task.description);
}
```

---

### 11.5 Data Flow Validation

All documented data flows have been validated against implementation:

| Flow | Documented | Implemented | Status |
|------|------------|-------------|--------|
| Capture → Classification → Entity | ✅ | ✅ | Working |
| Idea → Planning → Task Generation | ✅ | ✅ | Working |
| Task Cron Dispatch → IntakeClient → PrimeWorkflow | ✅ | ✅ | Working |
| MCP Task Creation → HTTP → PrimeWorkflow | ✅ | ✅ | Working |
| Workflow Completion → Callback → Task Update | ✅ | ✅ | Working |
| Dependent Task Promotion | ✅ | ✅ | Working |
| Notes FTS5 Search | ✅ | ✅ | Working |

---

### 11.6 Implementation Handoff Specification

#### Sprint 1: Search Foundation (Week 1)

**Migration 0019: Add Entity FTS Tables**

```sql
-- File: migrations/0019_add_entity_fts.sql

-- Tasks FTS (metadata only - encrypted fields excluded)
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
    task_id UNINDEXED,
    tags,
    domain,
    status,
    contexts,
    tokenize='porter unicode61'
);

-- Ideas FTS (metadata only)
CREATE VIRTUAL TABLE IF NOT EXISTS ideas_fts USING fts5(
    idea_id UNINDEXED,
    tags,
    domain,
    category,
    tokenize='porter unicode61'
);

-- Projects FTS (metadata only)
CREATE VIRTUAL TABLE IF NOT EXISTS projects_fts USING fts5(
    project_id UNINDEXED,
    tags,
    domain,
    status,
    tokenize='porter unicode61'
);
```

**New Route: `/api/search`**

```typescript
// File: src/routes/search.ts
// Unified search endpoint across all entities
// Supports: q, types, mode, domain, status, limit, offset
// Returns: Merged, ranked results with snippets
```

**MCP Tool: `nexus_search`**

```typescript
// Add to src/mcp/index.ts
// Tool: nexus_search
// Description: Search across tasks, ideas, notes, and projects
// Parameters: query, types?, mode?, limit?
```

#### Sprint 2: Task Type Classification (Week 2)

**Migration 0020: Add task_type Field**

```sql
-- File: migrations/0020_add_task_type.sql

ALTER TABLE tasks ADD COLUMN task_type TEXT;
-- Valid values: 'code', 'research', 'content', 'outreach', 'review', 'decision'

CREATE INDEX IF NOT EXISTS idx_tasks_task_type ON tasks(tenant_id, task_type);

-- Update existing tasks based on title patterns (optional)
UPDATE tasks SET task_type = 'code'
WHERE title LIKE '[implement]%' OR title LIKE '[fix]%' OR title LIKE '[deploy]%';
```

**Classifier Update**

```typescript
// Update src/lib/classifier.ts
// Add task_type inference to classification output
// Use LLM to classify: code, research, content, outreach, review, decision
```

**Routing Update**

```typescript
// Update src/scheduled/task-dispatcher.ts
// Use task_type for executor routing instead of title prefix matching
```

---

### 11.7 Success Criteria

The architecture workshop is complete when:

1. ✅ All 8 ADRs are documented and accepted
2. ✅ Encryption strategy is validated and documented
3. ✅ Search architecture is designed with encryption awareness
4. ✅ Task type taxonomy is defined with routing rules
5. ✅ All data flows are validated against implementation
6. ✅ Implementation handoff specification is complete
7. ⏳ Sprint 1 implementation begins (Search Foundation)

---

### 11.8 Architecture Workshop Summary

| Aspect | Status | Key Decisions |
|--------|--------|---------------|
| **Integration Strategy** | ✅ Finalized | Dual execution paths (IntakeClient + HTTP) |
| **Data Flow** | ✅ Validated | All flows implemented and working |
| **Search Routing** | ✅ Designed | FTS5 metadata + decrypt+filter for content |
| **Executor Types** | ✅ Implemented | ai, human, human-ai |
| **Task Types** | ⏳ Ready | 6 types defined, awaiting implementation |
| **Encryption** | ✅ Validated | ADR-008 approach confirmed |
| **Memory/Context** | ⏳ Planned | Schema exists, API needed |

**Total ADRs:** 8 (all accepted)
**Implementation Gaps:** 9 items identified with effort estimates
**Next Sprint:** Search Foundation (8h total effort)

---

*Workshop Complete: 2025-12-30*
*All architectural decisions finalized and documented.*
*Implementation roadmap ready for execution.*
