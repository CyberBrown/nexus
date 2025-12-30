# Nexus Architecture Design

**Version:** 1.0
**Date:** 2025-12-30
**Status:** Active

## Executive Summary

Nexus is the central orchestration layer ("The Brain") for a personal AI infrastructure ecosystem. It handles Tier 1 processing, memory management, service coordination, and routes work to specialized services for execution.

---

## 1. System Overview

### 1.1 Ecosystem Pillars

| Pillar | Role | Status |
|--------|------|--------|
| **Nexus** | The Brain - orchestration, Tier 1 classification, memory management | Active |
| **DE** (Distributed Electrons) | Arms & Legs - Tier 2+ execution, LLM routing | Active |
| **Mnemo** | Working Memory - context caching (no decisions) | Planned |
| **Bridge** | User Interface - voice, text, all user-facing | Planned |

### 1.2 High-Level Architecture

```
                                    ┌─────────────────────────────────────────────┐
                                    │              User Interfaces                │
                                    │  Voice │ Web Dashboard │ MCP │ Email/SMS    │
                                    └────────────────────┬────────────────────────┘
                                                         │
                                    ┌────────────────────▼────────────────────────┐
                                    │              Bridge (Future)                │
                                    │         Unified Input/Output Layer          │
                                    └────────────────────┬────────────────────────┘
                                                         │
┌────────────────────────────────────────────────────────▼────────────────────────────────────────────────────────┐
│                                              NEXUS (The Brain)                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                                        Tier 1: Edge Processing                                            │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐                      │  │
│  │  │ Input Triage    │  │ Classification  │  │ Entity Detection│  │ Routing Decision│                      │  │
│  │  │ (InboxManager)  │  │ (DE Client)     │  │ (People, Tags)  │  │ (human/ai/mixed)│                      │  │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘  └─────────────────┘                      │  │
│  └──────────────────────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                                        State Management Layer                                             │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │  │
│  │  │ InboxManager    │  │ CaptureBuffer   │  │ SyncManager     │  │ UserSession     │  │ IdeaExecutor    │ │  │
│  │  │ (DO)            │  │ (DO)            │  │ (DO)            │  │ (DO)            │  │ (DO)            │ │  │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘  └─────────────────┘  └─────────────────┘ │  │
│  └──────────────────────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                                        Persistence Layer                                                  │  │
│  │  ┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐                        │  │
│  │  │ D1 (SQLite)                         │  │ KV Store                            │                        │  │
│  │  │ • Tasks, Projects, Ideas            │  │ • Encryption Keys                   │                        │  │
│  │  │ • Inbox, People, Commitments        │  │ • Session Tokens                    │                        │  │
│  │  │ • Memory Items                      │  │ • Cache                             │                        │  │
│  │  │ • Execution Queue/Archive           │  │                                     │                        │  │
│  │  └─────────────────────────────────────┘  └─────────────────────────────────────┘                        │  │
│  └──────────────────────────────────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                         │                                                          │
                         │ Service Binding (zero-cost)                              │ HTTP (workflows)
                         ▼                                                          ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                          DE (Distributed Electrons)                                             │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                                        Tier 2+: LLM Operations                                            │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐                      │  │
│  │  │ Text Generation │  │ Code Execution  │  │ Model Routing   │  │ Provider Mgmt   │                      │  │
│  │  │ (/generate)     │  │ (Sandbox)       │  │ (Claude/GPT/...)│  │ (Keys, Quotas)  │                      │  │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘  └─────────────────┘                      │  │
│  └──────────────────────────────────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                         │
                                    ┌────────────────────▼────────────────────────┐
                                    │           External LLM Providers            │
                                    │  Claude │ GPT-4 │ Nemotron (Local) │ Gemini │
                                    └─────────────────────────────────────────────┘
```

---

## 2. Integration Strategy

### 2.1 Service Communication Patterns

| Pattern | Use Case | Cost | Latency |
|---------|----------|------|---------|
| **Service Binding** | Nexus ↔ DE (primary) | Zero | ~1ms |
| **HTTP** | Workflows, External APIs | Standard | Variable |
| **WebSocket** | Real-time UI updates | Connection-based | Real-time |
| **MCP** | Claude.ai integration | Per-call | ~50ms |

