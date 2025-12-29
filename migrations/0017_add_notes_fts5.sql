-- Migration: Add FTS5 Full-Text Search for notes table
-- Enables efficient multi-word search queries instead of LIKE patterns
-- FTS5 supports phrase matching, boolean operators, and ranked results

-- ============================================
-- FTS5 VIRTUAL TABLE
-- ============================================
-- Create a full-text search index for notes
-- We index title and content for search, with id as a reference column
-- Using content="" makes this an external content table that we sync manually

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title,
    content,
    content='notes',
    content_rowid='rowid'
);

-- ============================================
-- TRIGGERS TO KEEP FTS5 INDEX IN SYNC
-- ============================================
-- These triggers automatically update the FTS index when notes are modified

-- Trigger for INSERT: Add new notes to the FTS index
CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, content)
    VALUES (NEW.rowid, NEW.title, COALESCE(NEW.content, ''));
END;

-- Trigger for UPDATE: Update the FTS index when notes are modified
CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content)
    VALUES ('delete', OLD.rowid, OLD.title, COALESCE(OLD.content, ''));
    INSERT INTO notes_fts(rowid, title, content)
    VALUES (NEW.rowid, NEW.title, COALESCE(NEW.content, ''));
END;

-- Trigger for DELETE: Remove notes from the FTS index
CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content)
    VALUES ('delete', OLD.rowid, OLD.title, COALESCE(OLD.content, ''));
END;

-- ============================================
-- POPULATE EXISTING DATA
-- ============================================
-- Rebuild the FTS index with all existing notes
-- This ensures existing notes are searchable immediately after migration

INSERT INTO notes_fts(rowid, title, content)
SELECT rowid, title, COALESCE(content, '')
FROM notes
WHERE deleted_at IS NULL;
