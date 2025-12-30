# AI Architecture Design Workshop

## Executive Summary

This document defines the integration architecture for the AI-powered productivity system, establishing the data flow patterns, search routing logic, and integration strategy across the existing infrastructure.

---

## 1. Current State Analysis

### 1.1 Existing Infrastructure

| Component | Purpose | Status |
|-----------|---------|--------|
| **Nexus** | Central orchestration layer (Tier 1 processing, memory, coordination) | 90% complete |
| **Developer Guides MCP** | Searchable knowledge base with FTS5 + Vectorize | 85% complete |
| **Claude Sandbox** | Isolated code execution environment | 80% complete |
| **Spark MCP** | DGX Spark environment health/monitoring | 70% complete |
| **Distributed Electrons (DE)** | LLM routing with Claude → Gemini fallover | External binding |

### 1.2 Existing Data Stores

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         DATA LAYER INVENTORY                            │
├─────────────────────────────────────────────────────────────────────────┤
│  D1 DATABASES                                                           │
│  ├── nexus-db: Tasks, projects, ideas, inbox, people, commitments       │
│  ├── developer-guides-db: Guides, sections, relationships               │
│  └── (future) mnemo-db: Long-term memory, context cache                 │
│                                                                         │
│  R2 BUCKETS                                                             │
│  ├── developer-guides: Markdown files for guides                        │
│  └── (future) nexus-artifacts: Execution outputs, attachments           │
│                                                                         │
│  VECTORIZE INDEXES                                                      │
│  ├── developer-guides-index: Semantic search for guides                 │
│  └── (future) nexus-memory-index: Semantic search for memory items      │
│                                                                         │
│  DURABLE OBJECTS                                                        │
│  ├── InboxManager: Routing and classification state                     │
│  ├── CaptureBuffer: Rapid capture buffering                             │
│  ├── SyncManager: Cross-device sync coordination                        │
│  ├── UserSession: Session state management                              │
│  └── IdeaExecutor: Execution state machines                             │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.3 Existing AI Integration Points

1. **LLM Operations** → Routed through DE service binding (never direct)
2. **Classification** → Claude via DE for inbox item classification
3. **Execution** → Task executor dispatches to claude-code, claude-ai, de-agent, or human
4. **Semantic Search** → Vectorize for guide embeddings

---

## 2. Target Architecture

### 2.1 High-Level Architecture Diagram

