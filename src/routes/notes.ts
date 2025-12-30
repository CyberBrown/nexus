import { Hono } from 'hono';
import type { AppType, Note } from '../types/index.ts';
import { getAuth } from '../lib/auth.ts';
import { findAll, findById, insert, update, softDelete } from '../lib/db.ts';
import { getEncryptionKey, encryptFields, decryptFields } from '../lib/encryption.ts';
import { validate, createNoteSchema, updateNoteSchema } from '../lib/validation.ts';
import { NotFoundError } from '../lib/errors.ts';

const ENCRYPTED_FIELDS = ['title', 'content'];

const notes = new Hono<AppType>();

// List notes
notes.get('/', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const category = c.req.query('category');
  const archived = c.req.query('archived');
  const pinned = c.req.query('pinned');
  const search = c.req.query('search');
  const source_type = c.req.query('source_type');

  let items: Note[];

  // If search query is provided, use FTS5
  if (search && search.trim()) {
    try {
      // Ensure search_text column exists
      try {
        const searchTextCol = await c.env.DB.prepare(
          `SELECT name FROM pragma_table_info('notes') WHERE name = 'search_text'`
        ).first<{ name: string } | null>();
        if (!searchTextCol) {
          await c.env.DB.prepare(`ALTER TABLE notes ADD COLUMN search_text TEXT`).run();
        }
      } catch { /* ignore */ }

      // Check and fix FTS5 schema - aggressively rebuild if incomplete
      let ftsNeedsRebuild = false;
      try {
        const ftsTable = await c.env.DB.prepare(
          `SELECT name, sql FROM sqlite_master WHERE type='table' AND name='notes_fts'`
        ).first<{ name: string; sql: string } | null>();

        if (!ftsTable || !ftsTable.sql || !ftsTable.sql.includes('note_id')) {
          await c.env.DB.prepare(`DROP TABLE IF EXISTS notes_fts`).run();
          await c.env.DB.prepare(`
            CREATE VIRTUAL TABLE notes_fts USING fts5(
              note_id UNINDEXED,
              search_text,
              tokenize='porter unicode61'
            )
          `).run();
          ftsNeedsRebuild = true;
        } else {
          // Check if FTS index is incomplete
          const ftsCount = await c.env.DB.prepare(`
            SELECT COUNT(*) as cnt FROM notes_fts WHERE note_id IN (
              SELECT id FROM notes WHERE tenant_id = ? AND user_id = ? AND deleted_at IS NULL
            )
          `).bind(tenantId, userId).first<{ cnt: number }>();

          const notesCount = await c.env.DB.prepare(`
            SELECT COUNT(*) as cnt FROM notes WHERE tenant_id = ? AND user_id = ? AND deleted_at IS NULL
          `).bind(tenantId, userId).first<{ cnt: number }>();

          // If FTS has ANY fewer entries than notes, trigger rebuild
          if ((ftsCount?.cnt || 0) < (notesCount?.cnt || 0)) {
            ftsNeedsRebuild = true;
          }
        }

        // Rebuild FTS if needed
        if (ftsNeedsRebuild) {
          // First, populate search_text for notes that don't have it
          const notesWithoutSearchText = await c.env.DB.prepare(`
            SELECT id, title, content, tags FROM notes
            WHERE tenant_id = ? AND user_id = ? AND deleted_at IS NULL
              AND (search_text IS NULL OR search_text = '' OR TRIM(search_text) = '')
            LIMIT 100
          `).bind(tenantId, userId).all<{ id: string; title: string | null; content: string | null; tags: string | null }>();

          for (const note of notesWithoutSearchText.results || []) {
            const searchText = [
              note.title || '',
              note.content || '',
              note.tags || ''
            ].join(' ').trim().toLowerCase();

            if (searchText) {
              try {
                await c.env.DB.prepare(`UPDATE notes SET search_text = ? WHERE id = ?`)
                  .bind(searchText, note.id).run();
              } catch { /* ignore */ }
            }
          }

          // Clear and repopulate FTS index
          await c.env.DB.prepare(`
            DELETE FROM notes_fts WHERE note_id IN (
              SELECT id FROM notes WHERE tenant_id = ? AND user_id = ?
            )
          `).bind(tenantId, userId).run();

          await c.env.DB.prepare(`
            INSERT INTO notes_fts (note_id, search_text)
            SELECT id, search_text FROM notes
            WHERE tenant_id = ? AND user_id = ? AND deleted_at IS NULL
              AND search_text IS NOT NULL AND search_text != '' AND TRIM(search_text) != ''
          `).bind(tenantId, userId).run();
        }
      } catch { /* ignore FTS setup errors */ }

      // Parse search terms
      const ftsTerms: string[] = [];
      const searchTerms: string[] = [];
      const trimmedSearch = search.trim();
      const phraseRegex = /"([^"]+)"/g;
      let lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = phraseRegex.exec(trimmedSearch)) !== null) {
        const before = trimmedSearch.slice(lastIndex, match.index).trim();
        if (before) {
          for (const word of before.split(/\s+/).filter((w: string) => w.length > 0)) {
            const escaped = word.replace(/[*^"():'"]/g, '').toLowerCase();
            if (escaped.length > 0) {
              ftsTerms.push(escaped);
              searchTerms.push(escaped);
            }
          }
        }
        const phrase = match[1]!.trim();
        if (phrase.length > 0) {
          const escapedPhrase = phrase.replace(/"/g, '').toLowerCase();
          ftsTerms.push(`"${escapedPhrase}"`);
          searchTerms.push(escapedPhrase);
        }
        lastIndex = match.index + match[0].length;
      }

      const remaining = trimmedSearch.slice(lastIndex).trim();
      if (remaining) {
        for (const word of remaining.split(/\s+/).filter((w: string) => w.length > 0)) {
          const escaped = word.replace(/[*^"():'"]/g, '').toLowerCase();
          if (escaped.length > 0) {
            ftsTerms.push(escaped);
            searchTerms.push(escaped);
          }
        }
      }

      const matchesAllTerms = (text: string): boolean => {
        const lowerText = text.toLowerCase();
        return searchTerms.every(term => lowerText.includes(term));
      };

      // Build FTS5 query with OR for broad matching
      // D1's FTS5 has known issues with AND operator - it can silently fail
      // We use OR to get all potentially matching results, then post-filter
      // with matchesAllTerms() to enforce AND semantics in application code
      //
      // FTS5 query syntax notes:
      // - Use prefix matching (term*) for more forgiving search
      // - Wrap OR expressions in parentheses for proper parsing
      const ftsQuery = ftsTerms.length === 1
        ? (ftsTerms[0]!.startsWith('"') ? ftsTerms[0] : `${ftsTerms[0]}*`)
        : ftsTerms.length > 0
          ? '(' + ftsTerms.map(term => {
              if (term.startsWith('"') && term.endsWith('"')) {
                return term;
              }
              return `${term}*`;
            }).join(' OR ') + ')'
          : '';

      if (ftsQuery) {
        // Build conditions
        const conditions: string[] = [];
        const bindings: (string | number)[] = [ftsQuery, tenantId, userId];

        if (category) {
          conditions.push('n.category = ?');
          bindings.push(category);
        }
        if (archived === 'true') {
          conditions.push('n.archived_at IS NOT NULL');
        } else if (archived === 'false' || !archived) {
          conditions.push('n.archived_at IS NULL');
        }
        if (pinned === 'true') {
          conditions.push('n.pinned = 1');
        }
        if (source_type) {
          conditions.push('n.source_type = ?');
          bindings.push(source_type);
        }

        const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

        // FTS5 search with try-catch to gracefully fall back to LIKE
        try {
          const result = await c.env.DB.prepare(`
            SELECT n.*
            FROM notes n
            WHERE n.id IN (
              SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?
            )
              AND n.tenant_id = ?
              AND n.user_id = ?
              AND n.deleted_at IS NULL
              ${whereClause}
            ORDER BY n.pinned DESC, n.created_at DESC
            LIMIT 200
          `).bind(...bindings).all<Note>();

          // Post-filter for exact term matching
          const encryptionKey = await getEncryptionKey(c.env.KV, tenantId);
          const filteredResults: Note[] = [];
          for (const note of result.results) {
            const decrypted = await decryptFields(note, ENCRYPTED_FIELDS, encryptionKey);
            const combinedText = `${decrypted.title || ''} ${decrypted.content || ''} ${note.tags || ''}`;
            if (matchesAllTerms(combinedText)) {
              filteredResults.push(note);
            }
          }
          items = filteredResults;
        } catch (ftsError) {
          console.error('[notes] FTS5 search failed, will fall back to LIKE:', ftsError);
          items = []; // Ensure LIKE fallback runs
        }

        // LIKE fallback if FTS5 returns no results or fails
        if (items.length === 0 && searchTerms.length > 0) {
          try {
            const likeConditions = searchTerms.map(() => 'search_text LIKE ?').join(' AND ');
            const likeBindings: (string | number)[] = [tenantId, userId];
            for (const term of searchTerms) {
              likeBindings.push(`%${term}%`);
            }
            if (category) likeBindings.push(category);
            if (source_type) likeBindings.push(source_type);

            const likeResult = await c.env.DB.prepare(`
              SELECT n.*
              FROM notes n
              WHERE n.tenant_id = ?
                AND n.user_id = ?
                AND n.deleted_at IS NULL
                AND n.search_text IS NOT NULL AND n.search_text != ''
                AND (${likeConditions})
                ${category ? 'AND n.category = ?' : ''}
                ${archived === 'true' ? 'AND n.archived_at IS NOT NULL' : (archived === 'false' || !archived) ? 'AND n.archived_at IS NULL' : ''}
                ${pinned === 'true' ? 'AND n.pinned = 1' : ''}
                ${source_type ? 'AND n.source_type = ?' : ''}
              ORDER BY n.pinned DESC, n.created_at DESC
              LIMIT 100
            `).bind(...likeBindings).all<Note>();

            for (const note of likeResult.results) {
              const decrypted = await decryptFields(note, ENCRYPTED_FIELDS, encryptionKey);
              const combinedText = `${decrypted.title || ''} ${decrypted.content || ''} ${note.tags || ''}`;
              if (matchesAllTerms(combinedText)) {
                items.push(note);
              }
            }
          } catch { /* ignore LIKE errors */ }
        }

        // Full scan fallback if still no results
        if (items.length === 0 && searchTerms.length > 0) {
          const encryptionKey = await getEncryptionKey(c.env.KV, tenantId);
          const allNotes = await c.env.DB.prepare(`
            SELECT * FROM notes
            WHERE tenant_id = ? AND user_id = ? AND deleted_at IS NULL
              ${archived === 'true' ? 'AND archived_at IS NOT NULL' : (archived === 'false' || !archived) ? 'AND archived_at IS NULL' : ''}
              ${category ? 'AND category = ?' : ''}
              ${pinned === 'true' ? 'AND pinned = 1' : ''}
              ${source_type ? 'AND source_type = ?' : ''}
            ORDER BY pinned DESC, created_at DESC
          `).bind(tenantId, userId, ...(category ? [category] : []), ...(source_type ? [source_type] : [])).all<Note>();

          for (const note of allNotes.results || []) {
            const decrypted = await decryptFields(note, ENCRYPTED_FIELDS, encryptionKey);
            const combinedText = `${decrypted.title || ''} ${decrypted.content || ''} ${note.tags || ''}`;
            if (matchesAllTerms(combinedText)) {
              items.push(note);

              // Auto-repair search_text and FTS
              const searchText = combinedText.toLowerCase();
              try {
                await c.env.DB.prepare(`UPDATE notes SET search_text = ? WHERE id = ?`)
                  .bind(searchText, note.id).run();
                await c.env.DB.prepare(`DELETE FROM notes_fts WHERE note_id = ?`).bind(note.id).run();
                await c.env.DB.prepare(`INSERT INTO notes_fts (note_id, search_text) VALUES (?, ?)`)
                  .bind(note.id, searchText).run();
              } catch { /* ignore repair errors */ }
            }
            if (items.length >= 100) break;
          }
        }
      } else {
        items = [];
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Fallback to in-memory search if FTS5 not available
      if (errorMessage.includes('no such table') || errorMessage.includes('notes_fts')) {
        items = await findAll<Note>(c.env.DB, 'notes', {
          tenantId,
          orderBy: 'pinned DESC, created_at DESC',
        });
        items = items.filter((item) => item.user_id === userId);

        // Apply filters
        if (category) {
          items = items.filter((item) => item.category === category);
        }
        if (archived === 'true') {
          items = items.filter((item) => item.archived_at !== null);
        } else if (archived === 'false' || !archived) {
          items = items.filter((item) => item.archived_at === null);
        }
        if (pinned === 'true') {
          items = items.filter((item) => item.pinned === 1);
        }
        if (source_type) {
          items = items.filter((item) => item.source_type === source_type);
        }

        // In-memory search
        const searchTerms: string[] = [];
        const quotedRegex = /"([^"]+)"/g;
        let match: RegExpExecArray | null;
        let queryWithoutQuotes = search;

        while ((match = quotedRegex.exec(search)) !== null) {
          searchTerms.push(match[1]!.toLowerCase().trim());
        }
        queryWithoutQuotes = search.replace(quotedRegex, '').trim();

        const words = queryWithoutQuotes.split(/\s+/).filter((w: string) => w.length > 0);
        for (const word of words) {
          searchTerms.push(word.toLowerCase().trim());
        }

        if (searchTerms.length > 0) {
          // Get encryption key for decrypting content when search_text is NULL
          const encryptionKey = await getEncryptionKey(c.env.KV, tenantId);

          // Filter items - always check actual content, don't trust search_text
          // search_text may be corrupted/stale from old migrations
          const filteredItems: Note[] = [];
          for (const item of items) {
            // Try raw values first (encryption is now disabled)
            const rawTitle = item.title ? String(item.title) : '';
            const rawContent = item.content ? String(item.content) : '';
            const tagsText = item.tags ? String(item.tags) : '';

            let searchableText = `${rawTitle} ${rawContent} ${tagsText}`.toLowerCase();

            // If raw values don't match, try decryption (for older encrypted notes)
            if (!searchTerms.every((term) => searchableText.includes(term))) {
              const decrypted = await decryptFields(item, ENCRYPTED_FIELDS, encryptionKey);
              searchableText = `${decrypted.title || ''} ${decrypted.content || ''} ${tagsText}`.toLowerCase();
            }

            if (searchTerms.every((term) => searchableText.includes(term))) {
              filteredItems.push(item);
            }
          }
          items = filteredItems;
        }
      } else {
        throw error;
      }
    }
  } else {
    // No search query - fetch all with filters
    items = await findAll<Note>(c.env.DB, 'notes', {
      tenantId,
      orderBy: 'pinned DESC, created_at DESC',
    });

    // Filter by user
    items = items.filter((item) => item.user_id === userId);

    // Optional filters
    if (category) {
      items = items.filter((item) => item.category === category);
    }
    if (archived === 'true') {
      items = items.filter((item) => item.archived_at !== null);
    } else if (archived === 'false' || !archived) {
      // Default: exclude archived
      items = items.filter((item) => item.archived_at === null);
    }
    if (pinned === 'true') {
      items = items.filter((item) => item.pinned === 1);
    }
    if (source_type) {
      items = items.filter((item) => item.source_type === source_type);
    }
  }

  // Decrypt sensitive fields (pass-through when encryption is disabled)
  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decryptedItems = await Promise.all(
    items.map((item) => decryptFields(item, ENCRYPTED_FIELDS, key))
  );

  return c.json({ success: true, data: decryptedItems });
});

