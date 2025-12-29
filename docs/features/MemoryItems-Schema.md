# Memory Items Database Schema

## Overview

The `memory_items` table provides persistent memory storage for AI agents within the Nexus ecosystem. This enables context-aware AI interactions where agents can store, retrieve, and manage memories based on scope, environment, and relevance.

## Core Tables

### 1. memory_items (Primary Table)

The main table for storing AI agent memories with comprehensive metadata.

```sql
CREATE TABLE memory_items (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    ...
);
```

#### Field Groups

##### Identity & Ownership
| Field | Type | Description |
|-------|------|-------------|
| `id` | TEXT | Primary key (ULID format) |
| `tenant_id` | TEXT | Tenant isolation (FK to tenants) |
| `user_id` | TEXT | User ownership (FK to users) |

##### Core Content (Encrypted)
| Field | Type | Description |
|-------|------|-------------|
| `content` | TEXT | The actual memory content (encrypted via AES-256-GCM) |
| `summary` | TEXT | Short summary for quick retrieval (encrypted) |

##### Classification
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `memory_type` | TEXT | 'fact' | Classification of memory purpose |
| `importance` | INTEGER | 3 | 1-5 scale (higher = more important) |
| `confidence` | REAL | 1.0 | 0-1 confidence level in accuracy |

**Memory Types:**
- `fact` - Verified information about the user or system
- `preference` - User preferences and settings
- `decision` - Historical decisions and their reasoning
- `context` - Contextual information for specific situations
- `learning` - Insights learned from interactions
- `correction` - Corrections to previous memories or behaviors

##### Scoping System
| Field | Type | Description |
|-------|------|-------------|
| `scope` | TEXT | Visibility level (see values below) |
| `scope_reference_id` | TEXT | ID of scoped entity (project_id, task_id, etc.) |
| `scope_reference_type` | TEXT | Type identifier for polymorphic references |

**Scope Values:**
- `global` - Available across all contexts
- `project` - Specific to a project
- `task` - Specific to a task
- `conversation` - Specific to a conversation session
- `session` - Ephemeral, current session only

##### Environment Targeting
| Field | Type | Description |
|-------|------|-------------|
| `environments` | TEXT | JSON array of target environments |

**Environment Values:**
- `development` - Dev environments
- `production` - Production systems
- `local` - Local machine
- `spark` - DGX Spark environment
- `staging` - Staging environments

##### Categorization
| Field | Type | Description |
|-------|------|-------------|
| `tags` | TEXT | JSON array of tags for filtering |
| `categories` | TEXT | JSON array of hierarchical category paths |

**Category Examples:**
- `["coding/typescript", "preferences/style"]`
- `["infrastructure/docker", "debugging/errors"]`

##### Source Attribution
| Field | Type | Description |
|-------|------|-------------|
| `source_type` | TEXT | Origin type of the memory |
| `source_agent` | TEXT | Agent that created the memory |
| `source_reference` | TEXT | Reference to source (conversation ID, etc.) |
| `source_context` | TEXT | Snippet of context when created |

**Source Types:**
- `user_input` - Directly from user
- `ai_inference` - Inferred by AI
- `conversation` - Extracted from conversation
- `correction` - User correction
- `external` - External system/API

**Source Agents:**
- `claude-code` - Claude Code CLI
- `claude-ai` - Claude AI web/API
- `nexus` - Nexus system itself
- `user` - Direct user input

##### Relationships
| Field | Type | Description |
|-------|------|-------------|
| `related_memory_ids` | TEXT | JSON array of related memory IDs |
| `supersedes_id` | TEXT | FK - Memory this replaces |
| `superseded_by_id` | TEXT | FK - Memory that replaced this |

##### Temporal Management
| Field | Type | Description |
|-------|------|-------------|
| `valid_from` | TEXT | When memory becomes valid (NULL = immediate) |
| `valid_until` | TEXT | When memory expires (NULL = never) |
| `last_accessed_at` | TEXT | Last retrieval timestamp |
| `access_count` | INTEGER | Retrieval count (default 0) |

##### Verification & Review
| Field | Type | Description |
|-------|------|-------------|
| `verified` | INTEGER | 0 = unverified, 1 = user verified |
| `verified_at` | TEXT | Verification timestamp |
| `needs_review` | INTEGER | 1 = flagged for review |
| `review_reason` | TEXT | Why review is needed |

##### Status Management
| Field | Type | Description |
|-------|------|-------------|
| `is_active` | INTEGER | 0 = disabled, 1 = active |
| `archived_at` | TEXT | Archive timestamp |
| `archive_reason` | TEXT | Reason for archiving |

##### Embedding Metadata
| Field | Type | Description |
|-------|------|-------------|
| `embedding_model` | TEXT | Model used (e.g., "text-embedding-3-small") |
| `embedding_version` | TEXT | Version identifier |

> **Note:** Actual embedding vectors are stored in Cloudflare Vectorize index, not D1.

##### Timestamps
| Field | Type | Description |
|-------|------|-------------|
| `created_at` | TEXT | Creation timestamp |
| `updated_at` | TEXT | Last update timestamp |
| `deleted_at` | TEXT | Soft delete timestamp |

---

### 2. memory_item_tags (Normalized Tags)

Separate table for efficient tag-based queries when JSON extraction is too slow.

