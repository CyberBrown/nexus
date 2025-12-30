# AI Search Architecture Design Workshop

**Date:** 2025-12-30
**Status:** DECISIONS FINALIZED
**Participants:** Architecture Review Session

---

## Executive Summary

This document captures the finalized architecture decisions from the design workshop, resolving all open questions from the initial architecture document and providing implementation-ready specifications.

---

## 1. Current State Analysis

### 1.1 What Already Exists

| Component | Status | Location |
|-----------|--------|----------|
| D1 Database | Deployed | `nexus-db` |
| Notes FTS5 Index | Implemented | `notes_fts` virtual table |
| `search_text` Column | Notes only | `notes.search_text` |
| Workers AI Binding | Configured | `env.AI` |
| R2 Bucket | Configured | `nexus-ai-search` |
| Vectorize | **BLOCKED** | API token lacks permissions |
| `nexus_search_notes` MCP tool | Implemented | Full FTS5 support |

### 1.2 What Needs Implementation

| Component | Priority | Dependency |
|-----------|----------|------------|
| FTS5 indexes for other entities | P0 | None |
| `search_text` columns for tasks, ideas, projects, people | P0 | None |
| Unified `/api/search` endpoint | P1 | FTS5 indexes |
| IndexManager Durable Object | P1 | Vectorize (blocked) |
| Query Analyzer | P2 | Unified search endpoint |
| MCP `nexus_search` tool | P2 | Unified search endpoint |
| Semantic search (Vectorize) | P3 | **BLOCKED: API permissions** |

---

## 2. Key Architecture Decisions

### Decision 1: Vectorize Permission Resolution

**Problem:** Current API token lacks Vectorize permissions, blocking semantic search.

**Options Considered:**
1. Request Vectorize permissions for existing token
2. Use Workers AI embeddings + D1 for vector storage
3. Use external vector database (Pinecone, Weaviate)
4. Defer semantic search, ship keyword search first

**Decision:** **Option 4 - Defer semantic search**

**Rationale:**
- Keyword search (FTS5) provides immediate value
- Vectorize permissions can be requested separately
- No external dependencies or costs
- Notes search already proves the pattern works

**Action Items:**
- [ ] Request Vectorize permissions from Cloudflare dashboard
- [ ] Proceed with FTS5-only implementation for Phase 1
- [ ] Add Vectorize integration in Phase 2 when permissions granted

---

### Decision 2: Search Text Column Strategy

**Problem:** Which entities need `search_text` columns and what fields to include?

**Decision:** Add `search_text` to all searchable entities:

```sql
-- Tasks: title + description + tags + contexts + project name
ALTER TABLE tasks ADD COLUMN search_text TEXT;

-- Ideas: title + description + tags + category
ALTER TABLE ideas ADD COLUMN search_text TEXT;

-- Projects: name + description + objective + tags
ALTER TABLE projects ADD COLUMN search_text TEXT;

-- People: name + notes + organization + role + tags
ALTER TABLE people ADD COLUMN search_text TEXT;

-- Commitments: description + person_name + context
ALTER TABLE commitments ADD COLUMN search_text TEXT;
```

**Implementation Note:**
- Build `search_text` at write time (create/update)
- Include denormalized references (e.g., project name in task search_text)
- Store lowercase for consistent FTS5 matching

---

### Decision 3: FTS5 Index Schema

**Decision:** Create per-entity FTS5 virtual tables:

```sql
-- Tasks FTS
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  task_id UNINDEXED,
  search_text,
  tokenize='porter unicode61'
);

-- Ideas FTS
CREATE VIRTUAL TABLE IF NOT EXISTS ideas_fts USING fts5(
  idea_id UNINDEXED,
  search_text,
  tokenize='porter unicode61'
);

-- Projects FTS
CREATE VIRTUAL TABLE IF NOT EXISTS projects_fts USING fts5(
  project_id UNINDEXED,
  search_text,
  tokenize='porter unicode61'
);

-- People FTS
CREATE VIRTUAL TABLE IF NOT EXISTS people_fts USING fts5(
  person_id UNINDEXED,
  search_text,
  tokenize='porter unicode61'
);

-- Commitments FTS
CREATE VIRTUAL TABLE IF NOT EXISTS commitments_fts USING fts5(
  commitment_id UNINDEXED,
  search_text,
  tokenize='porter unicode61'
);
```

