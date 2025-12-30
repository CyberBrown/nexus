# AI Search Data Flow Specification

**Version:** 1.0
**Date:** 2025-12-30
**Status:** Implementation Ready

---

## 1. Overview

This document provides detailed data flow specifications for the AI Search layer in Nexus. It covers both the current Phase 1 (keyword-only) implementation and the future Phase 2+ (semantic) implementation.

---

## 2. Write Path (Indexing)

### 2.1 Entity Creation Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           API REQUEST                                        │
│                    POST /api/tasks or MCP nexus_create_task                 │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          VALIDATION LAYER                                    │
│  • Zod schema validation                                                     │
│  • Required field checks                                                     │
│  • Type coercion                                                             │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     BUILD SEARCH TEXT                                        │
│                                                                              │
│  // Example for tasks                                                        │
│  const searchText = [                                                        │
│    title,                           // "Fix login bug"                       │
│    description ?? '',               // "Users can't login with email"        │
│    tags ?? '',                      // "bug,urgent,auth"                     │
│    contexts ?? '',                  // "@computer,@focus"                    │
│    projectName ?? ''                // "Authentication Overhaul" (denorm)   │
│  ].filter(Boolean).join(' ').toLowerCase();                                  │
│                                                                              │
│  Result: "fix login bug users can't login with email bug urgent auth        │
│           @computer @focus authentication overhaul"                          │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                    ┌────────────────┴────────────────┐
                    │                                 │
                    ▼                                 ▼
┌───────────────────────────────────┐  ┌───────────────────────────────────────┐
│        D1 MAIN TABLE              │  │        FTS5 INDEX UPDATE              │
│                                   │  │                                       │
│  INSERT INTO tasks (              │  │  INSERT INTO tasks_fts (              │
│    id,                            │  │    task_id,                           │
│    tenant_id,                     │  │    search_text                        │
│    title,       -- ENCRYPTED      │  │  ) VALUES (?, ?)                      │
│    description, -- ENCRYPTED      │  │                                       │
│    search_text, -- PLAINTEXT      │  │  -- search_text stored in plaintext   │
│    ...                            │  │  -- for FTS5 tokenization             │
│  )                                │  │                                       │
└───────────────────────────────────┘  └───────────────────────────────────────┘
                    │                                 │
                    └────────────────┬────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     PHASE 2: VECTOR INDEXING (FUTURE)                        │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  IndexManager Durable Object                                         │    │
│  │                                                                      │    │
│  │  1. Receive indexing job via alarm or direct call                    │    │
│  │                                                                      │    │
│  │  2. Generate embedding:                                              │    │
│  │     const embedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', {│    │
│  │       text: [searchText]                                             │    │
│  │     });                                                              │    │
│  │                                                                      │    │
│  │  3. Upsert to Vectorize:                                             │    │
│  │     await env.VECTORIZE.upsert([{                                    │    │
│  │       id: `${entityType}-${entityId}`,                               │    │
│  │       values: embedding.data[0],                                     │    │
│  │       metadata: {                                                    │    │
│  │         entity_type: 'task',                                         │    │
│  │         entity_id: entityId,                                         │    │
│  │         tenant_id: tenantId,                                         │    │
│  │         title: title,                                                │    │
│  │         domain: domain                                               │    │
│  │       }                                                              │    │
│  │     }]);                                                             │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Entity Update Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           API REQUEST                                        │
│                    PATCH /api/tasks/:id or MCP nexus_update_task            │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     DETECT SEARCHABLE FIELD CHANGES                          │
│                                                                              │
│  const searchableFields = ['title', 'description', 'tags', 'contexts'];      │
│  const hasSearchableChanges = searchableFields.some(f => updates[f]);        │
│                                                                              │
│  if (!hasSearchableChanges) {                                                │
│    // Skip search index update, just update D1                               │
│    return updateD1Only();                                                    │
│  }                                                                           │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     REBUILD SEARCH TEXT                                      │
│                                                                              │
│  // Get current values for unchanged fields                                  │
│  const currentTitle = updates.title ?? (await decrypt(existing.title));      │
│  const currentDesc = updates.description ?? existing.description;            │
│  // ... etc                                                                  │
│                                                                              │
│  const newSearchText = buildSearchText(currentTitle, currentDesc, ...);      │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                    ┌────────────────┴────────────────┐
                    │                                 │
                    ▼                                 ▼