// Get single note
notes.get('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const item = await findById<Note>(c.env.DB, 'notes', id, { tenantId });

  if (!item || item.user_id !== userId) {
    throw new NotFoundError('Note', id);
  }

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decrypted = await decryptFields(item, ENCRYPTED_FIELDS, key);

  return c.json({ success: true, data: decrypted });
});

// Create note
notes.post('/', async (c) => {
  const { tenantId, userId } = getAuth(c);

  const body = await c.req.json();
  const validated = validate(createNoteSchema, body);

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const id = crypto.randomUUID();

  // Build plaintext search_text for FTS indexing
  // MUST lowercase because D1's FTS5 is case-sensitive and query terms are lowercased
  const searchText = [validated.title, validated.content || '', validated.tags || ''].join(' ').trim().toLowerCase();

  const note: Partial<Note> & { search_text?: string } = {
    id,
    tenant_id: tenantId,
    user_id: userId,
    title: validated.title,
    content: validated.content ?? null,
    category: validated.category ?? 'general',
    tags: validated.tags ?? null,
    source_type: validated.source_type ?? null,
    source_reference: validated.source_reference ?? null,
    source_context: validated.source_context ?? null,
    pinned: validated.pinned ? 1 : 0,
    archived_at: null,
    search_text: searchText,
  };

  const encrypted = await encryptFields(note, ENCRYPTED_FIELDS, key);
  await insert(c.env.DB, 'notes', encrypted);

  // Explicitly insert into FTS index (don't rely on triggers - D1 triggers can be unreliable)
  if (searchText) {
    try {
      await c.env.DB.prepare(`INSERT INTO notes_fts (note_id, search_text) VALUES (?, ?)`)
        .bind(id, searchText).run();
    } catch {
      // FTS insert failed, but note was created - search will use fallback
    }
  }

  return c.json({ success: true, data: { id } }, 201);
});