```
                                    ┌─────────────────┐
                                    │   USER LAYER    │
                                    ├─────────────────┤
                                    │ • Claude.ai     │
                                    │ • CLI (Claude   │
                                    │   Code)         │
                                    │ • Qwik UI       │
                                    │ • Voice (future)│
                                    └────────┬────────┘
                                             │
                         ┌───────────────────┴───────────────────┐
                         │           MCP GATEWAY LAYER           │
                         ├───────────────────────────────────────┤
                         │                                       │
           ┌─────────────┴─────────────┐   ┌─────────────────────┴───────────┐
           │      NEXUS MCP            │   │    DEVELOPER GUIDES MCP        │
           ├───────────────────────────┤   ├─────────────────────────────────┤
           │ • nexus_create_task       │   │ • search_developer_guides       │
           │ • nexus_plan_idea         │   │ • get_guide                     │
           │ • nexus_execute_idea      │   │ • list_guides                   │
           │ • nexus_list_tasks        │   │ • get_related_guides            │
           │ • nexus_search            │   │ • propose_guide_change          │
           │ • nexus_log_decision      │   │ • get_guide_stats               │
           └─────────────┬─────────────┘   └─────────────────────┬───────────┘
                         │                                       │
                         └───────────────────┬───────────────────┘
                                             │
                    ┌────────────────────────┴────────────────────────┐
                    │              ORCHESTRATION LAYER               │
                    ├────────────────────────────────────────────────┤
                    │                    NEXUS                        │
                    │  ┌──────────────────────────────────────────┐  │
                    │  │           DURABLE OBJECTS                │  │
                    │  │  InboxManager  CaptureBuffer  SyncManager │  │
                    │  │  UserSession   IdeaExecutor              │  │
                    │  └──────────────────────────────────────────┘  │
                    │                                                 │
                    │  ┌──────────────────────────────────────────┐  │
                    │  │           CLOUDFLARE WORKFLOWS           │  │
                    │  │  IdeaToPlan  TaskExecutor  IdeaExecution │  │
                    │  └──────────────────────────────────────────┘  │
                    └────────────────────────┬────────────────────────┘
                                             │
          ┌──────────────────────────────────┼──────────────────────────────────┐
          │                                  │                                  │
          ▼                                  ▼                                  ▼
┌─────────────────────┐         ┌─────────────────────┐         ┌─────────────────────┐
│   SEARCH ROUTER     │         │   EXECUTION LAYER   │         │   MEMORY LAYER      │
├─────────────────────┤         ├─────────────────────┤         ├─────────────────────┤
│ • Unified Search API│         │ • Claude Sandbox    │         │ • D1 (structured)   │
│ • FTS5 (text)       │         │ • DE Agent          │         │ • R2 (artifacts)    │
│ • Vectorize (semantic)        │ • External APIs     │         │ • Vectorize (embed) │
│ • Intent Detection  │         │ • Human handoff     │         │ • KV (cache)        │
└─────────────────────┘         └─────────────────────┘         └─────────────────────┘
          │                                  │                                  │
          └──────────────────────────────────┼──────────────────────────────────┘
                                             │
                              ┌──────────────┴──────────────┐
                              │     LLM ROUTING LAYER       │
                              ├─────────────────────────────┤
                              │  DISTRIBUTED ELECTRONS (DE) │
                              │  • Primary: Claude API      │
                              │  • Fallback: Gemini API     │
                              │  • Local: Nemotron/vLLM     │
                              └─────────────────────────────┘
```

### 2.2 Component Responsibilities

#### 2.2.1 MCP Gateway Layer
- **Single entry point** for AI assistants (Claude.ai, Claude Code)
- **Tool discovery** via MCP protocol
- **Authentication** via passphrase or Cloudflare Access
- **Rate limiting** and quota management

#### 2.2.2 Orchestration Layer (Nexus)
- **Unified state management** via Durable Objects
- **Workflow orchestration** for multi-step operations
- **Event routing** to appropriate handlers
- **Cross-service coordination**

#### 2.2.3 Search Router
- **Unified search interface** across all data sources
- **Intent detection** to route to appropriate search method
- **Result aggregation** and ranking
- **Cache management** for hot queries

#### 2.2.4 Execution Layer
- **Task dispatch** to appropriate executor
- **Isolated execution** via Sandbox SDK
- **Progress tracking** and result capture
- **Failure recovery** and retry logic

#### 2.2.5 Memory Layer
- **Structured storage** (D1) for entities
- **Object storage** (R2) for large artifacts
- **Vector embeddings** (Vectorize) for semantic queries
- **Fast cache** (KV) for hot data

#### 2.2.6 LLM Routing Layer
- **Automatic fallover** Claude → Gemini
- **Local inference** option via Nemotron/vLLM
- **Cost optimization** routing based on task complexity
- **Token tracking** and budget management

---

## 3. Data Flow Patterns

### 3.1 Capture Flow

```
┌─────────┐      ┌───────────────┐      ┌────────────────┐      ┌─────────────┐
│ User    │ ──▶  │ Capture       │ ──▶  │ CaptureBuffer  │ ──▶  │ InboxManager│
│ Input   │      │ Endpoint      │      │ (Durable Obj)  │      │ (Durable Obj│
└─────────┘      └───────────────┘      └────────────────┘      └──────┬──────┘
                                                                       │
                                        ┌──────────────────────────────┘
                                        │
                                        ▼
                               ┌─────────────────┐
                               │ AI Classification│
                               │ (via DE → Claude)│
                               └────────┬────────┘
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              │                         │                         │
              ▼                         ▼                         ▼
     ┌────────────────┐      ┌────────────────┐      ┌────────────────┐
     │ Task Created   │      │ Idea Captured  │      │ Note Stored    │
     │ (≥80% conf)    │      │ (with metadata)│      │ (with FTS)     │
     └────────────────┘      └────────────────┘      └────────────────┘
```

