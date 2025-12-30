# AI Search Implementation Plan

**Status:** Ready for Implementation
**Date:** 2025-12-30
**Estimated Effort:** 4 phases over 4 weeks

---

## Quick Reference

### Current Blockers

| Blocker | Impact | Resolution |
|---------|--------|------------|
| Vectorize API permissions | Semantic search disabled | Request from CF dashboard |

### What Works Now

- Notes FTS5 search via `nexus_search_notes`
- Notes `search_text` column populated
- Workers AI binding (`env.AI`) configured
- R2 bucket (`nexus-ai-search`) configured

### Implementation Priority

1. **Phase 1 (Week 1):** Keyword search for all entities - **NO BLOCKERS**
2. **Phase 2 (Week 2):** MCP tools and search improvements - **NO BLOCKERS**
3. **Phase 3 (Week 3):** Semantic search - **BLOCKED on Vectorize**
4. **Phase 4 (Week 4):** Polish and optimization - **NO BLOCKERS**

---

## Phase 1: Foundation (Keyword Search)

### 1.1 Database Migrations

**File:** `migrations/0010_add_search_text_columns.sql`

```sql
-- Add search_text columns to all searchable entities
ALTER TABLE tasks ADD COLUMN search_text TEXT;
ALTER TABLE ideas ADD COLUMN search_text TEXT;
ALTER TABLE projects ADD COLUMN search_text TEXT;
ALTER TABLE people ADD COLUMN search_text TEXT;
ALTER TABLE commitments ADD COLUMN search_text TEXT;
```

**File:** `migrations/0011_create_fts5_indexes.sql`

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

**Run migrations:**
```bash
cd ~/projects/nexus
npx wrangler d1 execute nexus-db --file=migrations/0010_add_search_text_columns.sql
npx wrangler d1 execute nexus-db --file=migrations/0011_create_fts5_indexes.sql
```

---

### 1.2 Search Library

**File:** `src/lib/search.ts`