**Why per-entity tables instead of unified:**
- Simpler tenant isolation (join with main table for tenant_id)
- Easier to maintain and debug
- Better performance for entity-specific searches
- FTS5 MATCH works better with smaller, focused indexes

---

### Decision 4: Search Routing Logic (Phase 1 - Keyword Only)

**Decision:** Simple routing based on query syntax:

```typescript
interface SearchRequest {
  query: string;
  entities?: ('tasks' | 'notes' | 'ideas' | 'projects' | 'people' | 'commitments')[];
  filters?: {
    domain?: string;
    status?: string;
    created_after?: string;
    created_before?: string;
  };
  limit?: number;
  offset?: number;
}

function routeSearch(request: SearchRequest): SearchStrategy {
  const { query, entities } = request;

  // Detect entity-specific prefix
  const prefixMatch = query.match(/^(task|note|idea|project|person|@):(.+)/i);
  if (prefixMatch) {
    const entityType = prefixMatch[1].toLowerCase() === '@' ? 'people' : prefixMatch[1] + 's';
    return {
      strategy: 'keyword',
      entities: [entityType],
      query: prefixMatch[2].trim()
    };
  }

  // Default: search specified entities or all
  return {
    strategy: 'keyword',
    entities: entities || ['tasks', 'notes', 'ideas', 'projects', 'people', 'commitments'],
    query: query
  };
}
```

---

### Decision 5: API Endpoint Design

**Decision:** Single unified search endpoint with entity-specific shortcuts:

```
# Unified search
POST /api/search
{
  "query": "AI integration",
  "entities": ["tasks", "ideas"],
  "filters": { "domain": "work" },
  "limit": 20
}

# Entity list endpoints gain ?search parameter
GET /api/tasks?search=deployment&status=next
GET /api/notes?search="meeting notes"
GET /api/ideas?search=AI&category=research
GET /api/projects?search=nexus
GET /api/people?search=john
```

---

### Decision 6: Result Format

**Decision:** Consistent search result format across all entities:

```typescript
interface SearchResult {
  entity_type: 'task' | 'note' | 'idea' | 'project' | 'person' | 'commitment';
  entity_id: string;
  title: string;           // Primary display text
  snippet: string | null;  // Context snippet with match highlighted
  score: number;           // BM25 score from FTS5
  metadata: {
    status?: string;
    domain?: string;
    created_at: string;
    [key: string]: unknown;
  };
}

interface SearchResponse {
  success: true;
  data: {
    results: SearchResult[];
    total: number;
    query_info: {
      original_query: string;
      parsed_query: string;    // FTS5 formatted
      entities_searched: string[];
      strategy: 'keyword' | 'semantic' | 'hybrid';
    };
  };
}
```

---

### Decision 7: MCP Tool Design

**Decision:** Two new MCP tools, one enhanced existing tool:

```typescript
// NEW: Universal search
nexus_search({
  query: string,            // Required: search query
  entities?: string[],      // Optional: filter to entity types
  domain?: string,          // Optional: filter by domain
  status?: string,          // Optional: filter by status
  limit?: number,           // Optional: max results (default: 20)
})

// NEW: Find related entities (uses vector similarity when available)
nexus_find_related({
  entity_id: string,        // Required: source entity UUID
  entity_type: string,      // Required: source entity type
  limit?: number,           // Optional: max results (default: 10)
})

// ENHANCED: Add mode parameter to existing tool
nexus_search_notes({
  query: string,
  category?: string,
  source_type?: string,
  include_archived?: boolean,
  mode?: 'keyword' | 'semantic' | 'hybrid',  // NEW (Phase 2)
})
```