### 2.2 Current Integrations

```
┌─────────────────────────────────────────────────────────────────┐
│                     NEXUS SERVICE BINDINGS                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  [[services]]                                                    │
│  ├── DE → de-text-gen (LLM operations)                          │
│  ├── SANDBOX_EXECUTOR → Code sandbox                            │
│  └── INTAKE → DE intake worker                                  │
│                                                                  │
│  [[d1_databases]]                                                │
│  └── DB → nexus-db                                               │
│                                                                  │
│  [[kv_namespaces]]                                               │
│  └── KV → nexus-kv                                               │
│                                                                  │
│  [[durable_objects]]                                             │
│  ├── INBOX_MANAGER → InboxManager                                │
│  ├── CAPTURE_BUFFER → CaptureBuffer                              │
│  ├── SYNC_MANAGER → SyncManager                                  │
│  ├── USER_SESSION → UserSession                                  │
│  └── IDEA_EXECUTOR → IdeaExecutor                                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.3 Integration Decision Matrix

| Integration | Method | Rationale |
|-------------|--------|-----------|
| **LLM Calls** | DE Service Binding | Zero-cost, type-safe, single point of control |
| **Code Execution** | DE Sandbox | Isolated execution, GitHub integration |
| **Email Ingestion** | IMAP (planned) | Multi-provider, app passwords, IDLE support |
| **Calendar Sync** | Google Calendar API (planned) | OAuth, real-time webhooks |
| **Claude.ai** | MCP over HTTP | Standard protocol, passphrase auth |
| **Voice Input** | Bridge (future) | Centralized input handling |

### 2.4 Authentication Strategy

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        AUTHENTICATION LAYERS                              │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  Layer 1: External Access (Cloudflare Access)                             │
│  ├── OAuth/SAML for human users                                           │
│  ├── Service Tokens for machine-to-machine                                │
│  └── Headers: CF-Access-Client-Id, CF-Access-Client-Secret                │
│                                                                           │
│  Layer 2: Tenant Resolution                                               │
│  ├── JWT claims (production)                                              │
│  ├── Passphrase → tenant_id lookup (MCP single-tenant)                    │
│  └── Dev JWT (development only)                                           │
│                                                                           │
│  Layer 3: Encryption at Rest                                              │
│  ├── AES-256-GCM per tenant                                               │
│  ├── Keys stored in KV, referenced in tenants table                       │
│  └── Encrypted: title, description, content fields                        │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Flow Patterns

### 3.1 Capture → Classification → Action Pipeline

```
                              CAPTURE SOURCES
    ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐
    │  Voice  │  │  Email  │  │   MCP   │  │   Web   │  │ Webhook │
    └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘
         │            │            │            │            │
         └────────────┴────────────┴────────────┴────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │      CaptureBuffer (DO)      │
                    │  • Buffer streaming input    │
                    │  • Debounce rapid fires      │
                    │  • WebSocket real-time       │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │      InboxManager (DO)       │
                    │  • Queue for classification  │
                    │  • Track processing state    │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │     Classification (DE)       │
                    │  • Type: task/event/idea/... │
                    │  • Domain: work/personal/... │
                    │  • Urgency/Importance: 1-5   │
                    │  • Confidence: 0-1           │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────┴───────────────┐
                    │                              │
            confidence >= 0.8            confidence < 0.8
                    │                              │
                    ▼                              ▼
         ┌─────────────────────┐      ┌─────────────────────┐
         │   Auto-create Task  │      │  Inbox for Review   │
         │   (status: 'next')  │      │  (human triage)     │
         └──────────┬──────────┘      └─────────────────────┘
                    │
                    ▼
         ┌─────────────────────────────────────────────────────┐
         │                 EXECUTION ROUTING                    │
         ├─────────────────────────────────────────────────────┤
         │                                                      │
         │  Tag-Based Classification:                           │
         │  ┌─────────────────────────────────────────────────┐│
         │  │ [human]     → human executor                    ││
         │  │ [call]      → human executor                    ││
         │  │ [meeting]   → human executor                    ││
         │  │ [BLOCKED]   → human executor                    ││
         │  │ [review]    → human-ai executor                 ││
         │  │ [approve]   → human-ai executor                 ││
         │  │ [decide]    → human-ai executor                 ││
         │  │ [implement] → ai executor (DE)                  ││
         │  │ [code]      → ai executor (DE)                  ││
         │  │ [research]  → ai executor (DE)                  ││
         │  │ [test]      → ai executor (DE)                  ││
         │  │ (no tag)    → human (for triage)                ││
         │  └─────────────────────────────────────────────────┘│
         │                                                      │
         └──────────────────────┬───────────────────────────────┘
                                │
            ┌───────────────────┼───────────────────┐
            │                   │                   │
            ▼                   ▼                   ▼
    ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
    │ Human Queue   │   │ Human-AI Queue│   │ AI Queue (DE) │
    │ • UI/Mobile   │   │ • Review + AI │   │ • Autonomous  │
    │ • Notifications│  │ • Approve/Mod │   │ • Callbacks   │
    └───────────────┘   └───────────────┘   └───────────────┘