┌───────────────────────────────────┐  ┌───────────────────────────────────────┐
│        D1 UPDATE                  │  │        FTS5 INDEX UPDATE              │
│                                   │  │                                       │
│  UPDATE tasks SET                 │  │  DELETE FROM tasks_fts               │
│    title = ?,                     │  │  WHERE task_id = ?;                   │
│    search_text = ?,               │  │                                       │
│    updated_at = ?                 │  │  INSERT INTO tasks_fts               │
│  WHERE id = ?                     │  │  (task_id, search_text)               │
│                                   │  │  VALUES (?, ?);                       │
└───────────────────────────────────┘  └───────────────────────────────────────┘
```

### 2.3 Entity Deletion Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           API REQUEST                                        │
│                    DELETE /api/tasks/:id                                     │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                                     ▼
┌───────────────────────────────────┐  ┌───────────────────────────────────────┐
│        D1 SOFT DELETE             │  │        FTS5 INDEX REMOVAL             │
│                                   │  │                                       │
│  UPDATE tasks SET                 │  │  DELETE FROM tasks_fts               │
│    deleted_at = ?                 │  │  WHERE task_id = ?;                   │
│  WHERE id = ?                     │  │                                       │
└───────────────────────────────────┘  └───────────────────────────────────────┘
                                                        │
                                                        ▼
                                     ┌───────────────────────────────────────┐
                                     │  PHASE 2: VECTOR DELETION             │
                                     │                                       │
                                     │  await env.VECTORIZE.deleteByIds([    │
                                     │    `task-${taskId}`                   │
                                     │  ]);                                   │
                                     └───────────────────────────────────────┘
```

---

## 3. Read Path (Query Execution)

### 3.1 Query Processing Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           USER QUERY                                         │
│                                                                              │
│  POST /api/search                                                            │
│  {                                                                           │
│    "query": "AI projects @computer",                                         │
│    "entities": ["tasks", "ideas"],                                           │
│    "filters": { "domain": "work" }                                           │
│  }                                                                           │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     STEP 1: AUTHENTICATION                                   │
│                                                                              │
│  const { tenantId, userId } = getAuth(c);                                    │
│  // Extract from JWT, Access header, or passphrase                           │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     STEP 2: QUERY PARSING                                    │
│                                                                              │
│  Input: "AI projects @computer"                                              │
│                                                                              │
│  ParsedQuery {                                                               │
│    terms: ['ai', 'projects', '@computer'],                                   │
│    phrases: [],                                                              │
│    entityPrefix: null,                                                       │
│    ftsQuery: 'search_text:ai search_text:projects search_text:@computer'     │
│  }                                                                           │
│                                                                              │
│  // Handle special cases:                                                    │
│  // - "task: fix bug"     → entityPrefix: 'tasks', query: 'fix bug'          │
│  // - "@john"             → entityPrefix: 'people', query: 'john'            │
│  // - "\"exact phrase\""  → phrases: ['exact phrase']                        │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     STEP 3: SEARCH STRATEGY SELECTION (PHASE 1)              │
│                                                                              │
│  // Phase 1: Always use keyword search                                       │
│  const strategy = 'keyword';                                                 │
│                                                                              │
│  // Phase 2 will add:                                                        │
│  // if (isQuestion(query)) strategy = 'semantic';                            │
│  // else strategy = 'hybrid';                                                │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     STEP 4: PARALLEL FTS5 QUERIES                            │
│                                                                              │
│  const entitiesToSearch = request.entities ?? ALL_ENTITIES;                  │
│                                                                              │
│  const results = await Promise.all(                                          │
│    entitiesToSearch.map(entityType =>                                        │
│      searchEntity(db, entityType, ftsQuery, tenantId, userId, filters)       │
│    )                                                                         │
│  );                                                                           │
│                                                                              │
│  // Each query:                                                              │
│  // SELECT m.*, bm25(tasks_fts) as score                                     │
│  // FROM tasks_fts f                                                         │
│  // INNER JOIN tasks m ON f.task_id = m.id                                   │
│  // WHERE tasks_fts MATCH 'search_text:ai search_text:projects...'           │
│  //   AND m.tenant_id = ?                                                    │
│  //   AND m.user_id = ?                                                      │
│  //   AND m.deleted_at IS NULL                                               │
│  //   AND m.domain = 'work'  -- from filters                                 │
│  // ORDER BY bm25(tasks_fts) ASC                                             │
│  // LIMIT 50                                                                 │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     STEP 5: RESULT MERGING                                   │
│                                                                              │
│  // Collect results from all entity searches                                 │
│  const allResults: SearchResult[] = [];                                      │
│                                                                              │
│  for (const [entityType, entityResults] of results) {                        │
│    for (const row of entityResults) {                                        │
│      allResults.push({                                                       │
│        entity_type: entityType,                                              │
│        entity_id: row.id,                                                    │
│        title: row.title ?? row.name,                                         │
│        snippet: null, // Built in post-processing                            │
│        score: Math.abs(row.score), // BM25 returns negative                  │
│        metadata: {                                                           │
│          status: row.status,                                                 │
│          domain: row.domain,                                                 │
│          created_at: row.created_at                                          │
│        }                                                                     │
│      });                                                                     │
│    }                                                                         │
│  }                                                                           │
│                                                                              │
│  // Sort by score descending (higher is more relevant)                       │
│  allResults.sort((a, b) => b.score - a.score);                               │
│                                                                              │
│  // Apply limit                                                              │
│  const limited = allResults.slice(0, request.limit ?? 20);                   │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     STEP 6: POST-PROCESSING                                  │
│                                                                              │
│  const encryptionKey = await getEncryptionKey(env.KV, tenantId);             │
│                                                                              │
│  for (const result of limited) {                                             │
│    // Decrypt title for display                                              │
│    result.title = await decryptField(result.title, encryptionKey);           │
│                                                                              │
│    // Build snippet (Phase 2)                                                │
│    // result.snippet = buildSnippet(searchText, query);                      │
│  }                                                                           │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     STEP 7: RESPONSE                                         │
│                                                                              │
│  return {                                                                    │
│    success: true,                                                            │
│    data: {                                                                   │
│      results: limited,                                                       │
│      total: allResults.length,                                               │
│      query_info: {                                                           │
│        original_query: "AI projects @computer",                              │
│        parsed_query: "search_text:ai search_text:projects...",               │
│        entities_searched: ["tasks", "ideas"],                                │
│        strategy: "keyword"                                                   │
│      }                                                                       │
│    }                                                                         │
│  }                                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Phase 2: Hybrid Search Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           HYBRID SEARCH (PHASE 2)                            │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                                     ▼
                    ┌────────────────┴────────────────┐
                    │                                 │
                    ▼                                 ▼
