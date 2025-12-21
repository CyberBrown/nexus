-- Migration: Add execution queue for task routing to different executors
-- Supports: claude-code (local runner), claude-ai (sandbox), de-agent, human

-- Execution queue - routes tasks to appropriate executors
CREATE TABLE IF NOT EXISTS execution_queue (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    executor_type TEXT NOT NULL, -- claude-code, claude-ai, de-agent, human

    -- Queue state
    status TEXT NOT NULL DEFAULT 'queued', -- queued, claimed, dispatched, completed, failed, quarantine
    priority INTEGER NOT NULL DEFAULT 10, -- Higher = more urgent

    -- Execution tracking
    queued_at TEXT NOT NULL,
    claimed_at TEXT,
    claimed_by TEXT, -- Executor instance ID
    dispatched_at TEXT,
    completed_at TEXT,

    -- Result storage
    result TEXT, -- JSON: execution result
    error TEXT, -- Error message if failed

    -- Failure tracking for quarantine
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    failure_history TEXT, -- JSON: array of {error, timestamp}

    -- Quarantine info
    quarantine_reason TEXT,
    quarantined_at TEXT,

    -- Context for executor
    context TEXT, -- JSON: task details, repo URL, branch, etc.

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_queue_tenant_status ON execution_queue(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_queue_executor ON execution_queue(executor_type, status);
CREATE INDEX IF NOT EXISTS idx_queue_task ON execution_queue(task_id);
CREATE INDEX IF NOT EXISTS idx_queue_priority ON execution_queue(priority DESC, queued_at ASC)
    WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_queue_quarantine ON execution_queue(tenant_id, status)
    WHERE status = 'quarantine';

-- Add executor_type to tasks table for routing hints
ALTER TABLE tasks ADD COLUMN executor_type TEXT;
ALTER TABLE tasks ADD COLUMN failure_count INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN quarantine_status TEXT; -- null, 'quarantine', 'resolved'
ALTER TABLE tasks ADD COLUMN quarantine_reason TEXT;
ALTER TABLE tasks ADD COLUMN quarantined_at TEXT;
