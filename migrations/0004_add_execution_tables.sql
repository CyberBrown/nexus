-- Migration: Add execution tracking and decision log tables
-- For the Idea → Execution Pipeline

-- Idea prioritization columns
ALTER TABLE ideas ADD COLUMN effort_estimate TEXT; -- xs, s, m, l, xl
ALTER TABLE ideas ADD COLUMN impact_score INTEGER; -- 1-10
ALTER TABLE ideas ADD COLUMN energy_type TEXT; -- creative, analytical, maintenance
ALTER TABLE ideas ADD COLUMN dependencies TEXT; -- JSON array of idea/task IDs
ALTER TABLE ideas ADD COLUMN priority_score REAL; -- Calculated score

-- Execution tracking
CREATE TABLE IF NOT EXISTS idea_executions (
    id TEXT PRIMARY KEY,
    idea_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),

    status TEXT NOT NULL DEFAULT 'pending', -- pending, planning, in_progress, blocked, completed, failed, cancelled
    phase TEXT NOT NULL DEFAULT 'init', -- init, planning, task_generation, execution, review

    assigned_agent TEXT, -- agent identifier (e.g., 'claude-sonnet', 'local-llama')

    plan TEXT, -- JSON: generated plan/spec
    tasks_generated TEXT, -- JSON: array of task IDs created from this execution

    started_at TEXT,
    completed_at TEXT,

    result TEXT, -- JSON: execution result/output
    blockers TEXT, -- JSON: array of blockers requiring human input
    error TEXT, -- Error message if failed

    metadata TEXT, -- JSON: additional execution metadata

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT,

    FOREIGN KEY (idea_id) REFERENCES ideas(id)
);

CREATE INDEX IF NOT EXISTS idx_executions_tenant ON idea_executions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_executions_idea ON idea_executions(idea_id);
CREATE INDEX IF NOT EXISTS idx_executions_status ON idea_executions(tenant_id, status);

-- Decision log for tracking CEO decisions
CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),

    entity_type TEXT NOT NULL, -- idea, task, project, execution
    entity_id TEXT NOT NULL,

    decision TEXT NOT NULL, -- approved, rejected, deferred, modified, cancelled
    reasoning TEXT, -- Why this decision was made

    context TEXT, -- JSON: context at decision time (priority scores, blockers, etc.)

    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_decisions_tenant ON decisions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_decisions_entity ON decisions(tenant_id, entity_type, entity_id);