---

## 3. Data Flow Architecture (Finalized)

### 3.1 Write Path (Indexing)

```
                     CREATE/UPDATE Entity
                              │
                              ▼
                   ┌──────────────────────┐
                   │  Build search_text   │
                   │  from plaintext      │
                   │  fields              │
                   └──────────┬───────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
    ┌─────────────────┐             ┌─────────────────┐
    │  Store in D1    │             │  Update FTS5    │
    │  (with encrypt) │             │  Index          │
    │                 │             │  (plaintext)    │
    └─────────────────┘             └─────────────────┘
              │                               │
              │                               │
              ▼                               ▼
    ┌─────────────────────────────────────────────────┐
    │               PHASE 2 (when Vectorize enabled)  │
    │                                                 │
    │  ┌────────────────┐     ┌────────────────────┐  │
    │  │ Generate       │     │ Upsert to          │  │
    │  │ Embedding      │────▶│ Vectorize          │  │
    │  │ (Workers AI)   │     │ Index              │  │
    │  └────────────────┘     └────────────────────┘  │
    └─────────────────────────────────────────────────┘
```

### 3.2 Read Path (Query - Phase 1)

```
         User Query: "AI projects"
                    │
                    ▼
         ┌─────────────────────┐
         │   Parse Query       │
         │   - Extract prefix  │
         │   - Format for FTS5 │
         └──────────┬──────────┘
                    │
    ┌───────────────┼───────────────┐
    │               │               │
    ▼               ▼               ▼
┌────────┐    ┌────────┐     ┌────────┐
│tasks_  │    │ideas_  │     │projects│
│fts     │    │fts     │     │_fts    │
│        │    │        │     │        │
│ MATCH  │    │ MATCH  │     │ MATCH  │
│ query  │    │ query  │     │ query  │
└───┬────┘    └───┬────┘     └───┬────┘
    │             │              │
    └──────────┬──┴──────────────┘
               │
               ▼
    ┌─────────────────────┐
    │ Merge Results       │
    │ - Collect all       │
    │ - Sort by BM25      │
    │ - Apply tenant_id   │
    │ - Limit results     │
    └──────────┬──────────┘
               │
               ▼
    ┌─────────────────────┐
    │ Post-Process        │
    │ - Decrypt titles    │
    │ - Build snippets    │
    │ - Format response   │
    └─────────────────────┘
```

---

## 4. Implementation Phases (Revised)

### Phase 1: Foundation (Keyword Search) - Week 1

**Scope:** Full-text search across all entities

**Tasks:**
1. **Database Migrations**
   - Add `search_text` column to: tasks, ideas, projects, people, commitments
   - Create FTS5 virtual tables for all entities
   - Create triggers or app-level hooks to maintain FTS indexes

2. **Search Service**
   - Create `src/lib/search.ts` with:
     - Query parser (handle quotes, prefixes)
     - FTS5 query builder
     - Result merger and formatter

3. **API Endpoints**
   - Create `/api/search` POST endpoint
   - Add `?search=` to list endpoints (tasks, ideas, projects, people)

4. **Backfill Script**
   - Create `nexus_rebuild_search_indexes` MCP tool
   - Populate `search_text` for existing entities
   - Rebuild FTS indexes

5. **Testing**
   - Unit tests for query parser
   - Integration tests for search endpoint
   - Manual testing via MCP tools

**Deliverables:**
- [ ] Database migration script
- [ ] `src/lib/search.ts` module
- [ ] `/api/search` endpoint
- [ ] `?search=` on list endpoints
- [ ] `nexus_rebuild_search_indexes` tool
- [ ] Test coverage

---

### Phase 2: MCP Tools & Enhancements - Week 2

**Scope:** MCP integration and search improvements

**Tasks:**
1. **MCP Tools**
   - Create `nexus_search` universal search tool
   - Add `mode` parameter to `nexus_search_notes`
   - Create `nexus_find_related` (keyword-based for now)