```typescript
import type { D1Database } from '@cloudflare/workers-types';

// Entity types that support search
export type SearchableEntity = 'tasks' | 'notes' | 'ideas' | 'projects' | 'people' | 'commitments';

export const ALL_SEARCHABLE_ENTITIES: SearchableEntity[] = [
  'tasks', 'notes', 'ideas', 'projects', 'people', 'commitments'
];

// Maps entity type to its ID column in FTS table
const FTS_ID_COLUMNS: Record<SearchableEntity, string> = {
  tasks: 'task_id',
  notes: 'note_id',
  ideas: 'idea_id',
  projects: 'project_id',
  people: 'person_id',
  commitments: 'commitment_id',
};

// Maps entity type to its primary display field
const TITLE_FIELDS: Record<SearchableEntity, string> = {
  tasks: 'title',
  notes: 'title',
  ideas: 'title',
  projects: 'name',
  people: 'name',
  commitments: 'description',
};

export interface ParsedQuery {
  terms: string[];
  phrases: string[];
  entityPrefix: SearchableEntity | null;
  ftsQuery: string;
}

export interface SearchFilters {
  domain?: string;
  status?: string;
  created_after?: string;
  created_before?: string;
}

export interface SearchRequest {
  query: string;
  entities?: SearchableEntity[];
  filters?: SearchFilters;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  entity_type: SearchableEntity;
  entity_id: string;
  title: string;
  snippet: string | null;
  score: number;
  metadata: Record<string, unknown>;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  query_info: {
    original_query: string;
    parsed_query: string;
    entities_searched: SearchableEntity[];
    strategy: 'keyword' | 'semantic' | 'hybrid';
  };
}

/**
 * Parse a user search query into structured components
 */
export function parseSearchQuery(query: string): ParsedQuery {
  const trimmed = query.trim();

  // Check for entity prefix
  const prefixMatch = trimmed.match(/^(task|note|idea|project|person|commitment|@):(.+)/i);
  let entityPrefix: SearchableEntity | null = null;
  let cleanQuery = trimmed;

  if (prefixMatch) {
    const prefix = prefixMatch[1].toLowerCase();
    entityPrefix = prefix === '@' ? 'people' :
      prefix === 'task' ? 'tasks' :
      prefix === 'note' ? 'notes' :
      prefix === 'idea' ? 'ideas' :
      prefix === 'project' ? 'projects' :
      prefix === 'person' ? 'people' :
      prefix === 'commitment' ? 'commitments' : null;
    cleanQuery = prefixMatch[2].trim();
  }

  // Extract quoted phrases
  const phrases: string[] = [];
  const phraseRegex = /"([^"]+)"/g;
  let match;
  while ((match = phraseRegex.exec(cleanQuery)) !== null) {
    const phrase = match[1].toLowerCase().trim();
    if (phrase) phrases.push(phrase);
  }

  // Extract individual terms
  const withoutPhrases = cleanQuery.replace(phraseRegex, '');
  const terms = withoutPhrases
    .split(/\s+/)
    .filter(t => t.length > 0)
    .map(t => t.toLowerCase().replace(/[*^"():]/g, ''));

  // Build FTS5 query
  // Use search_text: prefix for D1 FTS5 compatibility
  const ftsParts = [
    ...terms.map(t => `search_text:${t}`),
    ...phrases.map(p => `search_text:"${p}"`)
  ];
  const ftsQuery = ftsParts.join(' ');

  return { terms, phrases, entityPrefix, ftsQuery };
}

/**
 * Search a single entity type using FTS5
 */
export async function searchEntity(
  db: D1Database,
  entityType: SearchableEntity,
  ftsQuery: string,
  tenantId: string,
  userId: string,
  filters?: SearchFilters,
  limit: number = 50
): Promise<Array<Record<string, unknown> & { score: number }>> {
  const ftsTable = `${entityType}_fts`;
  const mainTable = entityType;
  const idColumn = FTS_ID_COLUMNS[entityType];

  // Build filter conditions
  const conditions: string[] = [];
  const bindings: unknown[] = [ftsQuery, tenantId, userId];

  if (filters?.domain) {
    conditions.push('m.domain = ?');
    bindings.push(filters.domain);
  }
  if (filters?.status) {
    conditions.push('m.status = ?');
    bindings.push(filters.status);
  }
  if (filters?.created_after) {
    conditions.push('m.created_at >= ?');
    bindings.push(filters.created_after);
  }
  if (filters?.created_before) {
    conditions.push('m.created_at <= ?');
    bindings.push(filters.created_before);
  }

  const filterClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
  bindings.push(limit);

  const sql = `
    SELECT
      m.*,
      bm25(${ftsTable}) as score
    FROM ${ftsTable} f
    INNER JOIN ${mainTable} m ON f.${idColumn} = m.id
    WHERE ${ftsTable} MATCH ?
      AND m.tenant_id = ?
      AND m.user_id = ?
      AND m.deleted_at IS NULL
      ${filterClause}
    ORDER BY bm25(${ftsTable}) ASC
    LIMIT ?
  `;

  try {
    const result = await db.prepare(sql).bind(...bindings).all();
    return result.results as Array<Record<string, unknown> & { score: number }>;
  } catch (error: any) {
    // FTS table might not exist yet
    if (error.message?.includes('no such table')) {
      return [];
    }
    throw error;
  }
}

/**
 * Merge results from multiple entity searches
 */
export function mergeResults(
  resultsByEntity: Map<SearchableEntity, Array<Record<string, unknown> & { score: number }>>,
  limit: number
): SearchResult[] {
  const allResults: SearchResult[] = [];

  for (const [entityType, results] of resultsByEntity) {
    const titleField = TITLE_FIELDS[entityType];

    for (const row of results) {
      allResults.push({
        entity_type: entityType,
        entity_id: row.id as string,
        title: (row[titleField] as string) ?? '',
        snippet: null, // TODO: Phase 2
        score: Math.abs(row.score), // BM25 returns negative
        metadata: {
          status: row.status,
          domain: row.domain,
          created_at: row.created_at,
          category: row.category,
        }
      });
    }
  }

  // Sort by score descending
  allResults.sort((a, b) => b.score - a.score);

  return allResults.slice(0, limit);
}

/**
 * Execute a unified search across multiple entity types
 */
export async function executeSearch(
  db: D1Database,
  request: SearchRequest,
  tenantId: string,
  userId: string
): Promise<SearchResponse> {
  const parsed = parseSearchQuery(request.query);
  const limit = request.limit ?? 20;

  // Determine which entities to search
  let entitiesToSearch: SearchableEntity[];
  if (parsed.entityPrefix) {
    entitiesToSearch = [parsed.entityPrefix];
  } else if (request.entities?.length) {
    entitiesToSearch = request.entities;
  } else {
    entitiesToSearch = ALL_SEARCHABLE_ENTITIES;
  }

  // If no valid FTS query, return empty
  if (!parsed.ftsQuery) {
    return {
      results: [],
      total: 0,
      query_info: {
        original_query: request.query,
        parsed_query: '',
        entities_searched: entitiesToSearch,
        strategy: 'keyword'
      }
    };
  }

  // Execute searches in parallel
  const searchPromises = entitiesToSearch.map(async (entityType) => {
    const results = await searchEntity(
      db,
      entityType,
      parsed.ftsQuery,
      tenantId,
      userId,
      request.filters,
      limit
    );
    return [entityType, results] as const;
  });

  const searchResults = await Promise.all(searchPromises);
  const resultsByEntity = new Map(searchResults);

  // Merge and return
  const merged = mergeResults(resultsByEntity, limit);

  return {
    results: merged,
    total: merged.length,
    query_info: {
      original_query: request.query,
      parsed_query: parsed.ftsQuery,
      entities_searched: entitiesToSearch,
      strategy: 'keyword'
    }
  };
}

/**
 * Build search_text for a task
 */
export function buildTaskSearchText(
  title: string,
  description: string | null,
  tags: string | null,
  contexts: string | null,
  projectName?: string | null
): string {
  return [title, description, tags, contexts, projectName]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Build search_text for an idea
 */
export function buildIdeaSearchText(
  title: string,
  description: string | null,
  tags: string | null,
  category: string | null
): string {
  return [title, description, tags, category]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Build search_text for a project
 */
export function buildProjectSearchText(
  name: string,
  description: string | null,
  objective: string | null,
  tags: string | null
): string {
  return [name, description, objective, tags]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Build search_text for a person
 */
export function buildPersonSearchText(
  name: string,
  organization: string | null,
  role: string | null,
  notes: string | null,
  relationship: string | null
): string {
  return [name, organization, role, notes, relationship]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Build search_text for a commitment
 */
export function buildCommitmentSearchText(
  description: string,
  personName: string | null,
  contextType: string | null
): string {
  return [description, personName, contextType]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}
```

