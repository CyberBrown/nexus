# AI Search Layer - Visual Architecture Diagrams

## High-Level System Overview

```
                                    ┌─────────────────────────────────────────────┐
                                    │              USER INTERFACES                 │
                                    │  (MCP Tools, REST API, Web Dashboard)       │
                                    └────────────────────┬────────────────────────┘
                                                         │
                                                         ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                         NEXUS WORKER                                            │
│                                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────────────────────┐   │
│  │                                    SEARCH LAYER                                          │   │
│  │                                                                                          │   │
│  │  ┌──────────────┐    ┌──────────────────────────────────────────────────────────────┐   │   │
│  │  │    Query     │    │                    SEARCH ROUTER                              │   │   │
│  │  │   Analyzer   │───▶│  ┌────────────┐  ┌────────────┐  ┌────────────────────────┐  │   │   │
│  │  │              │    │  │  Keyword   │  │  Semantic  │  │  Hybrid (RRF Fusion)   │  │   │   │
│  │  │ • Type       │    │  │  (FTS5)    │  │ (Vectorize)│  │  • Parallel execution  │  │   │   │
│  │  │ • Intent     │    │  └─────┬──────┘  └─────┬──────┘  │  • Score normalization │  │   │   │
│  │  │ • Entities   │    │        │               │         │  • Deduplication       │  │   │   │
│  │  └──────────────┘    │        └───────────────┴─────────┴────────────────────────┘  │   │   │
│  │                      └──────────────────────────────────────────────────────────────┘   │   │
│  │                                                                                          │   │
│  │  ┌──────────────────────────────────────────────────────────────────────────────────┐   │   │
│  │  │                              RESULT AGGREGATOR                                    │   │   │
│  │  │  • Merge multi-source results     • Apply tenant_id filter (security)           │   │   │
│  │  │  • Decrypt display fields         • Enrich with relationships                    │   │   │
│  │  └──────────────────────────────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                                 │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
         │                    │                    │                    │
         ▼                    ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│      D1         │  │   Vectorize     │  │   Workers AI    │  │       R2        │
│    (SQLite)     │  │   (Vectors)     │  │  (Embeddings)   │  │  (Documents)    │
│                 │  │                 │  │                 │  │                 │
│ • Entity data   │  │ • 768-dim       │  │ • bge-base-en   │  │ • PDFs          │
│ • FTS5 indexes  │  │ • Cosine sim    │  │ • Real-time     │  │ • Meeting notes │
│ • Encrypted     │  │ • Metadata      │  │ • Batch         │  │ • External docs │
└─────────────────┘  └─────────────────┘  └─────────────────┘  └─────────────────┘
```

## Write Path (Indexing Flow)

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                              ENTITY CREATION / UPDATE                           │
└───────────────────────────────────────┬────────────────────────────────────────┘
                                        │
                                        ▼
                          ┌─────────────────────────────┐
                          │    Build search_text        │
                          │    (plaintext composite)    │
                          │                             │
                          │    title + description +    │
                          │    tags + category          │
                          └──────────────┬──────────────┘
                                         │
                    ┌────────────────────┴────────────────────┐
                    │                                         │
                    ▼                                         ▼
    ┌───────────────────────────┐            ┌───────────────────────────┐
    │    SYNCHRONOUS PATH       │            │    ASYNCHRONOUS PATH      │
    │    (Blocking)             │            │    (Non-blocking)         │
    └───────────────────────────┘            └───────────────────────────┘
                    │                                         │
        ┌───────────┴───────────┐                            │
        │                       │                            │
        ▼                       ▼                            ▼
┌─────────────┐      ┌─────────────────┐      ┌──────────────────────────────┐
│  Encrypt    │      │   Update FTS5   │      │     IndexManager DO          │
│  Fields     │      │   Virtual Table │      │                              │
│             │      │                 │      │  ┌────────────────────────┐  │
│ AES-256-GCM │      │ INSERT INTO     │      │  │    Job Queue           │  │
│             │      │ entity_fts      │      │  │    ────────────        │  │
└──────┬──────┘      └────────┬────────┘      │  │ 1. Generate embedding  │  │
       │                      │               │  │ 2. Upsert to Vectorize │  │
       ▼                      │               │  │ 3. Update status       │  │
