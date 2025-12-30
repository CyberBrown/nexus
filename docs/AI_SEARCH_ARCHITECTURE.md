# AI Search Layer Architecture Design

**Status:** Design Complete - Ready for Implementation
**Version:** 1.0
**Date:** 2025-12-30
**Estimated Effort:** L (Large)

## Executive Summary

This document defines the architecture for integrating AI-powered semantic search into Nexus, enabling intelligent retrieval across all entity types (tasks, notes, ideas, people, projects, commitments). The design leverages Cloudflare's AI infrastructure while respecting Nexus's existing patterns for encryption, multi-tenancy, and service bindings.

---

## 1. Architecture Overview

### 1.1 Search Layer Strategy

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SEARCH ROUTER                                      │
│  (Determines search strategy based on query type and user intent)            │
└────────────────────────────┬────────────────────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  KEYWORD SEARCH │  │ SEMANTIC SEARCH │  │  HYBRID SEARCH  │
│  (FTS5 + D1)    │  │ (Vectorize AI)  │  │ (Combined RRF)  │
│                 │  │                 │  │                 │
│ • Exact matches │  │ • Meaning-based │  │ • Best of both  │
│ • Fast prefix   │  │ • Cross-entity  │  │ • Re-ranked     │
│ • Boolean ops   │  │ • Fuzzy intent  │  │ • Boosted       │
└─────────────────┘  └─────────────────┘  └─────────────────┘
         │                   │                   │
         └───────────────────┼───────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        RESULT AGGREGATOR                                     │
│  (Merge, dedupe, rank, apply access controls, return unified results)       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Integration Points

| Component | Integration Method | Purpose |
|-----------|-------------------|---------|
| **D1 (SQLite)** | Direct SQL + FTS5 | Keyword search, structured filters |
| **Vectorize** | Custom embeddings | Semantic search for encrypted data |
| **Workers AI** | `env.AI` binding | Generate embeddings via `@cf/baai/bge-base-en-v1.5` |
| **AI Search (AutoRAG)** | `env.AI.autorag()` | Document-level search (R2 stored docs) |
| **R2** | Document storage | PDFs, meeting notes, external documents |
| **MCP** | Tool extensions | Claude integration for search |

---

## 2. Data Flow Architecture

### 2.1 Write Path (Indexing)

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Create/Update│     │   Encrypt    │     │  Store D1    │
│    Entity    │────▶│   Fields     │────▶│  (Primary)   │
└──────────────┘     └──────────────┘     └──────────────┘
                                                 │
                                                 ▼
                     ┌──────────────────────────────────────┐
                     │          INDEXING PIPELINE           │
                     │  (Async via Durable Object queue)    │
                     └──────────────────────┬───────────────┘
                                            │
         ┌──────────────────────────────────┼──────────────────────────────────┐
         │                                  │                                  │
         ▼                                  ▼                                  ▼
┌─────────────────┐              ┌─────────────────┐              ┌─────────────────┐
│  FTS5 Index     │              │ Vectorize Index │              │ AI Search R2    │
│  (Plaintext     │              │ (Embeddings of  │              │ (For documents  │
│   search_text)  │              │  plaintext)     │              │  only)          │
└─────────────────┘              └─────────────────┘              └─────────────────┘
```

### 2.2 Read Path (Query)

```
┌──────────────┐
│ User Query   │
│ "projects    │
│  about AI"   │
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           QUERY ANALYZER                                      │
│  • Detect query type (keyword, semantic, hybrid)                              │
│  • Extract entities (specific entity types to search)                         │
│  • Identify intent (lookup vs. exploration)                                   │
│  • Parse filters (domain, status, date range)                                 │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │
       ┌───────────────────────────┼───────────────────────────────┐
       │                           │                               │
       ▼                           ▼                               ▼
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────────┐
│ FTS5 Query      │       │ Vector Query    │       │ AI Search Query     │
│ (D1 direct)     │       │ (Vectorize)     │       │ (AutoRAG for docs)  │
│                 │       │                 │       │                     │
│ • tasks         │       │ Generate embed- │       │ Only if query       │
│ • notes         │       │ ding for query  │       │ targets documents   │
│ • ideas         │       │ • Search all    │       │ in R2 bucket        │
│ • projects      │       │   entity indexes│       │                     │
│ • people        │       │ • Cosine sim    │       │                     │
└────────┬────────┘       └────────┬────────┘       └──────────┬──────────┘
         │                         │                           │
         └─────────────────────────┼───────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         RECIPROCAL RANK FUSION (RRF)                          │
