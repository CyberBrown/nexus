-- Migration: Add missing task count columns to idea_executions
-- These columns were defined in 0003 but 0004 created the table without them

-- Add total_tasks column
ALTER TABLE idea_executions ADD COLUMN total_tasks INTEGER DEFAULT 0;

-- Add completed_tasks column
ALTER TABLE idea_executions ADD COLUMN completed_tasks INTEGER DEFAULT 0;

-- Add failed_tasks column
ALTER TABLE idea_executions ADD COLUMN failed_tasks INTEGER DEFAULT 0;