2. **Search Improvements**
   - Add snippet generation (context around matches)
   - Add result caching (KV with 5-minute TTL)
   - Add search analytics logging

3. **Documentation**
   - Update MCP tool descriptions
   - Add search examples to docs

**Deliverables:**
- [ ] `nexus_search` MCP tool
- [ ] Enhanced `nexus_search_notes`
- [ ] `nexus_find_related` tool
- [ ] Search caching
- [ ] Updated documentation

---

### Phase 3: Semantic Search (Pending Vectorize) - Week 3

**Blocked on:** Vectorize API permissions

**Tasks (when unblocked):**
1. Create Vectorize index `nexus-embeddings`
2. Implement IndexManager Durable Object
3. Add embedding generation on entity write
4. Backfill existing entities with embeddings
5. Implement hybrid search (RRF merging)
6. Update query router to use semantic search for questions

**Deliverables:**
- [ ] Vectorize index configured
- [ ] IndexManager DO
- [ ] Hybrid search implementation
- [ ] Backfill script for embeddings

---

### Phase 4: Polish & Optimization - Week 4

**Tasks:**
1. Performance tuning
2. Rate limiting
3. Search analytics dashboard
4. Edge cases and error handling
5. Load testing

---

## 5. Technical Specifications

### 5.1 Query Parser Specification

```typescript
interface ParsedQuery {
  terms: string[];           // Individual search terms
  phrases: string[];         // Quoted exact phrases
  entityPrefix: string | null;  // e.g., "task:", "@"
  ftsQuery: string;          // Formatted for FTS5 MATCH
}

function parseSearchQuery(query: string): ParsedQuery {
  // 1. Extract entity prefix
  const prefixMatch = query.match(/^(task|note|idea|project|person|@):(.+)/i);
  const entityPrefix = prefixMatch ? prefixMatch[1] : null;
  const cleanQuery = prefixMatch ? prefixMatch[2] : query;

  // 2. Extract quoted phrases
  const phrases: string[] = [];
  const phraseRegex = /"([^"]+)"/g;
  let match;
  while ((match = phraseRegex.exec(cleanQuery)) !== null) {
    phrases.push(match[1].toLowerCase());
  }

  // 3. Extract individual terms
  const withoutPhrases = cleanQuery.replace(phraseRegex, '');
  const terms = withoutPhrases
    .split(/\s+/)
    .filter(t => t.length > 0)
    .map(t => t.toLowerCase().replace(/[*^"():]/g, ''));

  // 4. Build FTS5 query
  // Use search_text: prefix for D1 FTS5 compatibility
  const ftsParts = [
    ...terms.map(t => `search_text:${t}`),
    ...phrases.map(p => `search_text:"${p}"`)
  ];
  const ftsQuery = ftsParts.join(' ');

  return { terms, phrases, entityPrefix, ftsQuery };
}
```

### 5.2 FTS5 Query Execution

```typescript
async function searchEntity(
  db: D1Database,
  entityType: string,
  ftsQuery: string,
  tenantId: string,
  userId: string,
  limit: number = 20
): Promise<FtsResult[]> {
  const tableName = `${entityType}_fts`;
  const mainTable = entityType;
  const idColumn = `${entityType.slice(0, -1)}_id`; // tasks -> task_id

  const result = await db.prepare(`
    SELECT
      m.*,
      bm25(${tableName}) as score
    FROM ${tableName} f
    INNER JOIN ${mainTable} m ON f.${idColumn} = m.id
    WHERE ${tableName} MATCH ?
      AND m.tenant_id = ?
      AND m.user_id = ?
      AND m.deleted_at IS NULL
    ORDER BY bm25(${tableName}) ASC
    LIMIT ?
  `).bind(ftsQuery, tenantId, userId, limit).all();

  return result.results;
}
```

### 5.3 Result Merging

