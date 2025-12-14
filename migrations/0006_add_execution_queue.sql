-- Migration: Add execution queue table for task dispatcher
-- Tracks tasks queued for different executor types

CREATE TABLE IF NOT EXISTS execution_queue (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),

    -- Reference to the task being executed
    task_id TEXT NOT NULL REFERENCES tasks(id),

    -- Executor routing
    executor_type TEXT NOT NULL,  -- 'claude-code', 'claude-ai', 'de-agent', 'human'

    -- Execution state
    status TEXT NOT NULL DEFAULT 'queued',  -- 'queued', 'claimed', 'dispatched', 'completed', 'failed', 'cancelled'
    priority INTEGER DEFAULT 0,  -- Higher = more urgent (based on task urgency/importance)

    -- Timing
    queued_at TEXT NOT NULL DEFAULT (datetime('now')),
    claimed_at TEXT,
    dispatched_at TEXT,
    completed_at TEXT,

    -- Execution details
    claimed_by TEXT,  -- Executor instance identifier (e.g., session ID, agent ID)
    result TEXT,      -- JSON result from execution
    error TEXT,       -- Error message if failed

    -- Metadata
    context TEXT,     -- JSON: Additional context for the executor
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_execution_queue_tenant ON execution_queue(tenant_id);
CREATE INDEX IF NOT EXISTS idx_execution_queue_status ON execution_queue(status, executor_type);
CREATE INDEX IF NOT EXISTS idx_execution_queue_executor ON execution_queue(executor_type, status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_execution_queue_task ON execution_queue(task_id);

-- Dispatch log for tracking all dispatch attempts (immutable history)
CREATE TABLE IF NOT EXISTS dispatch_log (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),

    -- What was dispatched
    queue_entry_id TEXT REFERENCES execution_queue(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    executor_type TEXT NOT NULL,

    -- What happened
    action TEXT NOT NULL,  -- 'queued', 'claimed', 'dispatched', 'completed', 'failed', 'cancelled', 'retry'

    -- Context
    details TEXT,  -- JSON: Additional details about this action

    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dispatch_log_tenant ON dispatch_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_log_task ON dispatch_log(task_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_log_queue ON dispatch_log(queue_entry_id);