┌─────────────┐               │               │  └────────────────────────┘  │
│  Store D1   │               │               └──────────────────────────────┘
│  (Primary)  │◀──────────────┘                              │
└─────────────┘                                              │
                                                             ▼
                                              ┌──────────────────────────────┐
                                              │       Workers AI             │
                                              │  @cf/baai/bge-base-en-v1.5   │
                                              │                              │
                                              │  text → [768 floats]         │
                                              └──────────────┬───────────────┘
                                                             │
                                                             ▼
                                              ┌──────────────────────────────┐
                                              │       Vectorize Index        │
                                              │       nexus-embeddings       │
                                              │                              │
                                              │  UPSERT vector + metadata    │
                                              │  (entity_type, entity_id,    │
                                              │   tenant_id, title, etc.)    │
                                              └──────────────────────────────┘
```

## Read Path (Query Flow)

```
┌────────────────────────────────────────────────────────────────────────────────┐
│    User Query: "What are my priorities for the AI project?"                    │
└───────────────────────────────────────┬────────────────────────────────────────┘
                                        │
                                        ▼
                         ┌──────────────────────────────┐
                         │        QUERY ANALYZER         │
                         │                               │
                         │  Input: "What are my..."      │
                         │  Output:                      │
                         │    type: 'semantic'           │
                         │    intent: 'question'         │
                         │    entities: ['all']          │
                         │    confidence: 0.85           │
                         └──────────────┬───────────────┘
                                        │
          ┌─────────────────────────────┼─────────────────────────────┐
          │                             │                             │
          ▼                             ▼                             ▼
