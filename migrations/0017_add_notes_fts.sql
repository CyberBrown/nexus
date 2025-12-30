-- Migration: Add FTS5 full-text search for notes
-- Enables efficient multi-word search on notes content

-- Create the FTS5 virtual table for notes full-text search
-- Using content= to create a contentless FTS5 table that references the notes table
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title,
    content,
    tags,
    content='notes',
    content_rowid='rowid'
);

-- Populate the FTS index with existing notes
-- Only index non-deleted notes (we'll handle deleted notes via triggers)
INSERT INTO notes_fts(rowid, title, content, tags)
SELECT rowid,
       COALESCE(title, ''),
       COALESCE(content, ''),
       COALESCE(tags, '')
FROM notes
WHERE deleted_at IS NULL;

-- Trigger to keep FTS index in sync when notes are inserted
CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes
WHEN NEW.deleted_at IS NULL
BEGIN
    INSERT INTO notes_fts(rowid, title, content, tags)
    VALUES (NEW.rowid, COALESCE(NEW.title, ''), COALESCE(NEW.content, ''), COALESCE(NEW.tags, ''));
END;

-- Trigger to update FTS index when notes are updated
CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes
BEGIN
    -- Delete old entry
    DELETE FROM notes_fts WHERE rowid = OLD.rowid;
    -- Insert new entry only if not deleted
    INSERT INTO notes_fts(rowid, title, content, tags)
    SELECT NEW.rowid, COALESCE(NEW.title, ''), COALESCE(NEW.content, ''), COALESCE(NEW.tags, '')
    WHERE NEW.deleted_at IS NULL;
END;

-- Trigger to remove from FTS index when notes are deleted (hard delete)
CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes
BEGIN
    DELETE FROM notes_fts WHERE rowid = OLD.rowid;
END;
