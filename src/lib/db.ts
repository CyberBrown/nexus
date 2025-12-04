import type { Env } from '../types/index.ts';

// D1 database helpers with tenant scoping

export interface QueryOptions {
  tenantId: string;
  includeDeleted?: boolean;
}

// Build a tenant-scoped SELECT query
export function selectQuery(
  table: string,
  columns: string[] = ['*'],
  options: QueryOptions
): { sql: string; bindings: unknown[] } {
  const cols = columns.join(', ');
  let sql = `SELECT ${cols} FROM ${table} WHERE tenant_id = ?`;
  const bindings: unknown[] = [options.tenantId];

  if (!options.includeDeleted) {
    sql += ' AND deleted_at IS NULL';
  }

  return { sql, bindings };
}

// Execute a select all query
export async function findAll<T>(
  db: D1Database,
  table: string,
  options: QueryOptions & { orderBy?: string; limit?: number; offset?: number }
): Promise<T[]> {
  const { sql, bindings } = selectQuery(table, ['*'], options);
  let query = sql;

  if (options.orderBy) {
    query += ` ORDER BY ${options.orderBy}`;
  }
  if (options.limit) {
    query += ` LIMIT ${options.limit}`;
  }
  if (options.offset) {
    query += ` OFFSET ${options.offset}`;
  }

  const result = await db.prepare(query).bind(...bindings).all<T>();
  return result.results;
}

// Find by ID with tenant scope
export async function findById<T>(
  db: D1Database,
  table: string,
  id: string,
  options: QueryOptions
): Promise<T | null> {
  const { sql, bindings } = selectQuery(table, ['*'], options);
  const query = `${sql} AND id = ?`;
  bindings.push(id);

  return await db.prepare(query).bind(...bindings).first<T>();
}

// Insert a new record
export async function insert<T extends Record<string, unknown>>(
  db: D1Database,
  table: string,
  data: T
): Promise<void> {
  const now = new Date().toISOString();
  const record = {
    ...data,
    id: data.id ?? crypto.randomUUID(),
    created_at: now,
    updated_at: now,
  };

  const columns = Object.keys(record);
  const placeholders = columns.map(() => '?').join(', ');
  const values = Object.values(record);

  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
  await db.prepare(sql).bind(...values).run();
}

// Update a record by ID with tenant scope
export async function update<T extends Record<string, unknown>>(
  db: D1Database,
  table: string,
  id: string,
  data: T,
  options: QueryOptions
): Promise<boolean> {
  const now = new Date().toISOString();
  const record = { ...data, updated_at: now };

  // Remove id if present (can't update primary key)
  delete (record as Record<string, unknown>).id;
  delete (record as Record<string, unknown>).tenant_id;
  delete (record as Record<string, unknown>).created_at;

  const columns = Object.keys(record);
  const setClause = columns.map((col) => `${col} = ?`).join(', ');
  const values = Object.values(record);

  const sql = `UPDATE ${table} SET ${setClause} WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`;
  const result = await db.prepare(sql).bind(...values, id, options.tenantId).run();

  return result.meta.changes > 0;
}

// Soft delete a record
export async function softDelete(
  db: D1Database,
  table: string,
  id: string,
  options: QueryOptions
): Promise<boolean> {
  const now = new Date().toISOString();
  const sql = `UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`;
  const result = await db.prepare(sql).bind(now, now, id, options.tenantId).run();

  return result.meta.changes > 0;
}

// Count records in a table
export async function count(
  db: D1Database,
  table: string,
  options: QueryOptions & { where?: string; whereBindings?: unknown[] }
): Promise<number> {
  let sql = `SELECT COUNT(*) as count FROM ${table} WHERE tenant_id = ?`;
  const bindings: unknown[] = [options.tenantId];

  if (!options.includeDeleted) {
    sql += ' AND deleted_at IS NULL';
  }

  if (options.where) {
    sql += ` AND ${options.where}`;
    bindings.push(...(options.whereBindings ?? []));
  }

  const result = await db.prepare(sql).bind(...bindings).first<{ count: number }>();
  return result?.count ?? 0;
}
