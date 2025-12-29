-- Migration: Add memory_items table for AI agent persistent memory
-- This table stores context-aware memories that AI agents can retrieve based on
-- scope, environment, and tags for improved contextual understanding.

-- ============================================
-- MEMORY ITEMS
-- ============================================
-- Stores persistent memory items for AI agents with scoping and environment awareness.
-- Memories can be global, project-specific, or scoped to specific contexts.

CREATE TABLE IF NOT EXISTS memory_items (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),

    -- Core content (encrypted)
    content TEXT NOT NULL, -- The actual memory content (encrypted)
    summary TEXT, -- Short summary for quick retrieval (encrypted)

    -- Memory type and classification
    memory_type TEXT NOT NULL DEFAULT 'fact', -- fact, preference, decision, context, learning, correction
    importance INTEGER DEFAULT 3, -- 1-5 scale, higher = more important to retain
    confidence REAL DEFAULT 1.0, -- 0-1, confidence level in the memory accuracy

    -- Scoping - determines visibility and retrieval context
    scope TEXT NOT NULL DEFAULT 'global', -- global, project, task, conversation, session
    scope_reference_id TEXT, -- ID of the scoped entity (project_id, task_id, etc.)
    scope_reference_type TEXT, -- Type of the scoped entity for polymorphic reference

    -- Environment targeting - which environments this memory applies to
    environments TEXT, -- JSON array: ["development", "production", "local", "spark", etc.]

    -- Tagging and categorization
    tags TEXT, -- JSON array of tags for filtering and retrieval
    categories TEXT, -- JSON array of category paths: ["coding/typescript", "preferences/style"]

    -- Source attribution - where this memory originated
    source_type TEXT, -- user_input, ai_inference, conversation, correction, external
    source_agent TEXT, -- Which agent created this: claude-code, claude-ai, nexus, user
    source_reference TEXT, -- Reference to the source (conversation ID, task ID, etc.)
    source_context TEXT, -- Snippet or description of the context when created

    -- Relationships and linking
    related_memory_ids TEXT, -- JSON array of related memory item IDs
    supersedes_id TEXT REFERENCES memory_items(id), -- This memory replaces an older one
    superseded_by_id TEXT REFERENCES memory_items(id), -- This memory was replaced by another

    -- Temporal aspects
    valid_from TEXT, -- When this memory becomes valid (NULL = immediate)
    valid_until TEXT, -- When this memory expires (NULL = never)
    last_accessed_at TEXT, -- When this memory was last retrieved/used
    access_count INTEGER DEFAULT 0, -- How many times this memory has been accessed

    -- Verification and review
    verified INTEGER DEFAULT 0, -- 0 = unverified, 1 = user verified
    verified_at TEXT,
    needs_review INTEGER DEFAULT 0, -- 1 = flagged for user review
    review_reason TEXT, -- Why this memory needs review

    -- Active/archive status
    is_active INTEGER DEFAULT 1, -- 0 = soft disabled, 1 = active
    archived_at TEXT, -- When archived, NULL if active
    archive_reason TEXT,

    -- Embedding for semantic search (optional, populated async)
    embedding_model TEXT, -- Model used to generate embedding
    embedding_version TEXT, -- Version of the embedding
    -- Note: actual embedding vectors stored in Vectorize index, not D1

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT -- Soft delete
);

-- ============================================
-- INDEXES
-- ============================================

-- Primary access patterns
CREATE INDEX IF NOT EXISTS idx_memory_tenant ON memory_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_memory_user ON memory_items(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_memory_active ON memory_items(tenant_id, user_id, is_active)
    WHERE deleted_at IS NULL;

-- Type and importance filtering
CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_items(tenant_id, user_id, memory_type);
CREATE INDEX IF NOT EXISTS idx_memory_importance ON memory_items(tenant_id, user_id, importance DESC);

-- Scope-based retrieval (critical for context-aware querying)
CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_items(tenant_id, user_id, scope);
CREATE INDEX IF NOT EXISTS idx_memory_scope_ref ON memory_items(tenant_id, scope, scope_reference_id);

-- Source tracking
CREATE INDEX IF NOT EXISTS idx_memory_source ON memory_items(tenant_id, source_type, source_agent);
CREATE INDEX IF NOT EXISTS idx_memory_source_ref ON memory_items(tenant_id, source_reference);

-- Temporal queries
CREATE INDEX IF NOT EXISTS idx_memory_valid ON memory_items(tenant_id, user_id, valid_from, valid_until);
CREATE INDEX IF NOT EXISTS idx_memory_accessed ON memory_items(tenant_id, user_id, last_accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_items(tenant_id, user_id, created_at DESC);

-- Review and verification
CREATE INDEX IF NOT EXISTS idx_memory_needs_review ON memory_items(tenant_id, user_id, needs_review)
    WHERE needs_review = 1;
CREATE INDEX IF NOT EXISTS idx_memory_unverified ON memory_items(tenant_id, user_id, verified)
    WHERE verified = 0;

-- Supersession chain
CREATE INDEX IF NOT EXISTS idx_memory_supersedes ON memory_items(supersedes_id);
CREATE INDEX IF NOT EXISTS idx_memory_superseded_by ON memory_items(superseded_by_id);


-- ============================================
-- MEMORY ITEM TAGS (Normalized for efficient tag queries)
-- ============================================
-- Separate table for tag-based queries when JSON extraction is too slow

CREATE TABLE IF NOT EXISTS memory_item_tags (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    memory_item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_tags_lookup ON memory_item_tags(tenant_id, tag);
CREATE INDEX IF NOT EXISTS idx_memory_tags_item ON memory_item_tags(memory_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_tags_unique ON memory_item_tags(memory_item_id, tag);


-- ============================================
-- MEMORY ITEM ENVIRONMENTS (Normalized for efficient environment filtering)
-- ============================================
-- Separate table for environment-based queries

CREATE TABLE IF NOT EXISTS memory_item_environments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    memory_item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
    environment TEXT NOT NULL, -- development, production, local, spark, etc.
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_env_lookup ON memory_item_environments(tenant_id, environment);
CREATE INDEX IF NOT EXISTS idx_memory_env_item ON memory_item_environments(memory_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_env_unique ON memory_item_environments(memory_item_id, environment);
