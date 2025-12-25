-- Migration: Add task dependencies table
-- Allows tasks to depend on other tasks (blocking relationship)
-- A task with unmet dependencies stays in status='next' but won't be queued

-- Task dependencies junction table
CREATE TABLE IF NOT EXISTS task_dependencies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,            -- The task that is blocked
  depends_on_task_id TEXT NOT NULL, -- The task that must complete first
  dependency_type TEXT DEFAULT 'blocks', -- 'blocks' (enforced), 'suggests', 'related'
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id),
  UNIQUE(tenant_id, task_id, depends_on_task_id)
);

-- Index for finding what a task depends on (blocking it)
CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(tenant_id, task_id);

-- Index for finding what tasks depend on a given task (blocked by it)
CREATE INDEX IF NOT EXISTS idx_task_deps_blocking ON task_dependencies(tenant_id, depends_on_task_id);