### 3.2 Execution Flow

```
┌─────────────┐      ┌─────────────────┐      ┌─────────────────┐
│ Idea/Task   │ ──▶  │ IdeaToPlanFlow  │ ──▶  │ Execution Queue │
│ Submitted   │      │ (generate tasks)│      │ (D1 table)      │
└─────────────┘      └─────────────────┘      └────────┬────────┘
                                                       │
                                        ┌──────────────┘
                                        │ Cron: every 15 min
                                        ▼
                               ┌─────────────────┐
                               │ Task Dispatcher │
                               │ (determine type)│
                               └────────┬────────┘
                                        │
          ┌─────────────────────────────┼─────────────────────────────┐
          │                             │                             │
          ▼                             ▼                             ▼
┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
│ claude-code         │     │ de-agent            │     │ human               │
│ (Claude Sandbox)    │     │ (DE service bind)   │     │ (manual execution)  │
└──────────┬──────────┘     └──────────┬──────────┘     └──────────┬──────────┘
           │                           │                           │
           └───────────────────────────┼───────────────────────────┘
                                       │
                                       ▼
                              ┌─────────────────┐
                              │ Result Callback │
                              │ → Nexus API     │
                              └────────┬────────┘
                                       │
                                       ▼
                              ┌─────────────────┐
                              │ Update Task     │
                              │ Trigger Deps    │
                              └─────────────────┘
```

### 3.3 Search Flow

```
┌─────────────┐      ┌─────────────────┐      ┌─────────────────┐
│ Search      │ ──▶  │ Intent          │ ──▶  │ Query Router    │
│ Query       │      │ Classifier      │      │                 │
└─────────────┘      └─────────────────┘      └────────┬────────┘
                                                       │
              ┌────────────────────────────────────────┼────────────────────────────────────────┐
              │                                        │                                        │
              ▼                                        ▼                                        ▼
     ┌─────────────────┐                     ┌─────────────────┐                     ┌─────────────────┐
     │ Full-Text Search│                     │ Semantic Search │                     │ Structured Query│
     │ (FTS5)          │                     │ (Vectorize)     │                     │ (SQL)           │
     ├─────────────────┤                     ├─────────────────┤                     ├─────────────────┤
     │ • Tasks table   │                     │ • guides-index  │                     │ • Filter by     │
     │ • Notes FTS     │                     │ • memory-index  │                     │   status/date   │
     │ • Guides FTS    │                     │ • task-embed    │                     │ • Join queries  │
     └────────┬────────┘                     └────────┬────────┘                     └────────┬────────┘
              │                                        │                                        │
              └────────────────────────────────────────┼────────────────────────────────────────┘
                                                       │
                                                       ▼
                                              ┌─────────────────┐
                                              │ Result Merger   │
                                              │ & Ranker        │
                                              └────────┬────────┘
                                                       │
                                                       ▼
                                              ┌─────────────────┐
                                              │ Unified Results │
                                              │ (ranked, dedup) │
                                              └─────────────────┘
```

---

## 4. Search Routing Logic

### 4.1 Intent Classification

```typescript
type SearchIntent =
  | 'keyword'      // Exact match, FTS5 only
  | 'semantic'     // Conceptual search, Vectorize
  | 'structured'   // Filter by attributes, SQL
  | 'hybrid'       // Combine FTS5 + Vectorize

interface SearchRequest {
  query: string;
  intent?: SearchIntent;       // If not provided, auto-detect
  sources?: SearchSource[];    // Limit to specific sources
  filters?: SearchFilters;     // Structured filters
  limit?: number;
  offset?: number;
}

interface SearchSource {
  type: 'tasks' | 'ideas' | 'notes' | 'guides' | 'memory' | 'all';
  weight?: number;  // Ranking weight for this source
}
```

### 4.2 Intent Detection Algorithm

