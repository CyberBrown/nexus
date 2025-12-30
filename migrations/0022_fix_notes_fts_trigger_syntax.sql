-- Migration: Fix FTS5 trigger syntax for D1 compatibility
--
-- Problem: The INSERT trigger in 0020 uses INSERT OR REPLACE which doesn't work
-- with FTS5 tables (FTS5 doesn't have a concept of primary keys for REPLACE).
--
-- Solution: Use DELETE then INSERT pattern instead of INSERT OR REPLACE.

-- Drop existing triggers
DROP TRIGGER IF EXISTS notes_fts_sync_insert;
DROP TRIGGER IF EXISTS notes_fts_sync_update;
DROP TRIGGER IF EXISTS notes_fts_sync_delete;

-- Trigger: Sync search_text to FTS when a note is inserted
-- Uses DELETE + INSERT pattern instead of INSERT OR REPLACE
CREATE TRIGGER notes_fts_sync_insert AFTER INSERT ON notes
WHEN NEW.deleted_at IS NULL AND NEW.search_text IS NOT NULL AND NEW.search_text != ''
BEGIN
    -- Delete any existing entry first (shouldn't exist, but safety)
    DELETE FROM notes_fts WHERE note_id = NEW.id;
    -- Insert new entry
    INSERT INTO notes_fts (note_id, search_text)
    VALUES (NEW.id, NEW.search_text);
END;

-- Trigger: Sync search_text to FTS when a note is updated
-- Handles both search_text changes and soft deletes
CREATE TRIGGER notes_fts_sync_update AFTER UPDATE ON notes
BEGIN
    -- Always remove old FTS entry
    DELETE FROM notes_fts WHERE note_id = OLD.id;

    -- Insert new entry only if not soft-deleted and has search_text
    INSERT INTO notes_fts (note_id, search_text)
    SELECT NEW.id, NEW.search_text
    WHERE NEW.deleted_at IS NULL
      AND NEW.search_text IS NOT NULL
      AND NEW.search_text != '';
END;

-- Trigger: Remove from FTS when a note is hard deleted
CREATE TRIGGER notes_fts_sync_delete AFTER DELETE ON notes
BEGIN
    DELETE FROM notes_fts WHERE note_id = OLD.id;
END;