```typescript
function mergeSearchResults(
  resultsByEntity: Map<string, FtsResult[]>,
  limit: number
): SearchResult[] {
  const allResults: SearchResult[] = [];

  for (const [entityType, results] of resultsByEntity) {
    for (const result of results) {
      allResults.push({
        entity_type: entityType,
        entity_id: result.id,
        title: result.title || result.name || result.description?.slice(0, 100),
        snippet: null, // TODO: Generate snippet
        score: Math.abs(result.score), // BM25 returns negative
        metadata: {
          status: result.status,
          domain: result.domain,
          created_at: result.created_at,
        }
      });
    }
  }

  // Sort by score descending
  allResults.sort((a, b) => b.score - a.score);

  return allResults.slice(0, limit);
}
```

---

## 6. Security Considerations

### 6.1 Tenant Isolation (Critical)

**Every search query MUST include tenant_id filtering:**

```sql
-- Correct: Always join with main table for tenant_id
SELECT m.* FROM tasks_fts f
INNER JOIN tasks m ON f.task_id = m.id
WHERE tasks_fts MATCH ?
  AND m.tenant_id = ?  -- CRITICAL
  AND m.user_id = ?

-- WRONG: Never query FTS without tenant filter
SELECT * FROM tasks_fts WHERE MATCH ?  -- SECURITY VULNERABILITY
```

### 6.2 Input Sanitization

```typescript
function sanitizeFtsInput(term: string): string {
  // Remove FTS5 special characters that could cause injection
  return term.replace(/[*^"():{}[\]]/g, '');
}
```

### 6.3 Rate Limiting

```typescript
const SEARCH_RATE_LIMITS = {
  keywordSearchPerMinute: 60,
  semanticSearchPerMinute: 20,  // Phase 2
  maxResultsPerQuery: 100,
};
```

---

## 7. Open Items for Future Phases

### 7.1 Natural Language Filters (Deferred)
- "tasks from last week" → `created_after: 7 days ago`
- Requires NLU/LLM processing
- Consider for Phase 4 or later

### 7.2 Snippet Highlighting (Phase 2)
- FTS5 `snippet()` function for context
- Highlight matching terms in UI

### 7.3 Multi-Tenant Vector Isolation (Future)
- When moving to true multi-tenant
- Consider per-tenant Vectorize indexes or prefix filtering

### 7.4 Search Analytics (Phase 4)
- Track popular queries
- Track zero-result queries
- Track click-through on results

---

## 8. Appendix: Migration Scripts

### 8.1 Add search_text Columns

```sql
-- Run via D1 migrations or wrangler d1 execute

-- Tasks
ALTER TABLE tasks ADD COLUMN search_text TEXT;

-- Ideas
ALTER TABLE ideas ADD COLUMN search_text TEXT;

-- Projects
ALTER TABLE projects ADD COLUMN search_text TEXT;

-- People
ALTER TABLE people ADD COLUMN search_text TEXT;

-- Commitments
ALTER TABLE commitments ADD COLUMN search_text TEXT;
```

### 8.2 Create FTS5 Tables

```sql
-- Tasks FTS
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  task_id UNINDEXED,
  search_text,
  tokenize='porter unicode61'
);

-- Ideas FTS
CREATE VIRTUAL TABLE IF NOT EXISTS ideas_fts USING fts5(
  idea_id UNINDEXED,
  search_text,
  tokenize='porter unicode61'
);

-- Projects FTS
CREATE VIRTUAL TABLE IF NOT EXISTS projects_fts USING fts5(
  project_id UNINDEXED,
  search_text,
  tokenize='porter unicode61'
);

-- People FTS
CREATE VIRTUAL TABLE IF NOT EXISTS people_fts USING fts5(
  person_id UNINDEXED,
  search_text,
  tokenize='porter unicode61'
);

-- Commitments FTS
CREATE VIRTUAL TABLE IF NOT EXISTS commitments_fts USING fts5(
  commitment_id UNINDEXED,
  search_text,
  tokenize='porter unicode61'
);
```

---

*Workshop decisions finalized: 2025-12-30*
*Ready for Phase 1 implementation*
