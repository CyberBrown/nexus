-- Nexus D1 Schema v0.1
-- Personal AI Command Center

-- ============================================
-- TENANT & USER MANAGEMENT
-- ============================================

CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    encryption_key_ref TEXT NOT NULL,
    settings TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    preferences TEXT,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT,
    UNIQUE(tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ============================================
-- UNIVERSAL INBOX
-- ============================================

CREATE TABLE IF NOT EXISTS inbox_items (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    
    source_type TEXT NOT NULL,
    source_id TEXT,
    source_platform TEXT,
    
    raw_content TEXT NOT NULL,
    processed_content TEXT,
    
    ai_classification TEXT,
    confidence_score REAL,
    
    status TEXT NOT NULL DEFAULT 'pending',
    promoted_to_type TEXT,
    promoted_to_id TEXT,
    
    user_overrides TEXT,
    
    captured_at TEXT NOT NULL,
    processed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_inbox_tenant_user ON inbox_items(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_items(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_inbox_captured ON inbox_items(tenant_id, captured_at);

-- ============================================
-- TASKS
-- ============================================

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    
    title TEXT NOT NULL,
    description TEXT,
    
    parent_task_id TEXT REFERENCES tasks(id),
    project_id TEXT REFERENCES projects(id),
    
    domain TEXT NOT NULL DEFAULT 'personal',
    area TEXT,
    contexts TEXT,
    tags TEXT,
    
    due_date TEXT,
    due_time TEXT,
    start_date TEXT,
    completed_at TEXT,
    time_estimate_minutes INTEGER,
    actual_time_minutes INTEGER,
    
    recurrence_rule TEXT,
    recurrence_parent_id TEXT REFERENCES tasks(id),
    
    urgency INTEGER DEFAULT 3,
    importance INTEGER DEFAULT 3,
    energy_required TEXT DEFAULT 'medium',
    
    status TEXT NOT NULL DEFAULT 'inbox',
    
    assigned_by_id TEXT,
    assigned_by_name TEXT,
    delegated_to_id TEXT,
    delegated_to_name TEXT,
    waiting_on TEXT,
    waiting_since TEXT,
    
    source_type TEXT,
    source_inbox_item_id TEXT REFERENCES inbox_items(id),
    source_reference TEXT,
    
    calendar_event_id TEXT,
    calendar_source TEXT,
    
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_tenant_user ON tasks(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(tenant_id, parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(tenant_id, due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_domain ON tasks(tenant_id, domain);

-- ============================================
-- PROJECTS
-- ============================================

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    
    name TEXT NOT NULL,
    description TEXT,
    objective TEXT,
    
    domain TEXT NOT NULL DEFAULT 'personal',
    area TEXT,
    tags TEXT,
    
    status TEXT NOT NULL DEFAULT 'planning',
    health TEXT DEFAULT 'on_track',
    
    target_date TEXT,
    started_at TEXT,
    completed_at TEXT,
    
    parent_project_id TEXT REFERENCES projects(id),
    
    external_id TEXT,
    external_source TEXT,
    
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_projects_tenant_user ON projects(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_projects_domain ON projects(tenant_id, domain);

-- ============================================
-- PROJECT PHASES & MILESTONES
-- ============================================

CREATE TABLE IF NOT EXISTS project_phases (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    
    name TEXT NOT NULL,
    description TEXT,
    
    sequence_order INTEGER NOT NULL,
    target_date TEXT,
    completed_at TEXT,
    
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS project_milestones (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    phase_id TEXT REFERENCES project_phases(id),
    
    name TEXT NOT NULL,
    description TEXT,
    
    target_date TEXT,
    completed_at TEXT,
    
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

-- ============================================
-- IDEAS / SOMEDAY-MAYBE
-- ============================================

CREATE TABLE IF NOT EXISTS ideas (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    
    title TEXT NOT NULL,
    description TEXT,
    
    category TEXT NOT NULL DEFAULT 'random',
    domain TEXT,
    tags TEXT,
    
    excitement_level INTEGER,
    feasibility INTEGER,
    potential_impact INTEGER,
    
    last_reviewed_at TEXT,
    next_review_at TEXT,
    review_count INTEGER DEFAULT 0,
    
    promoted_to_project_id TEXT REFERENCES projects(id),
    archived_at TEXT,
    archive_reason TEXT,
    
    source_inbox_item_id TEXT REFERENCES inbox_items(id),
    
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ideas_tenant_user ON ideas(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_ideas_category ON ideas(tenant_id, category);
CREATE INDEX IF NOT EXISTS idx_ideas_next_review ON ideas(tenant_id, next_review_at);

-- ============================================
-- PEOPLE (Contacts/Relationships)
-- ============================================

CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    
    relationship TEXT,
    organization TEXT,
    role TEXT,
    
    preferred_contact TEXT,
    google_contact_id TEXT,
    notes TEXT,
    
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_people_tenant_user ON people(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_people_relationship ON people(tenant_id, relationship);

-- ============================================
-- COMMITMENTS (Waiting For / Owed)
-- ============================================

CREATE TABLE IF NOT EXISTS commitments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    
    direction TEXT NOT NULL,
    
    person_id TEXT REFERENCES people(id),
    person_name TEXT,
    
    description TEXT NOT NULL,
    
    context_type TEXT,
    context_reference TEXT,
    
    requested_at TEXT NOT NULL,
    due_date TEXT,
    reminded_at TEXT,
    reminder_count INTEGER DEFAULT 0,
    
    status TEXT NOT NULL DEFAULT 'open',
    fulfilled_at TEXT,
    
    task_id TEXT REFERENCES tasks(id),
    
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_commitments_tenant_user ON commitments(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_commitments_direction ON commitments(tenant_id, direction);
CREATE INDEX IF NOT EXISTS idx_commitments_status ON commitments(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_commitments_person ON commitments(tenant_id, person_id);

-- ============================================
-- INTEGRATIONS
-- ============================================

CREATE TABLE IF NOT EXISTS integrations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    
    provider TEXT NOT NULL,
    integration_type TEXT NOT NULL,
    
    access_token TEXT,
    refresh_token TEXT,
    token_expires_at TEXT,
    
    account_email TEXT,
    account_name TEXT,
    account_id TEXT,
    
    last_sync_at TEXT,
    sync_cursor TEXT,
    sync_status TEXT DEFAULT 'active',
    sync_error TEXT,
    
    settings TEXT,
    
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT,
    
    UNIQUE(tenant_id, user_id, provider, integration_type, account_id)
);

CREATE INDEX IF NOT EXISTS idx_integrations_tenant_user ON integrations(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_integrations_provider ON integrations(tenant_id, provider);

-- ============================================
-- SYNC LOG
-- ============================================

CREATE TABLE IF NOT EXISTS sync_log (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    integration_id TEXT REFERENCES integrations(id),
    
    operation TEXT NOT NULL,
    status TEXT NOT NULL,
    
    items_processed INTEGER DEFAULT 0,
    items_created INTEGER DEFAULT 0,
    items_updated INTEGER DEFAULT 0,
    items_deleted INTEGER DEFAULT 0,
    
    error_message TEXT,
    
    started_at TEXT NOT NULL,
    completed_at TEXT,
    
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sync_log_integration ON sync_log(integration_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_started ON sync_log(tenant_id, started_at);

-- ============================================
-- SERVICE TOKENS (Machine-to-Machine Auth)
-- ============================================

CREATE TABLE IF NOT EXISTS service_tokens (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),

    name TEXT NOT NULL,
    description TEXT,

    client_id TEXT NOT NULL UNIQUE,
    client_secret_hash TEXT NOT NULL,

    scopes TEXT,

    last_used_at TEXT,
    expires_at TEXT,
    revoked_at TEXT,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_service_tokens_tenant ON service_tokens(tenant_id);
CREATE INDEX IF NOT EXISTS idx_service_tokens_client_id ON service_tokens(client_id);

-- ============================================
-- MEMORY ITEMS (AI Agent Persistent Memory)
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

-- Primary access patterns
CREATE INDEX IF NOT EXISTS idx_memory_tenant ON memory_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_memory_user ON memory_items(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_memory_active ON memory_items(tenant_id, user_id, is_active);

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
CREATE INDEX IF NOT EXISTS idx_memory_needs_review ON memory_items(tenant_id, user_id, needs_review);
CREATE INDEX IF NOT EXISTS idx_memory_unverified ON memory_items(tenant_id, user_id, verified);

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