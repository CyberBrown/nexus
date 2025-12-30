-- Migration: Fix FTS5 for encrypted notes
-- The previous FTS5 migration indexed encrypted content which doesn't work for search.
-- This adds a search_text column to store plaintext for FTS indexing while keeping
-- title/content encrypted for security.

-- Drop the old FTS5 table and triggers that were indexing encrypted content
DROP TRIGGER IF EXISTS notes_fts_insert;
DROP TRIGGER IF EXISTS notes_fts_update;
DROP TRIGGER IF EXISTS notes_fts_delete;
DROP TABLE IF EXISTS notes_fts;

-- Add search_text column to notes table to hold plaintext search content
-- This will be populated by the application when creating/updating notes
ALTER TABLE notes ADD COLUMN search_text TEXT;

-- Create the FTS5 virtual table that indexes the search_text column
-- Using a standalone FTS5 table (not contentless) so we control the data
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    note_id UNINDEXED,
    search_text,
    tokenize='porter unicode61'
);

-- Note: The application must now explicitly insert/update/delete from notes_fts
-- since the triggers can't work with application-level encryption.
-- This is handled in the MCP tools and REST API endpoints.

-- IMPORTANT: Existing notes will NOT be searchable until re-indexed.
-- After deployment, run the reindex_notes tool or manually update each note
-- to populate the search_text column and FTS index.
-- New notes created after this migration will be searchable immediately.
