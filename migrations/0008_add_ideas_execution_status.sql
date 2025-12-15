-- Migration: Add missing execution_status column to ideas table
-- This column was supposed to be added in 0003_execution_loop.sql but was missed

-- Add execution_status column to ideas table
ALTER TABLE ideas ADD COLUMN execution_status TEXT DEFAULT 'new';

-- Create index for execution status filtering (if not exists)
CREATE INDEX IF NOT EXISTS idx_ideas_execution_status ON ideas(tenant_id, execution_status);