```typescript
function detectSearchIntent(query: string): SearchIntent {
  // Rule 1: Quoted strings = keyword search
  if (/^".*"$/.test(query.trim())) {
    return 'keyword';
  }

  // Rule 2: Filter syntax = structured search
  if (/\w+:\w+/.test(query)) {
    return 'structured';
  }

  // Rule 3: Question words = semantic search
  if (/^(what|how|why|when|where|who|which|can|should)/i.test(query)) {
    return 'semantic';
  }

  // Rule 4: Short queries (1-2 words) = keyword search
  if (query.trim().split(/\s+/).length <= 2) {
    return 'keyword';
  }

  // Rule 5: Long natural language = hybrid
  return 'hybrid';
}
```

### 4.3 Search Source Selection

```typescript
function selectSearchSources(query: string, intent: SearchIntent): SearchSource[] {
  const sources: SearchSource[] = [];

  // Technical terms → Developer Guides high weight
  if (/\b(api|function|class|error|bug|code|deploy|config)\b/i.test(query)) {
    sources.push({ type: 'guides', weight: 1.5 });
    sources.push({ type: 'notes', weight: 1.0 });
  }

  // Action words → Tasks high weight
  if (/\b(todo|task|do|finish|complete|done|pending)\b/i.test(query)) {
    sources.push({ type: 'tasks', weight: 1.5 });
    sources.push({ type: 'ideas', weight: 1.0 });
  }

  // Conceptual queries → Ideas and Memory
  if (intent === 'semantic') {
    sources.push({ type: 'ideas', weight: 1.2 });
    sources.push({ type: 'memory', weight: 1.2 });
  }

  // Default: search all with equal weight
  if (sources.length === 0) {
    return [
      { type: 'tasks', weight: 1.0 },
      { type: 'ideas', weight: 1.0 },
      { type: 'notes', weight: 1.0 },
      { type: 'guides', weight: 1.0 },
      { type: 'memory', weight: 1.0 },
    ];
  }

  return sources;
}
```

### 4.4 Result Ranking

```typescript
interface RankedResult {
  source: string;
  id: string;
  title: string;
  snippet: string;
  score: number;       // Normalized 0-1
  relevance: number;   // From search engine
  recency: number;     // Based on updated_at
  importance: number;  // Based on metadata (priority, energy, etc.)
}

function rankResults(results: RankedResult[]): RankedResult[] {
  return results
    .map(r => ({
      ...r,
      score: (
        r.relevance * 0.5 +    // 50% relevance from search
        r.recency * 0.3 +      // 30% recency
        r.importance * 0.2     // 20% importance metadata
      )
    }))
    .sort((a, b) => b.score - a.score);
}
```

---

## 5. Integration Strategy

### 5.1 Phase 1: Foundation (Current Sprint)

**Goals:**
- Finalize unified search API design
- Implement intent detection
- Add FTS5 indexes to Nexus (tasks, ideas)
- Create Vectorize index for Nexus memory

**Deliverables:**
1. `GET /api/search` - Unified search endpoint in Nexus
2. `nexus_search` MCP tool with intent parameter
3. FTS5 virtual tables for tasks and ideas
4. Vectorize index for memory items

### 5.2 Phase 2: Cross-Service Search

**Goals:**
- Enable Nexus to search Developer Guides
- Enable bidirectional search aggregation
- Implement result caching (KV)

**Deliverables:**
1. Service binding: Nexus → Developer Guides MCP
2. Aggregated search results in single response
3. KV cache for hot queries (5-minute TTL)

### 5.3 Phase 3: Memory Enhancement

**Goals:**
- Implement Mnemo long-term memory
- Add context caching for conversations
- Enable semantic memory retrieval

**Deliverables:**
1. `mnemo-db` D1 database with memory schema
2. `nexus-memory-index` Vectorize index
3. Memory CRUD API in Nexus
4. Automatic memory extraction from completed tasks

### 5.4 Phase 4: Advanced Routing

**Goals:**
- LLM-based intent classification for ambiguous queries
- Personalized result ranking
- Query expansion and synonyms

**Deliverables:**
1. LLM classifier via DE for complex queries
2. User preference learning from clicks/selections
3. Query expansion using embeddings

---

## 6. API Specifications

### 6.1 Unified Search API