┌───────────────────────────────────┐  ┌───────────────────────────────────────┐
│     KEYWORD PATH (FTS5)           │  │     SEMANTIC PATH (VECTORIZE)         │
│                                   │  │                                       │
│  SELECT m.*, bm25() as score      │  │  1. Generate query embedding:         │
│  FROM entity_fts f                │  │     const queryEmbed = await env.AI   │
│  INNER JOIN entity m ...          │  │       .run('@cf/baai/bge-base-en',    │
│  WHERE MATCH ?                    │  │         { text: [query] });           │
│                                   │  │                                       │
│  Result:                          │  │  2. Query Vectorize:                  │
│  [{id: 'a', score: 0.8}, ...]     │  │     const results = await env.VECTOR  │
│                                   │  │       .query(queryEmbed.data[0], {    │
│                                   │  │         topK: 50,                     │
│                                   │  │         filter: {tenant_id: tid}      │
│                                   │  │       });                             │
│                                   │  │                                       │
│                                   │  │  Result:                              │
│                                   │  │  [{id: 'b', score: 0.92}, ...]        │
└───────────────────────────────────┘  └───────────────────────────────────────┘
                    │                                 │
                    └────────────────┬────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     RECIPROCAL RANK FUSION (RRF)                             │
│                                                                              │
│  // RRF formula: score(d) = Σ 1/(k + rank_i(d))  where k = 60               │
│                                                                              │
│  const k = 60;                                                               │
│  const rrfScores = new Map<string, number>();                                │
│                                                                              │
│  // Add keyword scores                                                       │
│  keywordResults.forEach((result, rank) => {                                  │
│    const id = result.id;                                                     │
│    const rrfContrib = 1 / (k + rank + 1);                                    │
│    rrfScores.set(id, (rrfScores.get(id) ?? 0) + rrfContrib);                 │
│  });                                                                         │
│                                                                              │
│  // Add semantic scores                                                      │
│  semanticResults.forEach((result, rank) => {                                 │
│    const id = result.id;                                                     │
│    const rrfContrib = 1 / (k + rank + 1);                                    │
│    rrfScores.set(id, (rrfScores.get(id) ?? 0) + rrfContrib);                 │
│  });                                                                         │
│                                                                              │
│  // Sort by combined RRF score                                               │
│  const merged = [...rrfScores.entries()]                                     │
│    .sort((a, b) => b[1] - a[1])                                              │
│    .map(([id, score]) => ({ id, score }));                                   │
│                                                                              │
│  // Example:                                                                 │
│  // 'a' appeared at rank 1 in keyword, rank 5 in semantic                    │
│  // RRF(a) = 1/(60+1) + 1/(60+5) = 0.0164 + 0.0154 = 0.0318                  │
│  //                                                                          │
│  // 'b' appeared at rank 3 in keyword, rank 1 in semantic                    │
│  // RRF(b) = 1/(60+3) + 1/(60+1) = 0.0159 + 0.0164 = 0.0323  <- higher      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Search Text Construction Per Entity

### 4.1 Tasks