```

### 3.2 Idea → Execution Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         IDEA EXECUTION PIPELINE                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   1. CAPTURE                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  User captures idea via MCP, Web, or Voice                          │   │
│   │  → Stored in `ideas` table with status='new'                        │   │
│   └───────────────────────────────────┬─────────────────────────────────┘   │
│                                       │                                      │
│   2. PLANNING (IdeaToPlanWorkflow)                                          │
│   ┌───────────────────────────────────▼─────────────────────────────────┐   │
│   │  POST /api/execution/ideas/:id/plan                                 │   │
│   │  ├─ Load idea from D1                                               │   │
│   │  ├─ Call DE text-gen to break into tasks                            │   │
│   │  ├─ Parse JSON response                                             │   │
│   │  ├─ Create idea_tasks entries                                       │   │
│   │  └─ Update idea execution_status='planned'                          │   │
│   └───────────────────────────────────┬─────────────────────────────────┘   │
│                                       │                                      │
│   3. APPROVAL (CEO Dashboard)                                               │
│   ┌───────────────────────────────────▼─────────────────────────────────┐   │
│   │  Human reviews generated plan                                       │   │
│   │  ├─ Approve: proceed to execution                                   │   │
│   │  ├─ Modify: adjust tasks/priorities                                 │   │
│   │  └─ Reject: kill idea with reasoning                                │   │
│   └───────────────────────────────────┬─────────────────────────────────┘   │
│                                       │                                      │
│   4. EXECUTION (TaskExecutorWorkflow)                                       │
│   ┌───────────────────────────────────▼─────────────────────────────────┐   │
│   │  POST /api/execution/ideas/:id/execute-all                          │   │
│   │  For each idea_task:                                                │   │
│   │  ├─ Check dependencies (task_dependencies)                          │   │
│   │  ├─ Queue to execution_queue                                        │   │
│   │  ├─ Route to appropriate executor (human/human-ai/ai)               │   │
│   │  └─ Track status (ready/in_progress/completed/failed)               │   │
│   └───────────────────────────────────┬─────────────────────────────────┘   │
│                                       │                                      │
│   5. CALLBACKS & PROMOTION                                                  │
│   ┌───────────────────────────────────▼─────────────────────────────────┐   │
│   │  /workflow-callback or /api/tasks/:id/complete                      │   │
│   │  ├─ Mark task completed                                             │   │
│   │  ├─ Archive queue entry                                             │   │
│   │  ├─ Check dependent tasks (task_dependencies)                       │   │
│   │  ├─ Promote ready dependents to 'next' status                       │   │
│   │  └─ Update idea execution_status if all tasks complete              │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Memory & Context Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MEMORY ARCHITECTURE                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   SCOPE HIERARCHY                          RETRIEVAL PRIORITY               │
│   ┌───────────────────────────────┐        ┌───────────────────────────────┐│
│   │                               │        │                               ││
│   │   session (ephemeral)         │        │   1. session (most specific)  ││
│   │       ↑                       │        │   2. conversation             ││
│   │   conversation                │        │   3. task                     ││
│   │       ↑                       │        │   4. project                  ││
│   │   task                        │        │   5. global (fallback)        ││
│   │       ↑                       │        │                               ││
│   │   project                     │        └───────────────────────────────┘│
│   │       ↑                       │                                         │
│   │   global (persistent)         │        MEMORY TYPES                     │
│   │                               │        ┌───────────────────────────────┐│
│   └───────────────────────────────┘        │ fact       - Stored knowledge ││
│                                            │ preference - User settings    ││
│   MEMORY TIERS (Future)                    │ decision   - Past choices     ││
│   ┌───────────────────────────────┐        │ context    - Situational      ││
│   │ HOT   - Active session        │        │ learning   - Patterns         ││
│   │ WARM  - Recent access         │        │ correction - Error fixes      ││
│   │ COLD  - Archived              │        └───────────────────────────────┘│
│   └───────────────────────────────┘                                         │
│                                                                              │
│   MNEMO INTEGRATION (Planned)                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Nexus decides what to load → Mnemo caches it → Nexus reads cache   │   │
│   │                                                                      │   │
│   │  1. Entity detected in conversation (e.g., "the Smith project")     │   │
│   │  2. Nexus tells Mnemo: "load context for project X"                 │   │
│   │  3. Mnemo fetches from D1, caches in fast storage                   │   │
│   │  4. Nexus retrieves cached context for response generation          │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Search Routing Logic

### 4.1 Search Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SEARCH ROUTING ARCHITECTURE                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   QUERY INPUT                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  User Query: "Find emails about the Acme proposal from last week"   │   │
│   └───────────────────────────────────┬─────────────────────────────────┘   │
│                                       │                                      │
│   QUERY CLASSIFICATION (Tier 1)                                             │
│   ┌───────────────────────────────────▼─────────────────────────────────┐   │
│   │  Fast edge classification:                                          │   │
│   │  ├─ Intent: search                                                  │   │
│   │  ├─ Entities: ["Acme", "proposal"]                                  │   │
│   │  ├─ Time filter: last 7 days                                        │   │
│   │  ├─ Source filter: email                                            │   │
│   │  └─ Query type: semantic (not exact match)                          │   │
│   └───────────────────────────────────┬─────────────────────────────────┘   │
│                                       │                                      │
│   SEARCH ROUTING DECISION                                                   │
│   ┌───────────────────────────────────▼─────────────────────────────────┐   │
│   │                                                                      │   │
│   │  Route Selection Logic:                                             │   │
│   │  ┌─────────────────────────────────────────────────────────────────┐│   │
│   │  │                                                                 ││   │
│   │  │  IF query.isExactMatch AND query.field IS 'title'              ││   │
│   │  │     → D1 LIKE query (fastest)                                  ││   │
│   │  │                                                                 ││   │
│   │  │  ELSE IF query.requiresFullText AND query.scope IS 'notes'     ││   │
│   │  │     → FTS5 search on notes_fts                                 ││   │
│   │  │                                                                 ││   │
│   │  │  ELSE IF query.isSemantic                                      ││   │
│   │  │     → Vectorize embedding search (future)                      ││   │
│   │  │                                                                 ││   │
│   │  │  ELSE IF query.source IS 'email' AND NOT indexed_locally       ││   │
│   │  │     → External search (Gmail API / IMAP SEARCH)                ││   │
│   │  │                                                                 ││   │
│   │  │  DEFAULT                                                       ││   │
│   │  │     → Hybrid: FTS5 + D1 filters                                ││   │
│   │  │                                                                 ││   │
│   │  └─────────────────────────────────────────────────────────────────┘│   │
│   │                                                                      │   │
│   └───────────────────────────────────┬─────────────────────────────────┘   │
│                                       │                                      │
│                    ┌──────────────────┼──────────────────┐                  │
│                    │                  │                  │                  │
│                    ▼                  ▼                  ▼                  │
│            ┌─────────────┐    ┌─────────────┐    ┌─────────────┐            │
│            │  D1 + FTS5  │    │  Vectorize  │    │  External   │            │
│            │  (current)  │    │  (planned)  │    │  (future)   │            │
│            └──────┬──────┘    └──────┬──────┘    └──────┬──────┘            │
│                   │                  │                  │                   │
│                   └──────────────────┼──────────────────┘                   │
│                                      │                                      │
│   RESULT AGGREGATION                 ▼                                      │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  • Merge results from multiple backends                             │   │
│   │  • Deduplicate by entity ID                                         │   │
│   │  • Re-rank by relevance + recency                                   │   │
│   │  • Apply tenant-level access control                                │   │
│   │  • Decrypt result fields                                            │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Search Backend Comparison

| Backend | Use Case | Latency | Capability |
|---------|----------|---------|------------|
| **D1 LIKE** | Exact/prefix title match | ~5ms | Limited |
| **FTS5** | Full-text notes search | ~10ms | Token-based |
| **Vectorize** | Semantic similarity (planned) | ~50ms | AI-powered |
| **External** | Email, Calendar | ~200ms+ | Provider-dependent |

### 4.3 FTS5 Implementation (Current)

```sql
-- Virtual FTS5 table for notes
CREATE VIRTUAL TABLE notes_fts USING fts5(
    title,
    content,
    search_text,
    content='notes',
    content_rowid='rowid'
);