// Update note
notes.patch('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const existing = await findById<Note>(c.env.DB, 'notes', id, { tenantId });

  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Note', id);
  }

  const body = await c.req.json();
  const validated = validate(updateNoteSchema, body);

  const key = await getEncryptionKey(c.env.KV, tenantId);

  const updates: Partial<Note> & { search_text?: string } = {};

  if (validated.title !== undefined) updates.title = validated.title;
  if (validated.content !== undefined) updates.content = validated.content;
  if (validated.category !== undefined) updates.category = validated.category;
  if (validated.tags !== undefined) updates.tags = validated.tags;
  if (validated.source_type !== undefined) updates.source_type = validated.source_type;
  if (validated.source_reference !== undefined) updates.source_reference = validated.source_reference;
  if (validated.source_context !== undefined) updates.source_context = validated.source_context;
  if (validated.pinned !== undefined) updates.pinned = validated.pinned ? 1 : 0;
  if (validated.archived_at !== undefined) updates.archived_at = validated.archived_at;

  // If title, content, or tags changed, rebuild search_text and update FTS
  if (validated.title !== undefined || validated.content !== undefined || validated.tags !== undefined) {
    const { decryptField } = await import('../lib/encryption.ts');

    // Get current plaintext values for fields not being updated
    const plaintextTitle = validated.title !== undefined
      ? validated.title
      : await decryptField(existing.title, key);
    const plaintextContent = validated.content !== undefined
      ? validated.content
      : (existing.content ? await decryptField(existing.content, key) : null);
    const plaintextTags = validated.tags !== undefined
      ? validated.tags
      : existing.tags;

    // MUST lowercase because D1's FTS5 is case-sensitive and query terms are lowercased
    const searchText = [plaintextTitle || '', plaintextContent || '', plaintextTags || ''].join(' ').trim().toLowerCase();
    updates.search_text = searchText;
  }

  if (Object.keys(updates).length > 0) {
    const encrypted = await encryptFields(updates, ENCRYPTED_FIELDS, key);
    await update(c.env.DB, 'notes', id, encrypted, { tenantId });

    // Explicitly update FTS index if search_text changed (don't rely on triggers)
    if (updates.search_text) {
      try {
        await c.env.DB.prepare(`DELETE FROM notes_fts WHERE note_id = ?`).bind(id).run();
        await c.env.DB.prepare(`INSERT INTO notes_fts (note_id, search_text) VALUES (?, ?)`)
          .bind(id, updates.search_text).run();
      } catch {
        // FTS update failed, search will use fallback
      }
    }
  }

  return c.json({ success: true, data: { id } });
});