```typescript
// POST /api/search
interface SearchRequestBody {
  query: string;
  intent?: 'keyword' | 'semantic' | 'structured' | 'hybrid';
  sources?: ('tasks' | 'ideas' | 'notes' | 'guides' | 'memory')[];
  filters?: {
    status?: string[];
    project_id?: string;
    date_range?: { start: string; end: string };
    tags?: string[];
    priority?: string[];
  };
  limit?: number;       // Default: 20, Max: 100
  offset?: number;      // For pagination
  include_snippets?: boolean;  // Include context snippets
}

interface SearchResponse {
  results: SearchResult[];
  total: number;
  intent_detected: string;
  sources_searched: string[];
  query_time_ms: number;
}

interface SearchResult {
  source: 'tasks' | 'ideas' | 'notes' | 'guides' | 'memory';
  id: string;
  title: string;
  snippet?: string;
  score: number;
  metadata: {
    status?: string;
    project?: string;
    created_at: string;
    updated_at: string;
  };
  url?: string;  // Deep link to item
}
```

### 6.2 MCP Tool Specification

```typescript
// nexus_search MCP tool
{
  name: 'nexus_search',
  description: 'Search across all Nexus data: tasks, ideas, notes, guides, and memory',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (natural language or keywords)'
      },
      intent: {
        type: 'string',
        enum: ['keyword', 'semantic', 'structured', 'hybrid', 'auto'],
        description: 'Search intent (auto-detected if not specified)'
      },
      sources: {
        type: 'array',
        items: { type: 'string', enum: ['tasks', 'ideas', 'notes', 'guides', 'memory'] },
        description: 'Limit search to specific sources'
      },
      filters: {
        type: 'object',
        properties: {
          status: { type: 'array', items: { type: 'string' } },
          project_id: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } }
        }
      },
      limit: { type: 'number', default: 10 }
    },
    required: ['query']
  }
}
```

---

## 7. Database Schema Additions

### 7.1 FTS5 for Tasks

```sql
-- Add FTS5 virtual table for task full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  title,
  description,
  notes,
  content='tasks',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER tasks_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(rowid, title, description, notes)
  VALUES (new.id, new.title, new.description, new.notes);
END;

CREATE TRIGGER tasks_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description, notes)
  VALUES ('delete', old.id, old.title, old.description, old.notes);
END;

CREATE TRIGGER tasks_au AFTER UPDATE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description, notes)
  VALUES ('delete', old.id, old.title, old.description, old.notes);
  INSERT INTO tasks_fts(rowid, title, description, notes)
  VALUES (new.id, new.title, new.description, new.notes);
END;
```

### 7.2 FTS5 for Ideas

```sql
-- Add FTS5 virtual table for idea full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS ideas_fts USING fts5(
  title,
  description,
  notes,
  content='ideas',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Similar triggers as tasks_fts...
```

### 7.3 Memory Items Table

```sql
CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  tenant_id TEXT NOT NULL,
  user_id TEXT,

  -- Content
  content TEXT NOT NULL,
  summary TEXT,

  -- Classification
  type TEXT NOT NULL CHECK (type IN ('fact', 'preference', 'context', 'decision', 'outcome')),
  tier TEXT NOT NULL DEFAULT 'HOT' CHECK (tier IN ('HOT', 'WARM', 'COLD')),

  -- Source tracking
  source_type TEXT,  -- 'task', 'idea', 'conversation', 'manual'
  source_id TEXT,

  -- Metadata
  tags TEXT,  -- JSON array
  importance REAL DEFAULT 0.5,  -- 0-1 scale
  access_count INTEGER DEFAULT 0,
  last_accessed_at TEXT,

  -- Timestamps
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,  -- For ephemeral memory

  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- FTS for memory
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  content,
  summary,
  content='memory_items',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Index for tier-based queries
CREATE INDEX idx_memory_tier ON memory_items(tier, last_accessed_at);
```

---

## 8. Security Considerations

