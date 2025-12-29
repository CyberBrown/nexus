-- Migration: Add execution_archive table for completed/failed/cancelled queue entries
-- Keeps execution_queue lean while preserving historical execution records

CREATE TABLE IF NOT EXISTS execution_archive (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,

    -- Reference to the task that was executed
    task_id TEXT NOT NULL,

    -- Executor routing
    executor_type TEXT NOT NULL,  -- 'ai', 'human-ai', 'human'

    -- Final execution state (only terminal states in archive)
    status TEXT NOT NULL,  -- 'completed', 'failed', 'cancelled'
    priority INTEGER DEFAULT 0,

    -- Timing
    queued_at TEXT NOT NULL,
    claimed_at TEXT,
    dispatched_at TEXT,
    completed_at TEXT,

    -- Execution details
    claimed_by TEXT,
    result TEXT,      -- JSON result from execution
    error TEXT,       -- Error message if failed

    -- Metadata
    context TEXT,     -- JSON: Additional context for the executor
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    -- Archive-specific field
    archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_execution_archive_tenant ON execution_archive(tenant_id);
CREATE INDEX IF NOT EXISTS idx_execution_archive_task ON execution_archive(task_id);
CREATE INDEX IF NOT EXISTS idx_execution_archive_status ON execution_archive(status);
CREATE INDEX IF NOT EXISTS idx_execution_archive_archived_at ON execution_archive(archived_at);
CREATE INDEX IF NOT EXISTS idx_execution_archive_executor ON execution_archive(executor_type, status);