│  • Combine results from multiple search strategies                            │
│  • Score: RRF(d) = Σ 1/(k + rank(d)) where k=60                               │
│  • Normalize scores, deduplicate, limit results                               │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         POST-PROCESSING                                       │
│  • Apply tenant_id filter (security)                                          │
│  • Decrypt relevant fields for display                                        │
│  • Enrich with related entities                                               │
│  • Format for API response                                                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Search Routing Logic

### 3.1 Query Classification

```typescript
interface QueryAnalysis {
  type: 'keyword' | 'semantic' | 'hybrid';
  entities: EntityType[];  // Which entity types to search
  filters: SearchFilters;
  intent: 'lookup' | 'exploration' | 'question';
  confidence: number;
}

type EntityType = 'tasks' | 'notes' | 'ideas' | 'projects' | 'people' | 'commitments' | 'documents';
```

### 3.2 Routing Decision Matrix

| Query Characteristic | Route To | Rationale |
|---------------------|----------|-----------|
| Exact phrase (`"..."`) | FTS5 only | Exact match required |
| Entity ID / UUID | D1 direct | Lookup by primary key |
| Short keyword (1-2 words) | Hybrid | Could be exact or semantic |
| Question format | Semantic | Intent-based retrieval |
| Domain/status filter | FTS5 + filter | Structured query |
| Long natural language | Semantic | Meaning over keywords |
| Special operators (`AND`, `OR`) | FTS5 | Boolean operations |

### 3.3 Query Analyzer Implementation

```typescript
function analyzeQuery(query: string): QueryAnalysis {
  const trimmed = query.trim();

  // Detect exact phrase search
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return { type: 'keyword', entities: ['all'], intent: 'lookup', confidence: 0.95 };
  }

  // Detect question format
  const questionWords = ['what', 'where', 'how', 'why', 'when', 'who', 'which'];
  if (questionWords.some(w => trimmed.toLowerCase().startsWith(w))) {
    return { type: 'semantic', entities: ['all'], intent: 'question', confidence: 0.85 };
  }

  // Detect entity-specific prefixes
  const entityPrefixes: Record<string, EntityType> = {
    'task:': 'tasks',
    'note:': 'notes',
    'idea:': 'ideas',
    'project:': 'projects',
    'person:': 'people',
    '@': 'people',  // @john searches people
  };

  for (const [prefix, entity] of Object.entries(entityPrefixes)) {
    if (trimmed.toLowerCase().startsWith(prefix)) {
      return {
        type: 'hybrid',
        entities: [entity],
        intent: 'lookup',
        confidence: 0.9
      };
    }
  }

  // Default: hybrid search across all entities
  const wordCount = trimmed.split(/\s+/).length;
  return {
    type: wordCount <= 3 ? 'hybrid' : 'semantic',
    entities: ['all'],
    intent: 'exploration',
    confidence: 0.7
  };
}
```

---

## 4. Index Architecture

### 4.1 FTS5 Indexes (Per Entity)