### 8.1 Authentication & Authorization

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      AUTHENTICATION LAYERS                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Layer 1: MCP Authentication                                            │
│  ├── Passphrase validation (NEXUS_PASSPHRASE env var)                   │
│  ├── Cloudflare Access JWT validation (optional)                        │
│  └── Rate limiting per client                                           │
│                                                                         │
│  Layer 2: Tenant Isolation                                              │
│  ├── All queries scoped to tenant_id                                    │
│  ├── Row-level security in D1 queries                                   │
│  └── Vectorize namespace isolation                                      │
│                                                                         │
│  Layer 3: Data Encryption                                               │
│  ├── App-layer AES-256-GCM for sensitive fields                         │
│  ├── Encryption keys per tenant                                         │
│  └── Key derivation from master secret                                  │
│                                                                         │
│  Layer 4: Execution Isolation                                           │
│  ├── Cloudflare Sandbox SDK for code execution                          │
│  ├── Network isolation per sandbox                                      │
│  └── Resource limits (CPU, memory, time)                                │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 8.2 Data Classification

| Data Type | Sensitivity | Encryption | Retention |
|-----------|-------------|------------|-----------|
| Task titles | Low | Optional | Indefinite |
| Task descriptions | Medium | Recommended | Indefinite |
| Memory items | High | Required | Configurable |
| Execution logs | Medium | Recommended | 90 days |
| API credentials | Critical | Required + HSM | Rotate 90 days |

### 8.3 Audit Logging

```typescript
interface AuditLog {
  id: string;
  timestamp: string;
  tenant_id: string;
  user_id?: string;
  action: string;          // 'search', 'create', 'update', 'delete', 'execute'
  resource_type: string;   // 'task', 'idea', 'memory', etc.
  resource_id?: string;
  request_metadata: {
    ip?: string;
    user_agent?: string;
    mcp_client?: string;
  };
  outcome: 'success' | 'failure';
  error_message?: string;
}
```

---

## 9. Performance Considerations

### 9.1 Caching Strategy

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CACHING LAYERS                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  L1: In-Memory (Worker Isolate)                                         │
│  ├── Request-scoped cache                                               │
│  ├── Hot configuration values                                           │
│  └── TTL: Request lifetime                                              │
│                                                                         │
│  L2: KV Cache                                                           │
│  ├── Search result cache (key: hash of query+filters)                   │
│  ├── Frequently accessed entities                                       │
│  └── TTL: 5 minutes (search), 1 hour (entities)                         │
│                                                                         │
│  L3: Durable Objects                                                    │
│  ├── Session state                                                      │
│  ├── Real-time sync state                                               │
│  └── TTL: Session lifetime                                              │
│                                                                         │
│  L4: D1 Query Cache                                                     │
│  ├── SQLite page cache                                                  │
│  ├── Prepared statement cache                                           │
│  └── TTL: Managed by D1                                                 │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 9.2 Query Optimization

```typescript
// Parallel search across sources
async function unifiedSearch(request: SearchRequest): Promise<SearchResponse> {
  const startTime = Date.now();
  const sources = request.sources || ['tasks', 'ideas', 'notes', 'guides', 'memory'];

  // Execute all source searches in parallel
  const searchPromises = sources.map(source => {
    switch (source) {
      case 'tasks':
        return searchTasks(request);
      case 'ideas':
        return searchIdeas(request);
      case 'notes':
        return searchNotes(request);
      case 'guides':
        return searchGuides(request);  // Via service binding
      case 'memory':
        return searchMemory(request);
      default:
        return Promise.resolve([]);
    }
  });

  const results = await Promise.all(searchPromises);
  const merged = mergeAndRankResults(results.flat(), request);

  return {
    results: merged.slice(0, request.limit || 20),
    total: merged.length,
    intent_detected: detectSearchIntent(request.query),
    sources_searched: sources,
    query_time_ms: Date.now() - startTime,
  };
}
```

### 9.3 Resource Limits

| Resource | Limit | Action on Exceed |
|----------|-------|------------------|
| Search query length | 500 chars | Truncate |
| Results per page | 100 | Cap at max |
| Concurrent searches | 10 per user | Queue |
| Vector search dimensions | 1536 | Fixed |
| Memory items per tenant | 100,000 | Evict COLD tier |
| Execution timeout | 10 minutes | Kill + retry |

