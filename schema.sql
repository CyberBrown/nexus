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