-- Query pattern
SELECT n.* FROM notes n
JOIN notes_fts fts ON n.rowid = fts.rowid
WHERE notes_fts MATCH ?
  AND n.tenant_id = ?
  AND n.deleted_at IS NULL
ORDER BY rank
LIMIT 20;
```

**Limitation:** FTS5 cannot search encrypted fields. The `search_text` column stores plaintext for indexing (trade-off: security vs searchability).

### 4.4 Semantic Search Architecture (Planned)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     SEMANTIC SEARCH PIPELINE (PLANNED)                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   1. INDEXING (Background)                                                  │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  On create/update of searchable content:                            │   │
│   │  ├─ Extract text from task/note/idea/email                          │   │
│   │  ├─ Generate embedding via Workers AI (@cf/baai/bge-base-en-v1.5)   │   │
│   │  ├─ Store in Vectorize index with metadata:                         │   │
│   │  │   { tenant_id, entity_type, entity_id, created_at }              │   │
│   │  └─ Store document in R2 for retrieval                              │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   2. QUERY (Real-time)                                                      │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  On search query:                                                   │   │
│   │  ├─ Generate query embedding                                        │   │
│   │  ├─ Query Vectorize with tenant_id filter                           │   │
│   │  ├─ Retrieve top-K similar documents                                │   │
│   │  ├─ Fetch full content from R2                                      │   │
│   │  └─ Re-rank with recency boost                                      │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   CONFIGURATION (wrangler.toml)                                             │
│   [[vectorize]]                                                             │
│   binding = "VECTORIZE"                                                     │
│   index_name = "nexus-embeddings"                                           │
│                                                                              │
│   [[r2_buckets]]                                                            │
│   binding = "AI_SEARCH_DOCUMENTS"                                           │
│   bucket_name = "nexus-ai-search"                                           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.5 Search Routing Algorithm

```typescript
interface SearchQuery {
  query: string;
  filters?: {
    entityTypes?: ('task' | 'note' | 'idea' | 'email' | 'project')[];
    dateRange?: { start: Date; end: Date };
    domain?: string;
    tags?: string[];
  };
  mode: 'exact' | 'fulltext' | 'semantic' | 'auto';
  limit?: number;
}