┌──────────────────┐      ┌──────────────────────┐      ┌──────────────────┐
│   FTS5 SEARCH    │      │   VECTOR SEARCH      │      │  AI SEARCH       │
│   (Keyword)      │      │   (Semantic)         │      │  (Documents)     │
│                  │      │                      │      │                  │
│ SELECT * FROM    │      │ 1. Generate query    │      │ env.AI.autorag   │
│ tasks_fts        │      │    embedding         │      │ ("nexus-ai-      │
│ WHERE MATCH      │      │                      │      │  search")        │
│ "priorities      │      │ 2. Query Vectorize   │      │ .aiSearch()      │
│  AI project"     │      │    topK=20           │      │                  │
│                  │      │    filter: tenant_id │      │ (Only for R2     │
│ + JOIN to get    │      │                      │      │  documents)      │
│ full entity      │      │ 3. Fetch entity data │      │                  │
└────────┬─────────┘      └──────────┬───────────┘      └────────┬─────────┘
         │                           │                           │
         │    ┌──────────────────────┼───────────────────────────┘
         │    │                      │
         ▼    ▼                      ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│                        RECIPROCAL RANK FUSION (RRF)                             │
│                                                                                 │
│  For each result d across all sources:                                          │
│    RRF_score(d) = Σ  1 / (k + rank_i(d))    where k = 60                       │
│                   i                                                             │
│                                                                                 │
│  Example:                                                                       │
│    Result "task-123" ranked #1 in FTS5, #3 in Vector                           │
│    RRF = 1/(60+1) + 1/(60+3) = 0.0164 + 0.0159 = 0.0323                        │
│                                                                                 │
│  Steps:                                                                         │
│    1. Normalize scores across sources                                           │
│    2. Deduplicate by entity_id (keep highest combined score)                   │
│    3. Sort by RRF score descending                                              │
│    4. Limit to top N results                                                    │
└───────────────────────────────────────┬────────────────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│                            POST-PROCESSING                                      │
│                                                                                 │
│  1. Apply security filter: WHERE tenant_id = ?                                  │
│  2. Decrypt display fields (title, description) using tenant key               │
│  3. Enrich: add related entities, project names, tags                          │
│  4. Format response: { entity_type, entity_id, score, title, snippet, ... }    │
└───────────────────────────────────────┬────────────────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│                              API RESPONSE                                       │
│                                                                                 │
│  {                                                                              │
│    "success": true,                                                             │
│    "data": {                                                                    │
│      "results": [                                                               │
│        { "entity_type": "task", "id": "...", "title": "...", "score": 0.92 },  │
│        { "entity_type": "idea", "id": "...", "title": "...", "score": 0.87 },  │
│        ...                                                                      │
│      ],                                                                         │
│      "total": 15,                                                               │
│      "query_analysis": { "type": "semantic", "intent": "question" }            │
│    }                                                                            │
│  }                                                                              │
└────────────────────────────────────────────────────────────────────────────────┘
```

## Entity-Index Mapping

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              D1 DATABASE                                         │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐   │
│  │   tasks     │   │    notes     │   │    ideas     │   │    projects     │   │
│  │             │   │              │   │              │   │                 │   │
│  │ id          │   │ id           │   │ id           │   │ id              │   │
│  │ title ░░░░░ │   │ title ░░░░░░ │   │ title ░░░░░░ │   │ name ░░░░░░░░░░ │   │
│  │ desc ░░░░░░ │   │ content ░░░░ │   │ desc ░░░░░░░ │   │ description ░░░ │   │
│  │ search_text │   │ search_text  │   │ search_text  │   │ search_text     │   │
│  │ tenant_id   │   │ tenant_id    │   │ tenant_id    │   │ tenant_id       │   │
│  │ ...         │   │ ...          │   │ ...          │   │ ...             │   │
│  └──────┬──────┘   └──────┬───────┘   └──────┬───────┘   └────────┬────────┘   │
│         │                 │                  │                     │            │
│  ░░░░░ = Encrypted (AES-256-GCM)                                               │
│                                                                                  │
└─────────┼─────────────────┼──────────────────┼─────────────────────┼────────────┘
          │                 │                  │                     │
          ▼                 ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           FTS5 VIRTUAL TABLES                                    │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐   │
│  │ tasks_fts   │   │  notes_fts   │   │  ideas_fts   │   │  projects_fts   │   │
│  │             │   │              │   │              │   │                 │   │
│  │ task_id     │   │ note_id      │   │ idea_id      │   │ project_id      │   │
│  │ search_text │   │ search_text  │   │ search_text  │   │ search_text     │   │
│  │             │   │              │   │              │   │                 │   │
│  │ tokenize=   │   │ tokenize=    │   │ tokenize=    │   │ tokenize=       │   │
│  │ 'porter'    │   │ 'porter'     │   │ 'porter'     │   │ 'porter'        │   │
│  └─────────────┘   └──────────────┘   └──────────────┘   └─────────────────┘   │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
          │                 │                  │                     │
          └─────────────────┴──────────────────┴─────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           VECTORIZE INDEX                                        │
│                           nexus-embeddings                                       │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │   Unified Vector Index                                                      │ │
│  │   ─────────────────────                                                     │ │
│  │                                                                             │ │
│  │   Dimensions: 768 (bge-base-en-v1.5)                                       │ │
│  │   Metric: Cosine Similarity                                                 │ │
│  │                                                                             │ │
│  │   Each vector includes metadata:                                            │ │
│  │   ┌──────────────────────────────────────────────────────────────────────┐ │ │
│  │   │  {                                                                    │ │ │
│  │   │    "entity_type": "task" | "note" | "idea" | "project" | "person",   │ │ │
│  │   │    "entity_id": "uuid-...",                                           │ │ │
│  │   │    "tenant_id": "tenant-uuid-...",                                    │ │ │
│  │   │    "title": "AI Search Architecture Design",                          │ │ │
│  │   │    "created_at": "2025-12-30T...",                                    │ │ │
│  │   │    "domain": "work",                                                   │ │ │
│  │   │    "status": "in_progress",                                            │ │ │
│  │   │    "category": "research"                                              │ │ │
│  │   │  }                                                                    │ │ │
│  │   └──────────────────────────────────────────────────────────────────────┘ │ │
│  │                                                                             │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## MCP Tool Integration

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              CLAUDE MCP CLIENT                                   │
│                              (Claude.ai, Claude Code)                            │
└───────────────────────────────────────┬─────────────────────────────────────────┘
                                        │
                                        │ POST /mcp
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              NEXUS MCP SERVER                                    │
│                              /mcp endpoint                                       │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  NEW SEARCH TOOLS                                                                │
│  ─────────────────                                                               │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │ nexus_search                                                                │ │
│  │ ────────────                                                                │ │
│  │                                                                             │ │
│  │ Universal search across all entities.                                       │ │
│  │                                                                             │ │
│  │ Arguments:                                                                  │ │
│  │   query: string (required)     - Search query                               │ │
│  │   entities?: EntityType[]      - Filter to specific types                   │ │
│  │   mode?: 'keyword'|'semantic'|'hybrid'|'auto'  - Search mode               │ │
│  │   filters?: {                  - Optional filters                           │ │
│  │     domain?: string                                                         │ │
│  │     status?: string                                                         │ │
│  │     created_after?: string                                                  │ │
│  │     created_before?: string                                                 │ │
│  │   }                                                                         │ │
│  │   limit?: number               - Max results (default: 20)                  │ │
│  │                                                                             │ │
│  │ Returns: SearchResult[]                                                     │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │ nexus_ask                                                                   │ │
│  │ ─────────                                                                   │ │
│  │                                                                             │ │
│  │ Question answering with source attribution.                                 │ │
│  │                                                                             │ │
│  │ Arguments:                                                                  │ │
│  │   question: string (required)  - Natural language question                  │ │
│  │   context_ids?: string[]       - Specific entities to include as context   │ │
│  │   include_sources?: boolean    - Return source references (default: true)  │ │
│  │                                                                             │ │
│  │ Returns: { answer: string, sources: Source[], confidence: number }         │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │ nexus_find_related                                                          │ │
│  │ ─────────────────                                                           │ │
│  │                                                                             │ │
│  │ Find entities related to a given entity.                                    │ │
│  │                                                                             │ │
│  │ Arguments:                                                                  │ │
│  │   entity_id: string (required)      - Source entity UUID                    │ │
│  │   entity_type: EntityType (required)- Source entity type                    │ │
│  │   relationship_types?: string[]     - 'similar'|'linked'|'recent'          │ │
│  │   limit?: number                    - Max results (default: 10)             │ │
│  │                                                                             │ │
│  │ Returns: RelatedEntity[]                                                    │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
│  ENHANCED EXISTING TOOLS                                                         │
│  ───────────────────────                                                         │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │ nexus_search_notes (enhanced)                                               │ │
│  │                                                                             │ │
│  │ + mode?: 'keyword'|'semantic'|'hybrid'  (NEW - defaults to hybrid)         │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │ nexus_list_tasks (enhanced)                                                 │ │
│  │                                                                             │ │
│  │ + search?: string  (NEW - optional inline search filter)                    │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Security Model

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           SECURITY BOUNDARIES                                    │
└─────────────────────────────────────────────────────────────────────────────────┘

                    ┌─────────────────────────────────────┐
                    │            USER REQUEST              │
                    │                                      │
                    │  CF-Access-Jwt-Assertion: <jwt>     │
                    │  OR                                  │
                    │  Authorization: Bearer <token>      │
                    │  OR                                  │
                    │  X-Write-Passphrase: <passphrase>   │
                    └──────────────────┬──────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                              AUTH MIDDLEWARE                                      │
│                                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │ 1. Validate JWT/Token/Passphrase                                            │ │
│  │ 2. Extract tenant_id and user_id                                            │ │
│  │ 3. Inject into request context                                              │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                   │
│                                       │                                           │
│                                       ▼                                           │
│                         { tenantId: "...", userId: "..." }                       │
│                                                                                   │
└───────────────────────────────────────┬──────────────────────────────────────────┘
                                        │
                                        ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                              SEARCH LAYER                                         │
│                                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                         TENANT ISOLATION                                     │ │
│  │                                                                              │ │
│  │  ALL queries include:                                                        │ │
│  │                                                                              │ │
│  │  ┌─────────────────────────────────────────────────────────────────────────┐│ │
│  │  │  D1/FTS5:     WHERE tenant_id = ?                                       ││ │
│  │  │  Vectorize:   filter: { tenant_id: tenantId }                           ││ │
│  │  │  AI Search:   (per-tenant R2 bucket or prefix filtering)                ││ │
│  │  └─────────────────────────────────────────────────────────────────────────┘│ │
│  │                                                                              │ │
│  │  This is NON-NEGOTIABLE. Every search path enforces tenant isolation.       │ │
│  │                                                                              │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                         ENCRYPTION HANDLING                                  │ │
│  │                                                                              │ │
│  │  ┌─────────────────────────┐      ┌─────────────────────────────────────┐   │ │
│  │  │    STORAGE LAYER        │      │        SEARCH LAYER                 │   │ │
│  │  │                         │      │                                     │   │ │
│  │  │  title: ENCRYPTED       │      │  search_text: PLAINTEXT            │   │ │
│  │  │  description: ENCRYPTED │      │  (composite of searchable fields)  │   │ │
│  │  │  content: ENCRYPTED     │      │                                     │   │ │
│  │  │                         │      │  Vectors: Generated from plaintext │   │ │
│  │  │  Decrypted only when    │      │  before encryption                  │   │ │
│  │  │  returned to user       │      │                                     │   │ │
│  │  └─────────────────────────┘      └─────────────────────────────────────┘   │ │
│  │                                                                              │ │
│  │  TRADEOFF: search_text reveals keywords but not full content.               │ │
│  │  ACCEPTABLE: Single-user system, Cloudflare-hosted infrastructure.          │ │
│  │                                                                              │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                          RATE LIMITING                                       │ │
│  │                                                                              │ │
│  │  Per-tenant limits:                                                          │ │
│  │    • Standard search:  60 req/min                                            │ │
│  │    • AI/semantic:      20 req/min (more expensive)                          │ │
│  │    • Max results:      100 per query                                         │ │
│  │                                                                              │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

## Implementation Phases Timeline

```
Phase 1: Foundation                Phase 2: Semantic             Phase 3: Hybrid & MCP
──────────────────────────────────────────────────────────────────────────────────────

Week 1                             Week 2                         Week 3
┌──────────────────────────────┐   ┌──────────────────────────┐   ┌──────────────────────────┐
│ □ Create FTS5 indexes        │   │ □ Create Vectorize index │   │ □ Implement query        │
│   for all entity types       │   │   (nexus-embeddings)     │   │   analyzer               │
│                              │   │                          │   │                          │
│ □ Add search_text column     │   │ □ Implement IndexManager │   │ □ Add RRF result         │
│   to entities missing it     │   │   Durable Object         │   │   merging                │
│                              │   │                          │   │                          │
│ □ Implement unified          │   │ □ Add embedding gen on   │   │ □ Create nexus_search    │
│   /api/search endpoint       │   │   entity create/update   │   │   MCP tool               │
│   (keyword only)             │   │                          │   │                          │
│                              │   │ □ Implement vector       │   │ □ Create nexus_ask       │
│ □ Add ?search= parameter     │   │   search in /api/search  │   │   MCP tool               │
│   to list endpoints          │   │                          │   │                          │
│                              │   │ □ Backfill existing      │   │ □ Enhance                │
│                              │   │   entities               │   │   nexus_search_notes     │
└──────────────────────────────┘   └──────────────────────────┘   └──────────────────────────┘


Phase 4: Polish & Optimization
──────────────────────────────

Week 4
┌──────────────────────────────┐
│ □ Add search result          │
│   caching (KV)               │
│                              │
│ □ Implement rate limiting    │
│                              │
│ □ Add search analytics       │
│   (query patterns)           │
│                              │
│ □ Performance testing        │
│   and tuning                 │
│                              │
│ □ Documentation update       │
└──────────────────────────────┘
```

---

*Diagrams generated for Nexus AI Search Layer Architecture v1.0*