---

## 10. Monitoring & Observability

### 10.1 Key Metrics

```typescript
interface Metrics {
  // Search metrics
  search_requests_total: Counter;
  search_latency_ms: Histogram;
  search_results_count: Histogram;
  search_cache_hit_rate: Gauge;

  // Execution metrics
  execution_queue_depth: Gauge;
  execution_duration_ms: Histogram;
  execution_success_rate: Gauge;
  execution_retry_count: Counter;

  // LLM metrics
  llm_requests_total: Counter;
  llm_tokens_used: Counter;
  llm_latency_ms: Histogram;
  llm_fallover_count: Counter;

  // System metrics
  durable_object_count: Gauge;
  d1_query_latency_ms: Histogram;
  vectorize_query_latency_ms: Histogram;
}
```

### 10.2 Alerting Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| Search P95 latency | > 500ms | > 2000ms |
| Execution queue depth | > 50 | > 200 |
| LLM error rate | > 5% | > 15% |
| Memory usage | > 80% | > 95% |

---

## 11. Implementation Checklist

### Phase 1: Foundation
- [ ] Add FTS5 indexes to Nexus for tasks and ideas
- [ ] Create unified search endpoint `/api/search`
- [ ] Implement intent detection algorithm
- [ ] Add `nexus_search` MCP tool
- [ ] Create Vectorize index for memory items
- [ ] Write integration tests for search

### Phase 2: Cross-Service Search
- [ ] Add service binding: Nexus → Developer Guides MCP
- [ ] Implement search aggregation logic
- [ ] Add KV cache for search results
- [ ] Handle cross-service error scenarios
- [ ] Write E2E tests for aggregated search

### Phase 3: Memory Enhancement
- [ ] Design and create `memory_items` table
- [ ] Implement memory CRUD API
- [ ] Create Vectorize embeddings pipeline
- [ ] Add memory extraction from completed tasks
- [ ] Implement tier-based memory eviction

### Phase 4: Advanced Routing
- [ ] Add LLM-based intent classification
- [ ] Implement personalized ranking
- [ ] Add query expansion logic
- [ ] Performance optimization and tuning

---

## 12. Decision Log

| Decision | Rationale | Date |
|----------|-----------|------|
| Use FTS5 for text search | Native SQLite, no external dependency, good performance | 2024-12 |
| Use Vectorize for semantic search | Native Cloudflare, integrated with D1, cost-effective | 2024-12 |
| Route all LLM calls through DE | Centralized fallover, cost tracking, rate limiting | 2024-12 |
| Durable Objects for state | Strong consistency, co-located with data, WebSocket support | 2024-12 |
| App-layer encryption | Tenant isolation, key rotation, compliance | 2024-12 |
| Service bindings for cross-service | Zero network latency, automatic auth, type safety | 2024-12 |

---

## Appendix A: Environment Variables

```bash
# Nexus Configuration
NEXUS_PASSPHRASE=<MCP authentication passphrase>
ENCRYPTION_KEY=<AES-256 master key for data encryption>

# Service Bindings (configured in wrangler.toml)
# DE=distributed-electrons (LLM routing)
# DEVELOPER_GUIDES=developer-guides-mcp (guide search)
# SANDBOX_EXECUTOR=claude-sandbox (code execution)

# Cloudflare Bindings
# D1: NEXUS_DB, DEVELOPER_GUIDES_DB
# R2: DEVELOPER_GUIDES_BUCKET, NEXUS_ARTIFACTS
# VECTORIZE: GUIDES_INDEX, MEMORY_INDEX
# KV: SEARCH_CACHE
```

---

## Appendix B: API Endpoint Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/search` | POST | Unified search across all sources |
| `/api/tasks` | CRUD | Task management |
| `/api/ideas` | CRUD | Idea management |
| `/api/memory` | CRUD | Memory item management |
| `/api/execution` | POST | Trigger idea/task execution |
| `/api/mcp` | POST | MCP protocol endpoint |

---

*Document generated as part of AI Architecture Design Workshop*
*Reference: e99b8670-5074-4c9a-93fe-60dd263fc807*