```sql
-- Notes FTS (already exists)
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  note_id UNINDEXED,
  search_text,
  tokenize='porter unicode61'
);

-- Tasks FTS (new)
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  task_id UNINDEXED,
  search_text,  -- title + description + tags
  tokenize='porter unicode61'
);

-- Ideas FTS (new)
CREATE VIRTUAL TABLE IF NOT EXISTS ideas_fts USING fts5(
  idea_id UNINDEXED,
  search_text,  -- title + description + tags + category
  tokenize='porter unicode61'
);

-- Projects FTS (new)
CREATE VIRTUAL TABLE IF NOT EXISTS projects_fts USING fts5(
  project_id UNINDEXED,
  search_text,  -- name + description + objective
  tokenize='porter unicode61'
);

-- People FTS (new)
CREATE VIRTUAL TABLE IF NOT EXISTS people_fts USING fts5(
  person_id UNINDEXED,
  search_text,  -- name + notes + tags
  tokenize='porter unicode61'
);

-- Unified search view (optional, for cross-entity keyword search)
CREATE VIEW unified_search AS
  SELECT 'task' as entity_type, task_id as entity_id, search_text FROM tasks_fts
  UNION ALL
  SELECT 'note', note_id, search_text FROM notes_fts
  UNION ALL
  SELECT 'idea', idea_id, search_text FROM ideas_fts
  UNION ALL
  SELECT 'project', project_id, search_text FROM projects_fts
  UNION ALL
  SELECT 'person', person_id, search_text FROM people_fts;
```

### 4.2 Vectorize Index Schema

```typescript
// Single unified vector index for all entities
// Dimension: 768 (bge-base-en-v1.5)
// Metric: cosine

interface VectorMetadata {
  entity_type: 'task' | 'note' | 'idea' | 'project' | 'person' | 'commitment';
  entity_id: string;
  tenant_id: string;
  title: string;           // For display in results
  created_at: string;      // For recency boosting
  domain?: string;         // For filtering
  status?: string;         // For filtering
  category?: string;       // For filtering
}

// Index name: nexus-embeddings
// Create command:
// npx wrangler vectorize create nexus-embeddings --dimensions=768 --metric=cosine
```

### 4.3 AI Search (AutoRAG) for Documents

AI Search automatically indexes documents uploaded to R2. Use for:
- PDFs (meeting notes, reports)
- External documents imported from email/calendar
- Knowledge base articles

```typescript
// Query AI Search for document-level search
const docResults = await env.AI.autorag('nexus-ai-search').aiSearch({
  query: searchQuery,
  // Optional: filter by metadata
});
```

---

## 5. Security Architecture

### 5.1 Encryption Considerations

**Problem:** Encrypted fields in D1 cannot be searched directly.

**Solution:** Dual-storage strategy:

```
┌─────────────────────────────────────────────────────────────────┐
│                    ENTITY STORAGE                                │
├─────────────────────────────────────────────────────────────────┤
│  D1 Primary Table                                                │
│  ├── id (plaintext)                                             │
│  ├── tenant_id (plaintext)                                      │
│  ├── title (ENCRYPTED - AES-256-GCM)                            │
│  ├── description (ENCRYPTED)                                     │
│  ├── search_text (PLAINTEXT - for FTS5)                         │
│  └── ...other fields                                             │
├─────────────────────────────────────────────────────────────────┤
│  FTS5 Virtual Table                                              │
│  ├── entity_id (UNINDEXED)                                      │
│  └── search_text (PLAINTEXT - tokenized)                        │
├─────────────────────────────────────────────────────────────────┤
│  Vectorize Index                                                 │
│  ├── vector (768-dim embedding of plaintext)                    │
│  └── metadata (tenant_id, entity_type, etc.)                    │
└─────────────────────────────────────────────────────────────────┘
```

**Security Tradeoff Analysis:**

| Approach | Searchability | Security | Performance |
|----------|--------------|----------|-------------|
| Encrypt + store plaintext search_text | Full | Good* | Fast |
| Decrypt on query (current people search) | Full | Best | Slow |
| Homomorphic encryption | Limited | Best | Very slow |

*`search_text` reveals content but not full document. Acceptable for current threat model (single-user, Cloudflare-hosted).

### 5.2 Access Control

```typescript
// All search queries MUST include tenant_id filter
async function search(env: Env, query: string, tenantId: string): Promise<SearchResult[]> {
  // FTS5 queries
  const ftsResults = await env.DB.prepare(`
    SELECT * FROM tasks_fts
    JOIN tasks ON tasks_fts.task_id = tasks.id
    WHERE tasks_fts MATCH ?
    AND tasks.tenant_id = ?  -- CRITICAL: tenant isolation
  `).bind(ftsQuery, tenantId).all();

  // Vector queries include tenant_id in filter
  const vectorResults = await env.VECTORIZE.query(embedding, {
    topK: 20,
    filter: { tenant_id: tenantId }  // CRITICAL: tenant isolation
  });

  return mergeResults(ftsResults, vectorResults);
}
```