---

### 1.3 Search API Endpoint

**File:** `src/routes/search.ts`

```typescript
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppType } from '../types/index.ts';
import { getAuth } from '../lib/auth.ts';
import { getEncryptionKey, decryptField } from '../lib/encryption.ts';
import {
  executeSearch,
  SearchableEntity,
  ALL_SEARCHABLE_ENTITIES
} from '../lib/search.ts';

const searchRouter = new Hono<AppType>();

const searchRequestSchema = z.object({
  query: z.string().min(1).max(500),
  entities: z.array(z.enum(['tasks', 'notes', 'ideas', 'projects', 'people', 'commitments'])).optional(),
  filters: z.object({
    domain: z.string().optional(),
    status: z.string().optional(),
    created_after: z.string().optional(),
    created_before: z.string().optional(),
  }).optional(),
  limit: z.number().min(1).max(100).optional(),
  offset: z.number().min(0).optional(),
});

searchRouter.post('/', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const body = await c.req.json();
  const validated = searchRequestSchema.parse(body);

  const response = await executeSearch(
    c.env.DB,
    {
      query: validated.query,
      entities: validated.entities as SearchableEntity[] | undefined,
      filters: validated.filters,
      limit: validated.limit,
      offset: validated.offset,
    },
    tenantId,
    userId
  );

  // Decrypt titles for display
  const encryptionKey = await getEncryptionKey(c.env.KV, tenantId);
  for (const result of response.results) {
    try {
      result.title = await decryptField(result.title, encryptionKey);
    } catch {
      // Title might not be encrypted (e.g., after encryption was disabled)
    }
  }

  return c.json({
    success: true,
    data: response
  });
});

export default searchRouter;
```

**Add to `src/index.ts`:**

```typescript
import searchRouter from './routes/search.ts';

// ... in routes setup
app.route('/api/search', searchRouter);
```

---

### 1.4 Add ?search to List Endpoints

**Update each route file to include search parameter handling:**

Example for `src/routes/tasks.ts`:

```typescript
// At the top of the list endpoint
const search = c.req.query('search');

if (search && search.trim()) {
  // Use FTS5 search
  const { parseSearchQuery, searchEntity } = await import('../lib/search.ts');
  const parsed = parseSearchQuery(search);

  if (parsed.ftsQuery) {
    const ftsResults = await searchEntity(
      c.env.DB,
      'tasks',
      parsed.ftsQuery,
      tenantId,
      userId,
      { domain, status }, // pass existing filters
      100
    );

    // Map to task objects and decrypt
    // ... rest of processing
  }
}
```

---

### 1.5 Index Rebuild MCP Tool

**Add to `src/mcp/index.ts`:**