function routeSearch(query: SearchQuery): SearchBackend[] {
  const backends: SearchBackend[] = [];

  // 1. Exact match - always use D1
  if (query.mode === 'exact') {
    return [{ type: 'd1', priority: 1 }];
  }

  // 2. Full-text on notes - use FTS5
  if (query.filters?.entityTypes?.includes('note') || query.mode === 'fulltext') {
    backends.push({ type: 'fts5', priority: 1 });
  }

  // 3. Semantic search - use Vectorize (when available)
  if (query.mode === 'semantic' || query.mode === 'auto') {
    if (env.VECTORIZE) {
      backends.push({ type: 'vectorize', priority: 2 });
    }
  }

  // 4. Email search - external provider
  if (query.filters?.entityTypes?.includes('email')) {
    backends.push({ type: 'email_provider', priority: 3 });
  }

  // 5. Default: D1 with LIKE
  if (backends.length === 0) {
    backends.push({ type: 'd1', priority: 1 });
  }

  return backends.sort((a, b) => a.priority - b.priority);
}
```

---

## 5. Architecture Decision Records (ADRs)

### ADR-001: DE for All LLM Operations

**Status:** Accepted
**Context:** Nexus needs LLM capabilities for classification, planning, and task execution.
**Decision:** All LLM calls go through DE (Distributed Electrons) via service binding.
**Rationale:**
- Single point of control for model routing, costs, and quotas
- Zero-cost inter-worker communication
- DE handles provider failover and model selection
- Nexus stays focused on orchestration, not LLM mechanics

**Consequences:**
- Nexus cannot function without DE
- DE becomes critical path for AI features
- Simplifies Nexus codebase significantly

---

### ADR-002: Durable Objects for Stateful Coordination

**Status:** Accepted
**Context:** Need to manage real-time state (captures, sync, sessions) with consistency.
**Decision:** Use Durable Objects for all stateful coordination.
**Rationale:**
- Single-threaded actor model prevents race conditions
- Built-in SQLite storage for durability
- WebSocket support for real-time updates
- Automatic state restoration on wake

**Consequences:**
- One DO instance per tenant/user (scalability concern for large tenants)
- Cold start latency on first access
- Must design for DO-specific patterns (no global state)

---

### ADR-003: App-Layer Encryption with FTS Trade-off

**Status:** Accepted
**Context:** Need to encrypt sensitive user data but also support full-text search.
**Decision:** Encrypt fields at app layer (AES-256-GCM), maintain separate `search_text` plaintext field.
**Rationale:**
- D1/SQLite doesn't support encrypted search
- FTS5 requires plaintext for indexing
- Trade-off: searchability vs. full encryption

**Consequences:**
- `search_text` field is unencrypted (partial exposure)
- Additional storage overhead
- Complex sync between encrypted and search fields
- Future: Semantic search (embeddings) may allow encrypted search

---

### ADR-004: Tag-Based Executor Routing

**Status:** Accepted
**Context:** Need to route tasks to human, human-ai, or ai executors.
**Decision:** Use tag-based pattern matching on task titles.
**Rationale:**
- Simple, predictable routing rules
- Users can control routing via tags
- No LLM call needed for routing (fast)
- Easy to debug and override

**Consequences:**
- Requires consistent tag usage
- May misroute tasks without tags (defaults to human)
- Future: Could add LLM-based routing for ambiguous cases

---

### ADR-005: IMAP for Email Ingestion (over Gmail API)

**Status:** Proposed
**Context:** Need to ingest email for task extraction and context.
**Decision:** Use IMAP with ImapFlow for initial implementation.
**Rationale:**
- Works with any email provider
- App passwords (no OAuth verification process)
- IDLE provides near-real-time
- Simpler infrastructure (no Pub/Sub)

**Consequences:**
- Requires long-running process for IDLE
- Less structured than Gmail API
- May add Gmail API Push later for production scale

---

### ADR-006: MCP for Claude.ai Integration

**Status:** Accepted
**Context:** Want Claude.ai to interact with Nexus task/idea system.
**Decision:** Expose MCP server with passphrase authentication.
**Rationale:**
- Standard protocol supported by Claude
- Passphrase auth simpler than OAuth for single-tenant
- 30+ tools cover full CRUD and execution

**Consequences:**
- Single-tenant mode (one passphrase = one user)
- Must manually sync passphrase with tenant
- Read operations are public (by design)

---

## 6. Future Architecture Considerations

### 6.1 Scaling Considerations

| Component | Current Limit | Mitigation Strategy |
|-----------|---------------|---------------------|
| D1 | 10GB database | Shard by tenant, archive old data |
| DO | Single instance per ID | Use smaller granularity IDs |
| Vectorize | 5M vectors | Multiple indexes by entity type |
| Workers | 10ms CPU / 128MB | Offload heavy work to DE |

### 6.2 Planned Integrations

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         INTEGRATION ROADMAP                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  PRIORITY 1 (Next)                                                          │
│  ├─ Email Ingestion (IMAP/Gmail) - auto-extract tasks from emails           │
│  ├─ Mnemo Integration - context caching and retrieval                       │
│  └─ Production Auth - OAuth/Clerk replacing dev JWT                         │
│                                                                              │
│  PRIORITY 2                                                                 │
│  ├─ Google Calendar Sync - bi-directional event sync                        │
│  ├─ Semantic Search - Vectorize-based similarity search                     │
│  └─ Voice Input (Bridge) - unified input handling                           │
│                                                                              │
│  PRIORITY 3                                                                 │
│  ├─ Mobile Clients - via Bridge API                                         │
│  ├─ Cross-device CRDT Sync - conflict-free replicated data                  │
│  └─ Memory Tier Management - HOT/WARM/COLD automatic tiering                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 6.3 Bridge Architecture (Future)

```
                              ┌─────────────────────────────────┐
                              │            BRIDGE               │
                              │   Unified User Interface Layer  │
                              ├─────────────────────────────────┤
                              │                                 │
                              │  Input Adapters:                │
                              │  ├─ Voice (Whisper/Deepgram)    │
                              │  ├─ Text (Web/Mobile/CLI)       │
                              │  ├─ Email (forwarded)           │
                              │  └─ SMS/Messaging               │
                              │                                 │
                              │  Output Adapters:               │
                              │  ├─ TTS (ElevenLabs/OpenAI)     │
                              │  ├─ Push Notifications          │
                              │  ├─ Email                       │
                              │  └─ Dashboard Widgets           │
                              │                                 │
                              └─────────────────┬───────────────┘
                                                │
                                   Unified API (gRPC/REST)
                                                │
                                                ▼
                                            NEXUS