### 5.3 Rate Limiting

```typescript
// Search is more expensive than CRUD - implement rate limits
const SEARCH_RATE_LIMITS = {
  perMinute: 60,      // Standard search
  perMinuteAI: 20,    // AI/semantic search (more expensive)
  maxResults: 100,    // Maximum results per query
};
```

---

## 6. MCP Tool Extensions

### 6.1 New Search Tools

```typescript
// Universal search across all entities
nexus_search({
  query: string,
  entities?: EntityType[],  // Default: all
  mode?: 'keyword' | 'semantic' | 'hybrid',  // Default: auto-detect
  filters?: {
    domain?: string,
    status?: string,
    created_after?: string,
    created_before?: string,
  },
  limit?: number,  // Default: 20
})

// Semantic question answering
nexus_ask({
  question: string,
  context_entities?: string[],  // Specific entity IDs for context
  include_sources?: boolean,    // Return source references
})

// Find related entities
nexus_find_related({
  entity_id: string,
  entity_type: EntityType,
  relationship_types?: ('similar' | 'linked' | 'recent')[],
  limit?: number,
})
```

### 6.2 Enhanced Existing Tools

```typescript
// Enhance nexus_search_notes to use hybrid search
nexus_search_notes({
  query: string,
  mode?: 'keyword' | 'semantic' | 'hybrid',  // NEW
  category?: string,
  source_type?: string,
  include_archived?: boolean,
})

// Add search to list tools
nexus_list_tasks({
  search?: string,  // NEW: optional search filter
  status?: string,
  domain?: string,
  project_id?: string,
})
```

---

## 7. API Endpoints

### 7.1 New Search Endpoints

```
POST /api/search
  Body: {
    query: string,
    entities?: string[],
    mode?: 'keyword' | 'semantic' | 'hybrid' | 'auto',
    filters?: object,
    limit?: number,
    offset?: number
  }
  Response: {
    success: true,
    data: {
      results: SearchResult[],
      total: number,
      query_analysis: QueryAnalysis,
      search_mode_used: string
    }
  }

POST /api/search/ask
  Body: {
    question: string,
    context_ids?: string[]
  }
  Response: {
    success: true,
    data: {
      answer: string,
      sources: Source[],
      confidence: number
    }
  }

GET /api/search/related/:entity_type/:id
  Response: {
    success: true,
    data: RelatedEntity[]
  }
```

### 7.2 Enhanced Entity Endpoints

All list endpoints gain optional `?search=` parameter:

```
GET /api/tasks?search=deployment+issues
GET /api/notes?search="architecture+design"
GET /api/ideas?search=AI+integration
GET /api/projects?search=nexus
GET /api/people?search=@john
```

---

## 8. Indexing Pipeline

### 8.1 IndexManager Durable Object

```typescript
export class IndexManager extends DurableObject {
  private queue: IndexJob[] = [];

  // Called when entities are created/updated
  async enqueue(job: IndexJob) {
    this.queue.push(job);
    // Process async to not block writes
    this.ctx.waitUntil(this.processQueue());
  }

  private async processQueue() {
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      await this.indexEntity(job);
    }
  }

  private async indexEntity(job: IndexJob) {
    const { entityType, entityId, plaintext, tenantId } = job;

    // 1. Update FTS5 index
    await this.updateFTS(entityType, entityId, plaintext);

    // 2. Generate and store embedding
    const embedding = await this.generateEmbedding(plaintext);
    await this.updateVectorize(entityType, entityId, tenantId, embedding);
  }

  private async generateEmbedding(text: string): Promise<Float32Array> {
    const response = await this.env.AI.run('@cf/baai/bge-base-en-v1.5', {
      text: [text]
    });
    return response.data[0];
  }
}
```

