-- Migration: Add execution loop tables and idea enhancements
-- Adds: idea_tasks, idea_executions, priority scoring fields

-- ============================================
-- IDEA EXECUTION TASKS
-- Tasks generated from ideas by the planning workflow
-- ============================================

CREATE TABLE IF NOT EXISTS idea_tasks (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    idea_id TEXT NOT NULL REFERENCES ideas(id),

    title TEXT NOT NULL,           -- ENCRYPTED
    description TEXT,              -- ENCRYPTED

    agent_type TEXT NOT NULL DEFAULT 'ai',  -- ai, human, human-ai
    estimated_effort TEXT,         -- xs, s, m, l, xl

    sequence_order INTEGER NOT NULL DEFAULT 0,

    status TEXT NOT NULL DEFAULT 'pending',  -- pending, ready, in_progress, completed, failed, blocked

    started_at TEXT,
    completed_at TEXT,

    result TEXT,                   -- JSON result from execution
    error_message TEXT,

    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_idea_tasks_idea ON idea_tasks(idea_id);
CREATE INDEX IF NOT EXISTS idx_idea_tasks_tenant ON idea_tasks(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_idea_tasks_status ON idea_tasks(status);

-- ============================================
-- IDEA EXECUTIONS (Workflow Runs)
-- Tracks overall execution state of idea->tasks pipeline
-- ============================================

CREATE TABLE IF NOT EXISTS idea_executions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    idea_id TEXT NOT NULL REFERENCES ideas(id),

    workflow_instance_id TEXT,     -- Cloudflare Workflow instance ID

    status TEXT NOT NULL DEFAULT 'pending',  -- pending, planning, planned, executing, completed, failed, blocked

    total_tasks INTEGER DEFAULT 0,
    completed_tasks INTEGER DEFAULT 0,
    failed_tasks INTEGER DEFAULT 0,

    blockers TEXT,                 -- JSON array of blocker descriptions

    started_at TEXT,
    planned_at TEXT,
    completed_at TEXT,

    error_message TEXT,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_idea_executions_idea ON idea_executions(idea_id);
CREATE INDEX IF NOT EXISTS idx_idea_executions_tenant ON idea_executions(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_idea_executions_status ON idea_executions(status);
CREATE INDEX IF NOT EXISTS idx_idea_executions_workflow ON idea_executions(workflow_instance_id);

-- ============================================
-- ADD STATUS AND PRIORITY FIELDS TO IDEAS
-- ============================================

-- Execution status: new, planned, executing, done, blocked
ALTER TABLE ideas ADD COLUMN execution_status TEXT DEFAULT 'new';

-- Effort estimate: xs, s, m, l, xl
ALTER TABLE ideas ADD COLUMN effort_estimate TEXT;

-- Energy type: creative, analytical, maintenance
ALTER TABLE ideas ADD COLUMN energy_type TEXT;

-- Dependencies: JSON array of idea/task IDs
ALTER TABLE ideas ADD COLUMN dependencies TEXT;

-- Calculated priority score (higher = more important)
ALTER TABLE ideas ADD COLUMN priority_score REAL;

-- Create index for execution status filtering
CREATE INDEX IF NOT EXISTS idx_ideas_execution_status ON ideas(tenant_id, execution_status);

-- Create index for priority sorting
CREATE INDEX IF NOT EXISTS idx_ideas_priority ON ideas(tenant_id, priority_score DESC);