```typescript
function buildTaskSearchText(task: Task, projectName?: string): string {
  return [
    task.title,
    task.description,
    task.tags,
    task.contexts,
    projectName,  // Denormalized for searchability
  ].filter(Boolean).join(' ').toLowerCase();
}

// Example:
// title: "Fix login bug"
// description: "Users can't login with email"
// tags: "bug,auth"
// contexts: "@computer"
// projectName: "Auth Overhaul"
//
// search_text: "fix login bug users can't login with email bug auth @computer auth overhaul"
```

### 4.2 Ideas

```typescript
function buildIdeaSearchText(idea: Idea): string {
  return [
    idea.title,
    idea.description,
    idea.tags,
    idea.category,
  ].filter(Boolean).join(' ').toLowerCase();
}

// Example:
// title: "AI-powered code review"
// description: "Use Claude to review PRs automatically"
// tags: "ai,automation,developer-tools"
// category: "research"
//
// search_text: "ai-powered code review use claude to review prs automatically ai automation developer-tools research"
```

### 4.3 Projects

```typescript
function buildProjectSearchText(project: Project): string {
  return [
    project.name,
    project.description,
    project.objective,
    project.tags,
  ].filter(Boolean).join(' ').toLowerCase();
}
```

### 4.4 People

```typescript
function buildPersonSearchText(person: Person): string {
  return [
    person.name,
    person.organization,
    person.role,
    person.notes,
    person.relationship,
  ].filter(Boolean).join(' ').toLowerCase();
}
```

### 4.5 Commitments

```typescript
function buildCommitmentSearchText(commitment: Commitment): string {
  return [
    commitment.description,
    commitment.person_name,
    commitment.context_type,
  ].filter(Boolean).join(' ').toLowerCase();
}
```

---

## 5. Error Handling

### 5.1 FTS5 Table Not Found

```typescript
try {
  const results = await searchFTS5(db, entityType, query);
  return results;
} catch (error) {
  if (error.message?.includes('no such table') ||
      error.message?.includes('_fts')) {
    // FTS table doesn't exist - create it
    await createFTSTable(db, entityType);
    // Retry search (might return empty if not backfilled)
    return await searchFTS5(db, entityType, query);
  }
  throw error;
}
```

### 5.2 Empty Search Results Fallback

```typescript
async function searchWithFallback(
  db: D1Database,
  entityType: string,
  query: string,
  tenantId: string
): Promise<SearchResult[]> {
  // Try FTS5 first
  const ftsResults = await searchFTS5(db, entityType, query);

  if (ftsResults.length === 0) {
    // Fallback to LIKE query on search_text column
    return await searchLikeFallback(db, entityType, query, tenantId);
  }

  return ftsResults;
}

async function searchLikeFallback(
  db: D1Database,
  entityType: string,
  query: string,
  tenantId: string
): Promise<SearchResult[]> {
  const terms = query.toLowerCase().split(/\s+/);
  const conditions = terms.map(() => 'search_text LIKE ?').join(' AND ');
  const bindings = terms.map(t => `%${t}%`);

  return db.prepare(`
    SELECT * FROM ${entityType}
    WHERE ${conditions}
      AND tenant_id = ?
      AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 50
  `).bind(...bindings, tenantId).all();
}
```

---

## 6. Caching Strategy (Phase 2)

### 6.1 Cache Key Structure

```typescript
function buildSearchCacheKey(
  tenantId: string,
  query: string,
  entities: string[],
  filters: object
): string {
  const normalized = {
    t: tenantId,
    q: query.toLowerCase().trim(),
    e: entities.sort().join(','),
    f: JSON.stringify(filters, Object.keys(filters).sort())
  };
  return `search:${hashString(JSON.stringify(normalized))}`;
}
```

### 6.2 Cache Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SEARCH REQUEST                                     │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                                     ▼
                          ┌──────────────────────┐
                          │   Check KV Cache     │
                          │   TTL: 5 minutes     │
                          └──────────┬───────────┘
                                     │
                        ┌────────────┴────────────┐
                        │                         │
                   CACHE HIT                 CACHE MISS
                        │                         │
                        ▼                         ▼
           ┌──────────────────┐       ┌──────────────────────────┐
           │ Return cached    │       │ Execute search queries   │
           │ results          │       │                          │
           └──────────────────┘       │ Store in KV with TTL     │
                                      │                          │
                                      │ Return results           │
                                      └──────────────────────────┘
```

---

## 7. Performance Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| Keyword search latency (P50) | < 50ms | D1 FTS5 query |
| Keyword search latency (P99) | < 100ms | Including post-processing |
| Vector search latency (P50) | < 100ms | Vectorize query |
| Hybrid search latency (P50) | < 150ms | Parallel execution + RRF |
| Cache hit ratio | > 60% | Popular queries |
| Max concurrent searches | 100/sec | Rate limiting |

---

*Data flow specification finalized: 2025-12-30*