// Delete note (soft delete)
notes.delete('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const existing = await findById<Note>(c.env.DB, 'notes', id, { tenantId });

  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Note', id);
  }

  await softDelete(c.env.DB, 'notes', id, { tenantId });

  // Explicitly remove from FTS index (don't rely on triggers - D1 triggers can be unreliable)
  try {
    await c.env.DB.prepare(`DELETE FROM notes_fts WHERE note_id = ?`).bind(id).run();
  } catch {
    // FTS delete failed, but note was soft deleted - search will filter it out anyway
  }

  return c.json({ success: true, data: { id } });
});

// Archive note
notes.post('/:id/archive', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const existing = await findById<Note>(c.env.DB, 'notes', id, { tenantId });

  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Note', id);
  }

  await update(c.env.DB, 'notes', id, { archived_at: new Date().toISOString() }, { tenantId });

  return c.json({ success: true, data: { id, archived: true } });
});

// Unarchive note
notes.post('/:id/unarchive', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const existing = await findById<Note>(c.env.DB, 'notes', id, { tenantId });

  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Note', id);
  }

  await update(c.env.DB, 'notes', id, { archived_at: null }, { tenantId });

  return c.json({ success: true, data: { id, archived: false } });
});

// Pin/unpin note
notes.post('/:id/pin', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const existing = await findById<Note>(c.env.DB, 'notes', id, { tenantId });

  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Note', id);
  }

  const newPinned = existing.pinned === 1 ? 0 : 1;
  await update(c.env.DB, 'notes', id, { pinned: newPinned }, { tenantId });

  return c.json({ success: true, data: { id, pinned: newPinned === 1 } });
});