```sql
CREATE TABLE memory_item_tags (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    memory_item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Indexes:**
- `idx_memory_tags_lookup` - Tag-based lookup
- `idx_memory_tags_item` - Item-based lookup
- `idx_memory_tags_unique` - Unique constraint on (memory_item_id, tag)

---

### 3. memory_item_environments (Normalized Environments)

Separate table for efficient environment-based filtering.

```sql
CREATE TABLE memory_item_environments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    memory_item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
    environment TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Indexes:**
- `idx_memory_env_lookup` - Environment-based lookup
- `idx_memory_env_item` - Item-based lookup
- `idx_memory_env_unique` - Unique constraint on (memory_item_id, environment)

---

## Index Strategy

### Primary Access Patterns
```sql
-- Tenant and user filtering (always applied)
idx_memory_tenant (tenant_id)
idx_memory_user (tenant_id, user_id)
idx_memory_active (tenant_id, user_id, is_active) WHERE deleted_at IS NULL
```

### Classification Indexes
```sql
idx_memory_type (tenant_id, user_id, memory_type)
idx_memory_importance (tenant_id, user_id, importance DESC)
```

### Scope-Based Retrieval
```sql
-- Critical for context-aware querying
idx_memory_scope (tenant_id, user_id, scope)
idx_memory_scope_ref (tenant_id, scope, scope_reference_id)
```

### Source Tracking
```sql
idx_memory_source (tenant_id, source_type, source_agent)
idx_memory_source_ref (tenant_id, source_reference)
```

### Temporal Queries
```sql
idx_memory_valid (tenant_id, user_id, valid_from, valid_until)
idx_memory_accessed (tenant_id, user_id, last_accessed_at DESC)
idx_memory_created (tenant_id, user_id, created_at DESC)
```

### Review & Verification
```sql
idx_memory_needs_review (tenant_id, user_id, needs_review) WHERE needs_review = 1
idx_memory_unverified (tenant_id, user_id, verified) WHERE verified = 0
```

### Supersession Chain
```sql
idx_memory_supersedes (supersedes_id)
idx_memory_superseded_by (superseded_by_id)
```

---

## Query Patterns

### Retrieve Active Memories for Context

```sql
SELECT * FROM memory_items
WHERE tenant_id = ?
  AND user_id = ?
  AND is_active = 1
  AND deleted_at IS NULL
  AND (valid_from IS NULL OR valid_from <= datetime('now'))
  AND (valid_until IS NULL OR valid_until > datetime('now'))
  AND (scope = 'global' OR (scope = 'project' AND scope_reference_id = ?))
ORDER BY importance DESC, created_at DESC
LIMIT 50;
```

### Find Memories by Environment

```sql
SELECT m.* FROM memory_items m
JOIN memory_item_environments e ON m.id = e.memory_item_id
WHERE m.tenant_id = ?
  AND m.user_id = ?
  AND e.environment = 'production'
  AND m.is_active = 1
  AND m.deleted_at IS NULL;
```

### Get Memories Needing Review

```sql
SELECT * FROM memory_items
WHERE tenant_id = ?
  AND user_id = ?
  AND needs_review = 1
  AND deleted_at IS NULL
ORDER BY created_at DESC;
```

### Find Related Memories (Supersession Chain)

```sql
-- Get all versions of a memory
WITH RECURSIVE chain AS (
  SELECT * FROM memory_items WHERE id = ?
  UNION ALL
  SELECT m.* FROM memory_items m
  JOIN chain c ON m.supersedes_id = c.id OR m.id = c.supersedes_id
)
SELECT * FROM chain ORDER BY created_at;
```

---

## TypeScript Types

Located in `/src/types/index.ts`:

```typescript
// Memory type classification
export type MemoryType = 'fact' | 'preference' | 'decision' | 'context' | 'learning' | 'correction';

// Memory scope - determines visibility and retrieval context
export type MemoryScope = 'global' | 'project' | 'task' | 'conversation' | 'session';

// Source of the memory
export type MemorySourceType = 'user_input' | 'ai_inference' | 'conversation' | 'correction' | 'external';

// Agent that created the memory
export type MemorySourceAgent = 'claude-code' | 'claude-ai' | 'nexus' | 'user' | string;

// Environment identifiers
export type MemoryEnvironment = 'development' | 'production' | 'local' | 'spark' | 'staging' | string;
```

---

## Security Considerations

1. **Encryption**: `content` and `summary` fields are encrypted at the application layer using AES-256-GCM before storage.

2. **Tenant Isolation**: All queries must include `tenant_id` for proper isolation.

3. **Soft Deletes**: `deleted_at` enables recovery and audit trails.

4. **Verification**: `verified` flag allows distinguishing user-confirmed vs AI-inferred memories.

---

## Integration Points

### Vectorize (Semantic Search)
- Embeddings stored in Cloudflare Vectorize
- `embedding_model` and `embedding_version` track generation
- Enables semantic similarity queries

### Other Nexus Tables
- `scope_reference_id` can reference:
  - `projects.id` (when scope = 'project')
  - `tasks.id` (when scope = 'task')
  - Conversation IDs (when scope = 'conversation')

### External AI Agents
- `source_agent` tracks which agent created each memory
- Enables agent-specific memory retrieval and management

---

## Migration

Migration file: `/migrations/0016_add_memory_items_table.sql`

Apply with:
```bash
wrangler d1 migrations apply nexus-db
```