### 8.2 Index Job Schema

```typescript
interface IndexJob {
  type: 'create' | 'update' | 'delete';
  entityType: EntityType;
  entityId: string;
  tenantId: string;
  plaintext: string;  // Combined searchable text
  metadata: Record<string, string>;
  priority: 'high' | 'normal' | 'low';
}
```

### 8.3 Backfill Strategy

For existing data without embeddings:

```typescript
// One-time backfill job (run via /admin/backfill endpoint)
async function backfillEmbeddings(env: Env, entityType: EntityType, batchSize = 100) {
  const entities = await env.DB.prepare(`
    SELECT id, tenant_id, search_text
    FROM ${entityType}
    WHERE id NOT IN (
      SELECT entity_id FROM embedding_status WHERE entity_type = ?
    )
    LIMIT ?
  `).bind(entityType, batchSize).all();

  for (const entity of entities.results) {
    await indexManager.enqueue({
      type: 'create',
      entityType,
      entityId: entity.id,
      tenantId: entity.tenant_id,
      plaintext: entity.search_text,
      metadata: {},
      priority: 'low'
    });
  }
}
```

---

## 9. Performance Considerations

### 9.1 Caching Strategy

```typescript
// Cache frequently-accessed search results
const SEARCH_CACHE_TTL = 300; // 5 minutes

async function cachedSearch(env: Env, cacheKey: string, searchFn: () => Promise<SearchResult[]>) {
  const cached = await env.KV.get(cacheKey, 'json');
  if (cached) return cached;

  const results = await searchFn();
  await env.KV.put(cacheKey, JSON.stringify(results), { expirationTtl: SEARCH_CACHE_TTL });
  return results;
}
```

### 9.2 Query Optimization

| Operation | Target Latency | Optimization |
|-----------|---------------|--------------|
| FTS5 keyword search | <50ms | Index + limit |
| Vector similarity | <100ms | Top-K limiting |
| Hybrid merge | <150ms | Parallel execution |
| Decryption (per item) | <5ms | Batch when possible |

### 9.3 Cost Estimation

| Component | Cost Driver | Estimate |
|-----------|------------|----------|
| Workers AI (embeddings) | Per 1K tokens | ~$0.01 per 1K entities indexed |
| Vectorize | Per query + storage | Free tier: 5M queries/month |
| AI Search | Per query | Free tier: 1K queries/day |
| D1 | Rows read | Free tier: 5M reads/day |

---

## 10. Implementation Phases

### Phase 1: Foundation (Week 1)
- [ ] Create FTS5 indexes for all entity types
- [ ] Add `search_text` column to entities missing it
- [ ] Implement unified `/api/search` endpoint (keyword only)
- [ ] Add `?search=` parameter to list endpoints

### Phase 2: Semantic Search (Week 2)
- [ ] Create Vectorize index (`nexus-embeddings`)
- [ ] Implement IndexManager Durable Object
- [ ] Add embedding generation on entity create/update
- [ ] Implement vector search in `/api/search`
- [ ] Backfill existing entities

### Phase 3: Hybrid & MCP (Week 3)
- [ ] Implement query analyzer
- [ ] Add RRF result merging
- [ ] Create `nexus_search` MCP tool
- [ ] Create `nexus_ask` MCP tool
- [ ] Enhance `nexus_search_notes`

### Phase 4: Polish & Optimization (Week 4)
- [ ] Add search result caching
- [ ] Implement rate limiting
- [ ] Add search analytics (query patterns)
- [ ] Performance testing and tuning
- [ ] Documentation update

---

## 11. Configuration

### 11.1 wrangler.toml Additions

```toml
# Existing
[ai]
binding = "AI"

[[r2_buckets]]
binding = "AI_SEARCH_BUCKET"
bucket_name = "nexus-ai-search"

# New: Vectorize index for custom embeddings
[[vectorize]]
binding = "EMBEDDINGS"
index_name = "nexus-embeddings"

# New: IndexManager Durable Object
[[durable_objects.bindings]]
name = "INDEX_MANAGER"
class_name = "IndexManager"

[[migrations]]
tag = "v10"
new_sqlite_classes = ["IndexManager"]
```