// Rebuild FTS5 index for all notes
// POST /api/notes/rebuild-fts
// Decrypts all notes and rebuilds the search_text column and FTS5 index
notes.post('/rebuild-fts', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const key = await getEncryptionKey(c.env.KV, tenantId);

    // Ensure search_text column exists
    try {
      const searchTextCol = await c.env.DB.prepare(
        `SELECT name FROM pragma_table_info('notes') WHERE name = 'search_text'`
      ).first<{ name: string } | null>();

      if (!searchTextCol) {
        await c.env.DB.prepare(`ALTER TABLE notes ADD COLUMN search_text TEXT`).run();
      }
    } catch {
      // Column check failed, continue
    }

    // Ensure FTS5 table exists with correct schema
    // Use sqlite_master instead of pragma_table_info (more reliable for virtual tables)
    try {
      const ftsTable = await c.env.DB.prepare(
        `SELECT name, sql FROM sqlite_master WHERE type='table' AND name='notes_fts'`
      ).first<{ name: string; sql: string } | null>();

      // Recreate FTS5 table if it doesn't exist or has old schema (missing note_id column)
      if (!ftsTable || !ftsTable.sql || !ftsTable.sql.includes('note_id')) {
        await c.env.DB.prepare(`DROP TABLE IF EXISTS notes_fts`).run();
        await c.env.DB.prepare(`
          CREATE VIRTUAL TABLE notes_fts USING fts5(
            note_id UNINDEXED,
            search_text,
            tokenize='porter unicode61'
          )
        `).run();
      }
    } catch {
      // Schema check failed
    }

    // Get all non-deleted notes for this user
    const allNotes = await c.env.DB.prepare(`
      SELECT id, title, content, tags
      FROM notes
      WHERE tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    `).bind(tenantId, userId).all<{
      id: string;
      title: string | null;
      content: string | null;
      tags: string | null;
    }>();

    // Clear FTS index for this user's notes
    await c.env.DB.prepare(`
      DELETE FROM notes_fts WHERE note_id IN (
        SELECT id FROM notes WHERE tenant_id = ? AND user_id = ?
      )
    `).bind(tenantId, userId).run();

    let indexed = 0;
    let errors = 0;

    for (const note of allNotes.results || []) {
      try {
        // Decrypt fields - handle both encrypted and plaintext
        let decryptedTitle = '';
        let decryptedContent = '';

        if (note.title) {
          try {
            const { decryptField } = await import('../lib/encryption.ts');
            decryptedTitle = await decryptField(note.title, key);
          } catch {
            decryptedTitle = note.title; // Already plaintext
          }
        }

        if (note.content) {
          try {
            const { decryptField } = await import('../lib/encryption.ts');
            decryptedContent = await decryptField(note.content, key);
          } catch {
            decryptedContent = note.content; // Already plaintext
          }
        }

        const tags = note.tags || '';

        // Build search text - MUST lowercase for D1's case-sensitive FTS5
        const searchText = [decryptedTitle, decryptedContent, tags].join(' ').trim().toLowerCase();

        if (searchText) {
          // Update notes table search_text column
          await c.env.DB.prepare(`
            UPDATE notes SET search_text = ? WHERE id = ?
          `).bind(searchText, note.id).run();

          // Insert into FTS index
          await c.env.DB.prepare(`
            INSERT INTO notes_fts (note_id, search_text) VALUES (?, ?)
          `).bind(note.id, searchText).run();

          indexed++;
        }
      } catch (e) {
        console.error(`Failed to index note ${note.id}:`, e);
        errors++;
      }
    }

    return c.json({
      success: true,
      data: {
        total: allNotes.results?.length || 0,
        indexed,
        errors,
        message: `Rebuilt FTS index for ${indexed} notes`,
      },
    });
  } catch (error: unknown) {
    console.error('FTS rebuild error:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return c.json({ success: false, error: `FTS rebuild failed: ${errorMessage}` }, 500);
  }
});

export default notes;
