// Queue Archive Helper
// Archives completed/failed/cancelled queue entries and removes them from the active queue

import type { D1Database } from '@cloudflare/workers-types';

/**
 * Archive a queue entry and delete it from the active queue.
 * Call this after setting a terminal status (completed, failed, cancelled).
 *
 * @param db - D1 database instance
 * @param queueId - The queue entry ID to archive
 * @param tenantId - The tenant ID
 * @returns Number of entries archived (0 or 1)
 */
export async function archiveQueueEntry(
  db: D1Database,
  queueId: string,
  tenantId: string
): Promise<number> {
  const now = new Date().toISOString();

  // Archive the entry
  const archiveResult = await db.prepare(`
    INSERT INTO execution_archive (
      id, tenant_id, user_id, task_id, executor_type, status, priority,
      queued_at, claimed_at, dispatched_at, completed_at,
      claimed_by, result, error, context, retry_count, max_retries,
      created_at, updated_at, archived_at
    )
    SELECT
      id, tenant_id, user_id, task_id, executor_type, status, priority,
      queued_at, claimed_at, dispatched_at, completed_at,
      claimed_by, result, error, context, retry_count, max_retries,
      created_at, updated_at, ?
    FROM execution_queue WHERE id = ? AND tenant_id = ?
  `).bind(now, queueId, tenantId).run();

  // Delete from active queue
  if (archiveResult.meta.changes > 0) {
    // Nullify dispatch_log references first (FK constraint)
    await db.prepare(`
      UPDATE dispatch_log SET queue_entry_id = NULL WHERE queue_entry_id = ?
    `).bind(queueId).run();

    await db.prepare(`
      DELETE FROM execution_queue WHERE id = ? AND tenant_id = ?
    `).bind(queueId, tenantId).run();
  }

  return archiveResult.meta.changes || 0;
}

/**
 * Archive multiple queue entries by task ID.
 * Useful when completing a task that may have multiple queue entries.
 *
 * @param db - D1 database instance
 * @param taskId - The task ID whose queue entries should be archived
 * @param tenantId - The tenant ID
 * @param statuses - Which statuses to archive (default: terminal statuses)
 * @returns Number of entries archived
 */
export async function archiveQueueEntriesByTask(
  db: D1Database,
  taskId: string,
  tenantId: string,
  statuses: string[] = ['completed', 'failed', 'cancelled']
): Promise<number> {
  const now = new Date().toISOString();
  const statusList = statuses.map(() => '?').join(', ');

  // Archive all matching entries
  const archiveResult = await db.prepare(`
    INSERT INTO execution_archive (
      id, tenant_id, user_id, task_id, executor_type, status, priority,
      queued_at, claimed_at, dispatched_at, completed_at,
      claimed_by, result, error, context, retry_count, max_retries,
      created_at, updated_at, archived_at
    )
    SELECT
      id, tenant_id, user_id, task_id, executor_type, status, priority,
      queued_at, claimed_at, dispatched_at, completed_at,
      claimed_by, result, error, context, retry_count, max_retries,
      created_at, updated_at, ?
    FROM execution_queue
    WHERE task_id = ? AND tenant_id = ? AND status IN (${statusList})
  `).bind(now, taskId, tenantId, ...statuses).run();

  // Delete from active queue
  if (archiveResult.meta.changes > 0) {
    // Nullify dispatch_log references first (FK constraint)
    await db.prepare(`
      UPDATE dispatch_log SET queue_entry_id = NULL
      WHERE queue_entry_id IN (
        SELECT id FROM execution_queue
        WHERE task_id = ? AND tenant_id = ? AND status IN (${statusList})
      )
    `).bind(taskId, tenantId, ...statuses).run();

    await db.prepare(`
      DELETE FROM execution_queue
      WHERE task_id = ? AND tenant_id = ? AND status IN (${statusList})
    `).bind(taskId, tenantId, ...statuses).run();
  }

  return archiveResult.meta.changes || 0;
}

/**
 * Bulk archive all terminal-status entries.
 * Useful for one-time cleanup or scheduled maintenance.
 *
 * @param db - D1 database instance
 * @param tenantId - The tenant ID (or null for all tenants)
 * @returns Number of entries archived
 */
export async function archiveAllTerminalEntries(
  db: D1Database,
  tenantId?: string
): Promise<number> {
  const now = new Date().toISOString();

  const whereClause = tenantId
    ? 'WHERE status IN (\'completed\', \'failed\', \'cancelled\') AND tenant_id = ?'
    : 'WHERE status IN (\'completed\', \'failed\', \'cancelled\')';

  const bindings = tenantId ? [now, tenantId] : [now];

  // Archive all terminal entries
  const archiveResult = await db.prepare(`
    INSERT INTO execution_archive (
      id, tenant_id, user_id, task_id, executor_type, status, priority,
      queued_at, claimed_at, dispatched_at, completed_at,
      claimed_by, result, error, context, retry_count, max_retries,
      created_at, updated_at, archived_at
    )
    SELECT
      id, tenant_id, user_id, task_id, executor_type, status, priority,
      queued_at, claimed_at, dispatched_at, completed_at,
      claimed_by, result, error, context, retry_count, max_retries,
      created_at, updated_at, ?
    FROM execution_queue ${whereClause}
  `).bind(...bindings).run();

  // Delete from active queue
  if (archiveResult.meta.changes > 0) {
    // Nullify dispatch_log references first (FK constraint)
    const nullifyWhereClause = tenantId
      ? 'WHERE status IN (\'completed\', \'failed\', \'cancelled\') AND tenant_id = ?'
      : 'WHERE status IN (\'completed\', \'failed\', \'cancelled\')';
    const nullifyBindings = tenantId ? [tenantId] : [];
    await db.prepare(`
      UPDATE dispatch_log SET queue_entry_id = NULL
      WHERE queue_entry_id IN (
        SELECT id FROM execution_queue ${nullifyWhereClause}
      )
    `).bind(...nullifyBindings).run();

    const deleteBindings = tenantId ? [tenantId] : [];
    await db.prepare(`
      DELETE FROM execution_queue ${whereClause.replace('?', tenantId ? '?' : '')}
    `).bind(...deleteBindings).run();
  }

  return archiveResult.meta.changes || 0;
}