### 11.2 Environment Variables

```toml
[vars]
# Search configuration
SEARCH_DEFAULT_LIMIT = "20"
SEARCH_MAX_LIMIT = "100"
EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5"
EMBEDDING_DIMENSIONS = "768"
```

---

## 12. Testing Strategy

### 12.1 Unit Tests

```typescript
describe('Search Router', () => {
  it('routes exact phrases to FTS5', async () => {
    const analysis = analyzeQuery('"exact phrase"');
    expect(analysis.type).toBe('keyword');
  });

  it('routes questions to semantic search', async () => {
    const analysis = analyzeQuery('What projects are about AI?');
    expect(analysis.type).toBe('semantic');
  });

  it('defaults to hybrid for ambiguous queries', async () => {
    const analysis = analyzeQuery('nexus deployment');
    expect(analysis.type).toBe('hybrid');
  });
});

describe('Result Merger', () => {
  it('deduplicates results from multiple sources', async () => {
    const ftsResults = [{ id: '1', score: 0.9 }, { id: '2', score: 0.8 }];
    const vectorResults = [{ id: '1', score: 0.85 }, { id: '3', score: 0.7 }];
    const merged = mergeResults(ftsResults, vectorResults);
    expect(merged.map(r => r.id)).toEqual(['1', '2', '3']);
  });
});
```

### 12.2 Integration Tests

```typescript
describe('Search API', () => {
  it('returns results across entity types', async () => {
    const response = await fetch('/api/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'AI integration' })
    });
    const data = await response.json();
    expect(data.data.results.length).toBeGreaterThan(0);
  });

  it('respects tenant isolation', async () => {
    // Create entities in tenant A and B
    // Search from tenant A should not see tenant B results
  });
});
```

---

## 13. Decision Log

| Decision | Options Considered | Chosen | Rationale |
|----------|-------------------|--------|-----------|
| Embedding model | bge-base, bge-large, text-embedding-3 | bge-base-en-v1.5 | 768 dim, good quality, Cloudflare native |
| Index strategy | Per-entity vs unified | Unified Vectorize | Simpler cross-entity search |
| Result merging | Simple concat vs RRF | RRF | Better ranking quality |
| Encryption handling | Decrypt-on-query vs plaintext search_text | plaintext search_text | Performance, acceptable security |
| Query routing | ML classifier vs rules | Rules-based | Simpler, predictable, debuggable |

---

## 14. Open Questions

1. **Q: Should we support natural language filters?**
   - E.g., "tasks from last week" → `created_after: 7d ago`
   - Recommendation: Defer to Phase 4 - use explicit filter params first

2. **Q: How to handle search across encrypted fields in future multi-tenant?**
   - Current: Single tenant, acceptable risk
   - Future: Consider searchable encryption or tenant-isolated indexes

3. **Q: Should search results include snippet highlighting?**
   - FTS5 supports snippets natively
   - Recommendation: Yes for Phase 3

---

## Appendix A: Query Examples

```typescript
// Keyword search
POST /api/search
{ "query": "\"AI architecture\"", "mode": "keyword" }

// Semantic search
POST /api/search
{ "query": "What are my current priorities?", "mode": "semantic" }

// Filtered search
POST /api/search
{
  "query": "deployment",
  "entities": ["tasks"],
  "filters": { "status": "next", "domain": "work" }
}

// Entity-specific search
GET /api/tasks?search=fix+bug&status=next

// Question answering
POST /api/search/ask
{ "question": "What was decided about the AI integration architecture?" }
```

---

## Appendix B: Error Handling

```typescript
class SearchError extends AppError {
  constructor(message: string, query: string) {
    super(message, 400, true, { query });
  }
}

// Specific errors
class QueryTooLongError extends SearchError {}
class InvalidFilterError extends SearchError {}
class SearchTimeoutError extends SearchError {}
class EmbeddingGenerationError extends SearchError {}
```

---

*Document authored by Claude Code for Nexus AI Search Layer integration.*
