-- Migration: Add code execution fields to idea_tasks
-- For sandbox-executor integration with GitHub repos

-- Repository information for code tasks
ALTER TABLE idea_tasks ADD COLUMN repo TEXT;           -- e.g., "CyberBrown/distributed-electrons"
ALTER TABLE idea_tasks ADD COLUMN branch TEXT;         -- e.g., "feature/my-feature" or "main"
ALTER TABLE idea_tasks ADD COLUMN commit_message TEXT; -- Custom commit message

-- Create index for finding code tasks by repo
CREATE INDEX IF NOT EXISTS idx_idea_tasks_repo ON idea_tasks(repo) WHERE repo IS NOT NULL;