```

---

## 7. Operational Considerations

### 7.1 Monitoring & Observability

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         OBSERVABILITY STACK                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  LOGGING                                                                    │
│  ├─ console.log → Cloudflare Logpush → Destination (R2/S3/Datadog)          │
│  ├─ dispatch_log table - immutable action history                           │
│  └─ execution_archive - completed task history                              │
│                                                                              │
│  METRICS (Future)                                                           │
│  ├─ Capture rate (items/hour)                                               │
│  ├─ Classification latency (p50, p99)                                       │
│  ├─ Task completion rate                                                    │
│  ├─ Executor routing distribution                                           │
│  └─ DE call latency                                                         │
│                                                                              │
│  ALERTING (Future)                                                          │
│  ├─ Queue depth threshold                                                   │
│  ├─ Classification failure rate                                             │
│  ├─ DE health check failures                                                │
│  └─ Execution quarantine rate                                               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 7.2 Disaster Recovery

| Scenario | Recovery Strategy |
|----------|-------------------|
| D1 corruption | Point-in-time recovery (Cloudflare managed) |
| DO state loss | SQLite storage auto-restores on wake |
| KV key loss | Regenerate encryption keys (data loss for affected tenant) |
| DE unavailable | Graceful degradation (queue tasks, skip classification) |

---

## 8. Summary

Nexus is designed as a **lightweight orchestration layer** that:

1. **Classifies fast** - Tier 1 edge processing for input triage
2. **Routes smart** - Tag-based executor routing (human/human-ai/ai)
3. **Delegates heavy work** - All LLM operations via DE service binding
4. **Maintains state** - Durable Objects for real-time coordination
5. **Stores securely** - App-layer encryption with FTS trade-off
6. **Integrates openly** - MCP for Claude.ai, WebSocket for dashboards

The architecture prioritizes **low latency** for user-facing operations and **durability** for background execution, with clear separation between the "brain" (Nexus) and "arms & legs" (DE).