```typescript
// Tool: nexus_rebuild_search_indexes - Rebuild FTS indexes for all entities
server.tool(
  'nexus_rebuild_search_indexes',
  'Rebuild full-text search indexes for all entities. Use after migration or if search returns unexpected results.',
  {
    entity_type: z.enum(['all', 'tasks', 'ideas', 'projects', 'people', 'commitments']).optional()
      .describe('Entity type to rebuild, or "all" for everything'),
    batch_size: z.number().min(10).max(500).optional()
      .describe('Number of entities to process per batch (default: 100)'),
  },
  async ({ entity_type = 'all', batch_size = 100 }) => {
    const { tenantId, userId } = getAuthFromContext();

    const entitiesToRebuild = entity_type === 'all'
      ? ['tasks', 'ideas', 'projects', 'people', 'commitments']
      : [entity_type];

    const results: Record<string, { indexed: number; errors: number }> = {};

    for (const entityType of entitiesToRebuild) {
      let indexed = 0;
      let errors = 0;

      // Create FTS table if not exists
      const ftsTable = `${entityType}_fts`;
      const idColumn = entityType === 'people' ? 'person_id' :
        entityType === 'commitments' ? 'commitment_id' :
        `${entityType.slice(0, -1)}_id`;

      await env.DB.prepare(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTable} USING fts5(
          ${idColumn} UNINDEXED,
          search_text,
          tokenize='porter unicode61'
        )
      `).run();

      // Clear existing FTS entries
      await env.DB.prepare(`DELETE FROM ${ftsTable}`).run();

      // Fetch all entities
      const entities = await env.DB.prepare(`
        SELECT * FROM ${entityType}
        WHERE tenant_id = ? AND user_id = ? AND deleted_at IS NULL
      `).bind(tenantId, userId).all();

      const encryptionKey = await getEncryptionKey(env.KV, tenantId);

      for (const entity of entities.results) {
        try {
          // Build search_text based on entity type
          let searchText: string;

          switch (entityType) {
            case 'tasks':
              const taskTitle = await decryptField(entity.title as string, encryptionKey);
              const taskDesc = entity.description
                ? await decryptField(entity.description as string, encryptionKey)
                : null;
              searchText = [taskTitle, taskDesc, entity.tags, entity.contexts]
                .filter(Boolean).join(' ').toLowerCase();
              break;

            case 'ideas':
              const ideaTitle = await decryptField(entity.title as string, encryptionKey);
              const ideaDesc = entity.description
                ? await decryptField(entity.description as string, encryptionKey)
                : null;
              searchText = [ideaTitle, ideaDesc, entity.tags, entity.category]
                .filter(Boolean).join(' ').toLowerCase();
              break;

            case 'projects':
              const projName = await decryptField(entity.name as string, encryptionKey);
              const projDesc = entity.description
                ? await decryptField(entity.description as string, encryptionKey)
                : null;
              const projObj = entity.objective
                ? await decryptField(entity.objective as string, encryptionKey)
                : null;
              searchText = [projName, projDesc, projObj, entity.tags]
                .filter(Boolean).join(' ').toLowerCase();
              break;

            case 'people':
              const personName = await decryptField(entity.name as string, encryptionKey);
              const personNotes = entity.notes
                ? await decryptField(entity.notes as string, encryptionKey)
                : null;
              searchText = [personName, entity.organization, entity.role, personNotes, entity.relationship]
                .filter(Boolean).join(' ').toLowerCase();
              break;

            case 'commitments':
              const commitDesc = await decryptField(entity.description as string, encryptionKey);
              searchText = [commitDesc, entity.person_name, entity.context_type]
                .filter(Boolean).join(' ').toLowerCase();
              break;

            default:
              continue;
          }

          // Update search_text column
          await env.DB.prepare(`
            UPDATE ${entityType} SET search_text = ? WHERE id = ?
          `).bind(searchText, entity.id).run();

          // Insert into FTS index
          await env.DB.prepare(`
            INSERT INTO ${ftsTable} (${idColumn}, search_text) VALUES (?, ?)
          `).bind(entity.id, searchText).run();

          indexed++;
        } catch (e) {
          errors++;
        }
      }

      results[entityType] = { indexed, errors };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: 'Search indexes rebuilt',
          results
        }, null, 2)
      }]
    };
  }
);
```

---

### 1.6 Phase 1 Checklist

- [ ] Create migration: `0010_add_search_text_columns.sql`
- [ ] Create migration: `0011_create_fts5_indexes.sql`
- [ ] Run migrations on D1
- [ ] Create `src/lib/search.ts`
- [ ] Create `src/routes/search.ts`
- [ ] Register `/api/search` in `src/index.ts`
- [ ] Add `nexus_rebuild_search_indexes` MCP tool
- [ ] Update tasks/ideas/projects/people/commitments routes:
  - [ ] Add `?search=` query parameter
  - [ ] Build `search_text` on create
  - [ ] Update `search_text` on update
  - [ ] Delete from FTS on delete
- [ ] Run `nexus_rebuild_search_indexes` to backfill
- [ ] Test search via MCP and API
- [ ] Deploy to production

---

## Phase 2: MCP Tools & Enhancements

### 2.1 `nexus_search` MCP Tool

```typescript
server.tool(
  'nexus_search',
  'Universal search across all Nexus entities. Searches tasks, notes, ideas, projects, people, and commitments.',
  {
    query: z.string().min(1).describe('Search query. Supports quotes for exact phrases, e.g., "project planning"'),
    entities: z.array(z.enum(['tasks', 'notes', 'ideas', 'projects', 'people', 'commitments'])).optional()
      .describe('Filter to specific entity types'),
    domain: z.string().optional().describe('Filter by domain (work, personal, etc.)'),
    status: z.string().optional().describe('Filter by status'),
    limit: z.number().min(1).max(50).optional().describe('Max results (default: 20)'),
  },
  async ({ query, entities, domain, status, limit = 20 }) => {
    const { tenantId, userId } = getAuthFromContext();

    const response = await executeSearch(env.DB, {
      query,
      entities,
      filters: { domain, status },
      limit
    }, tenantId, userId);

    // Decrypt and format results
    // ...

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response, null, 2)
      }]
    };
  }
);
```

### 2.2 Phase 2 Checklist

- [ ] Create `nexus_search` MCP tool
- [ ] Add `mode` parameter to `nexus_search_notes`
- [ ] Create `nexus_find_related` tool (keyword-based)
- [ ] Add snippet generation
- [ ] Add search caching (KV, 5-min TTL)
- [ ] Update MCP tool descriptions
- [ ] Deploy and test

---

## Phase 3: Semantic Search (When Vectorize Available)

### 3.1 Prerequisites

1. Request Vectorize permissions in Cloudflare dashboard
2. Create Vectorize index:
   ```bash
   npx wrangler vectorize create nexus-embeddings --dimensions=768 --metric=cosine
   ```
3. Add to `wrangler.toml`:
   ```toml
   [[vectorize]]
   binding = "EMBEDDINGS"
   index_name = "nexus-embeddings"
   ```

### 3.2 IndexManager Durable Object

See `AI_SEARCH_ARCHITECTURE.md` section 8 for full implementation.

### 3.3 Phase 3 Checklist

- [ ] Verify Vectorize permissions
- [ ] Create Vectorize index
- [ ] Update wrangler.toml with Vectorize binding
- [ ] Create IndexManager Durable Object
- [ ] Add embedding generation on entity write
- [ ] Add Vectorize migration
- [ ] Implement hybrid search (RRF)
- [ ] Update query router for semantic detection
- [ ] Backfill embeddings for existing entities
- [ ] Deploy and test

---

## Phase 4: Polish & Optimization

### 4.1 Checklist

- [ ] Add rate limiting (60 keyword/min, 20 semantic/min)
- [ ] Add search analytics logging
- [ ] Performance testing
- [ ] Edge case handling
- [ ] Load testing
- [ ] Documentation updates
- [ ] Final deployment

---

## Appendix: File Changes Summary

| File | Action | Phase |
|------|--------|-------|
| `migrations/0010_add_search_text_columns.sql` | Create | 1 |
| `migrations/0011_create_fts5_indexes.sql` | Create | 1 |
| `src/lib/search.ts` | Create | 1 |
| `src/routes/search.ts` | Create | 1 |
| `src/index.ts` | Update (add search route) | 1 |
| `src/routes/tasks.ts` | Update (search_text, ?search) | 1 |
| `src/routes/ideas.ts` | Update (search_text, ?search) | 1 |
| `src/routes/projects.ts` | Update (search_text, ?search) | 1 |
| `src/routes/people.ts` | Update (search_text, ?search) | 1 |
| `src/routes/commitments.ts` | Update (search_text, ?search) | 1 |
| `src/mcp/index.ts` | Update (rebuild tool, nexus_search) | 1, 2 |
| `wrangler.toml` | Update (Vectorize binding) | 3 |
| `src/durable-objects/IndexManager.ts` | Create | 3 |

---

*Implementation plan finalized: 2025-12-30*
*Ready to begin Phase 1*
