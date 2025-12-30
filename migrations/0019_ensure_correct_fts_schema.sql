-- Migration: Ensure correct FTS5 schema for notes
-- Fixes schema mismatch if old migration (0017) was applied but 0018 wasn't

-- Drop old triggers that may interfere with the new FTS setup
DROP TRIGGER IF EXISTS notes_fts_insert;
DROP TRIGGER IF EXISTS notes_fts_update;
DROP TRIGGER IF EXISTS notes_fts_delete;

-- Drop the old FTS table (may have wrong schema)
DROP TABLE IF EXISTS notes_fts;

-- Add search_text column if it doesn't exist (was added in 0018)
-- Note: D1/SQLite doesn't support ADD COLUMN IF NOT EXISTS, so we catch the error
-- ALTER TABLE notes ADD COLUMN search_text TEXT;

-- Create the FTS5 virtual table with correct schema
-- Uses note_id for linking and search_text for indexing
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    note_id UNINDEXED,
    search_text,
    tokenize='porter unicode61'
);

-- Note: After applying this migration, run nexus_rebuild_notes_fts to populate the index
-- The search_text column and FTS index must be populated for search to work
