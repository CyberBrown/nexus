import { z } from 'zod';
import { ValidationError } from './errors.ts';

// ============================================
// Common schemas
// ============================================

const uuidSchema = z.string().uuid();

const domainSchema = z.enum(['work', 'personal', 'side_project', 'family', 'health']);

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be ISO date (YYYY-MM-DD)');

const isoTimeSchema = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Must be ISO time (HH:MM or HH:MM:SS)');

const isoDateTimeSchema = z.string().datetime({ message: 'Must be ISO 8601 datetime' });

const jsonStringSchema = z.string().optional().nullable();

// ============================================
// Task schemas
// ============================================

export const createTaskSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500),
  description: z.string().max(10000).optional().nullable(),
  parent_task_id: uuidSchema.optional().nullable(),
  project_id: uuidSchema.optional().nullable(),
  domain: domainSchema.optional().default('personal'),
  area: z.string().max(100).optional().nullable(),
  contexts: jsonStringSchema,
  tags: jsonStringSchema,
  due_date: isoDateSchema.optional().nullable(),
  due_time: isoTimeSchema.optional().nullable(),
  start_date: isoDateSchema.optional().nullable(),
  time_estimate_minutes: z.number().int().positive().max(10080).optional().nullable(), // max 1 week
  recurrence_rule: z.string().max(500).optional().nullable(),
  recurrence_parent_id: uuidSchema.optional().nullable(),
  urgency: z.number().int().min(1).max(5).optional().default(3),
  importance: z.number().int().min(1).max(5).optional().default(3),
  energy_required: z.enum(['low', 'medium', 'high']).optional().default('medium'),
  status: z.enum(['inbox', 'next', 'scheduled', 'waiting', 'someday', 'completed', 'cancelled']).optional().default('inbox'),
  assigned_by_id: uuidSchema.optional().nullable(),
  assigned_by_name: z.string().max(200).optional().nullable(),
  delegated_to_id: uuidSchema.optional().nullable(),
  delegated_to_name: z.string().max(200).optional().nullable(),
  waiting_on: z.string().max(500).optional().nullable(),
  waiting_since: isoDateTimeSchema.optional().nullable(),
  source_type: z.string().max(50).optional().nullable(),
  source_inbox_item_id: uuidSchema.optional().nullable(),
  source_reference: z.string().max(500).optional().nullable(),
  calendar_event_id: z.string().max(200).optional().nullable(),
  calendar_source: z.string().max(50).optional().nullable(),
});

export const updateTaskSchema = createTaskSchema.partial().extend({
  completed_at: isoDateTimeSchema.optional().nullable(),
  actual_time_minutes: z.number().int().positive().optional().nullable(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

// ============================================
// Project schemas
// ============================================

export const createProjectSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().max(10000).optional().nullable(),
  objective: z.string().max(2000).optional().nullable(),
  domain: domainSchema.optional().default('personal'),
  area: z.string().max(100).optional().nullable(),
  tags: jsonStringSchema,
  status: z.enum(['planning', 'active', 'on_hold', 'completed', 'cancelled']).optional().default('planning'),
  health: z.enum(['on_track', 'at_risk', 'off_track']).optional().nullable(),
  target_date: isoDateSchema.optional().nullable(),
  started_at: isoDateTimeSchema.optional().nullable(),
  parent_project_id: uuidSchema.optional().nullable(),
  external_id: z.string().max(200).optional().nullable(),
  external_source: z.string().max(50).optional().nullable(),
});

export const updateProjectSchema = createProjectSchema.partial().extend({
  completed_at: isoDateTimeSchema.optional().nullable(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

// ============================================
// Inbox schemas
// ============================================

export const createInboxItemSchema = z.object({
  source_type: z.string().min(1).max(50),
  source_id: z.string().max(200).optional().nullable(),
  source_platform: z.string().max(50).optional().nullable(),
  raw_content: z.string().min(1, 'Content is required').max(50000),
  captured_at: isoDateTimeSchema.optional(),
});

export const updateInboxItemSchema = z.object({
  processed_content: z.string().max(50000).optional().nullable(),
  ai_classification: jsonStringSchema,
  confidence_score: z.number().min(0).max(1).optional().nullable(),
  status: z.enum(['pending', 'processed', 'dismissed', 'promoted']).optional(),
  promoted_to_type: z.string().max(50).optional().nullable(),
  promoted_to_id: uuidSchema.optional().nullable(),
  user_overrides: jsonStringSchema,
  processed_at: isoDateTimeSchema.optional().nullable(),
});

export type CreateInboxItemInput = z.infer<typeof createInboxItemSchema>;
export type UpdateInboxItemInput = z.infer<typeof updateInboxItemSchema>;

// ============================================
// Idea schemas
// ============================================

export const createIdeaSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500),
  description: z.string().max(10000).optional().nullable(),
  category: z.string().min(1).max(50).optional().default('random'),
  domain: domainSchema.optional().nullable(),
  tags: jsonStringSchema,
  excitement_level: z.number().int().min(1).max(5).optional().nullable(),
  feasibility: z.number().int().min(1).max(5).optional().nullable(),
  potential_impact: z.number().int().min(1).max(5).optional().nullable(),
  source_inbox_item_id: uuidSchema.optional().nullable(),
});

export const updateIdeaSchema = createIdeaSchema.partial().extend({
  last_reviewed_at: isoDateTimeSchema.optional().nullable(),
  next_review_at: isoDateTimeSchema.optional().nullable(),
  promoted_to_project_id: uuidSchema.optional().nullable(),
  archived_at: isoDateTimeSchema.optional().nullable(),
  archive_reason: z.string().max(500).optional().nullable(),
});

export type CreateIdeaInput = z.infer<typeof createIdeaSchema>;
export type UpdateIdeaInput = z.infer<typeof updateIdeaSchema>;

// ============================================
// Person schemas
// ============================================

export const createPersonSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  email: z.string().email('Invalid email').max(200).optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  relationship: z.string().max(100).optional().nullable(),
  organization: z.string().max(200).optional().nullable(),
  role: z.string().max(100).optional().nullable(),
  preferred_contact: z.enum(['email', 'phone', 'text', 'other']).optional().nullable(),
  google_contact_id: z.string().max(200).optional().nullable(),
  notes: z.string().max(10000).optional().nullable(),
});

export const updatePersonSchema = createPersonSchema.partial();

export type CreatePersonInput = z.infer<typeof createPersonSchema>;
export type UpdatePersonInput = z.infer<typeof updatePersonSchema>;

// ============================================
// Commitment schemas
// ============================================

export const createCommitmentSchema = z.object({
  direction: z.enum(['waiting_for', 'owed_to']),
  person_id: uuidSchema.optional().nullable(),
  person_name: z.string().max(200).optional().nullable(),
  description: z.string().min(1, 'Description is required').max(2000),
  context_type: z.string().max(50).optional().nullable(),
  context_reference: z.string().max(500).optional().nullable(),
  requested_at: isoDateTimeSchema.optional(),
  due_date: isoDateSchema.optional().nullable(),
  task_id: uuidSchema.optional().nullable(),
});

export const updateCommitmentSchema = createCommitmentSchema.partial().extend({
  reminded_at: isoDateTimeSchema.optional().nullable(),
  status: z.enum(['open', 'fulfilled', 'cancelled']).optional(),
  fulfilled_at: isoDateTimeSchema.optional().nullable(),
});

export type CreateCommitmentInput = z.infer<typeof createCommitmentSchema>;
export type UpdateCommitmentInput = z.infer<typeof updateCommitmentSchema>;

// ============================================
// Capture schemas (for InboxManager DO)
// ============================================

export const captureInputSchema = z.object({
  content: z.string().min(1).max(50000),
  source_type: z.string().min(1).max(50).optional().default('manual'),
  source_platform: z.string().max(50).optional().nullable(),
  source_id: z.string().max(200).optional().nullable(),
});

export const batchCaptureInputSchema = z.object({
  inputs: z.array(captureInputSchema).min(1).max(100),
});

export type CaptureInput = z.infer<typeof captureInputSchema>;
export type BatchCaptureInput = z.infer<typeof batchCaptureInputSchema>;

// ============================================
// SyncManager schemas
// ============================================

export const deviceInfoSchema = z.object({
  device_id: z.string().uuid().optional(),
  device_name: z.string().min(1).max(200),
  platform: z.string().min(1).max(100),
  device_type: z.enum(['mobile', 'desktop', 'web', 'tablet']).optional(),
  last_sequence: z.number().int().min(0).optional().default(0),
});

export const changeLogEntrySchema = z.object({
  entity_type: z.enum(['task', 'project', 'inbox_item', 'idea', 'person', 'commitment']),
  entity_id: uuidSchema,
  operation: z.enum(['create', 'update', 'delete']),
  changes: z.record(z.string(), z.unknown()),
  device_id: z.string().uuid(),
  user_id: uuidSchema,
});

export const syncPushRequestSchema = z.object({
  device_id: z.string().uuid(),
  device_name: z.string().min(1).max(200),
  platform: z.string().min(1).max(100),
  last_sequence: z.number().int().min(0),
  changes: z.array(changeLogEntrySchema).min(1).max(1000),
});

export const syncPullRequestSchema = z.object({
  device_id: z.string().uuid(),
  since_sequence: z.number().int().min(0),
});

export const registerDeviceSchema = z.object({
  tenant_id: uuidSchema,
  user_id: uuidSchema,
  device_id: z.string().uuid().optional(),
  device_name: z.string().min(1).max(200),
  device_type: z.enum(['mobile', 'desktop', 'web', 'tablet']),
  platform: z.string().min(1).max(100),
});

export const syncChangesSchema = z.object({
  tenant_id: uuidSchema,
  user_id: uuidSchema,
  device_id: z.string().uuid(),
  changes: z.array(changeLogEntrySchema).min(1).max(1000),
});

export type DeviceInfoInput = z.infer<typeof deviceInfoSchema>;
export type ChangeLogEntryInput = z.infer<typeof changeLogEntrySchema>;
export type SyncPushRequestInput = z.infer<typeof syncPushRequestSchema>;
export type SyncPullRequestInput = z.infer<typeof syncPullRequestSchema>;
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;
export type SyncChangesInput = z.infer<typeof syncChangesSchema>;

// ============================================
// UserSession schemas (for session lifecycle)
// ============================================

export const createAuthSessionSchema = z.object({
  tenant_id: uuidSchema,
  user_id: uuidSchema,
  device_id: uuidSchema,
  ttl_seconds: z.number().int().positive().max(30 * 24 * 60 * 60).optional(), // max 30 days
});

export const refreshAuthSessionSchema = z.object({
  session_id: uuidSchema,
  extend_ttl: z.boolean().optional().default(true),
  ttl_seconds: z.number().int().positive().max(30 * 24 * 60 * 60).optional(),
});

export const revokeAuthSessionSchema = z.object({
  session_id: uuidSchema,
});

export const revokeAllAuthSessionsSchema = z.object({
  except_session_id: uuidSchema.optional(),
});

export type CreateAuthSessionInput = z.infer<typeof createAuthSessionSchema>;
export type RefreshAuthSessionInput = z.infer<typeof refreshAuthSessionSchema>;
export type RevokeAuthSessionInput = z.infer<typeof revokeAuthSessionSchema>;
export type RevokeAllAuthSessionsInput = z.infer<typeof revokeAllAuthSessionsSchema>;

// ============================================
// CaptureBuffer schemas
// ============================================

export const bufferChunkSchema = z.object({
  tenant_id: uuidSchema,
  user_id: uuidSchema,
  content: z.string().min(1).max(50000),
  source_type: z.enum(['voice', 'text']).default('voice'),
  source_platform: z.string().max(50).optional().nullable(),
  source_id: z.string().max(200).optional().nullable(),
  is_final: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const bufferConfigSchema = z.object({
  maxChunks: z.number().int().min(1).max(1000).optional(),
  maxAgeMs: z.number().int().min(100).max(60000).optional(),
  mergeWindowMs: z.number().int().min(0).max(10000).optional(),
});

export type BufferChunkInput = z.infer<typeof bufferChunkSchema>;
export type BufferConfigInput = z.infer<typeof bufferConfigSchema>;

// ============================================
// Note schemas
// ============================================

const noteCategorySchema = z.enum(['general', 'meeting', 'research', 'reference', 'idea', 'log']);

export const createNoteSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500),
  content: z.string().max(100000).optional().nullable(),
  category: noteCategorySchema.optional().default('general'),
  tags: jsonStringSchema,
  source_type: z.string().max(100).optional().nullable(),
  source_reference: z.string().max(500).optional().nullable(),
  source_context: z.string().max(5000).optional().nullable(),
  pinned: z.boolean().optional().default(false),
});

export const updateNoteSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().max(100000).optional().nullable(),
  category: noteCategorySchema.optional(),
  tags: jsonStringSchema,
  source_type: z.string().max(100).optional().nullable(),
  source_reference: z.string().max(500).optional().nullable(),
  source_context: z.string().max(5000).optional().nullable(),
  pinned: z.boolean().optional(),
  archived_at: isoDateTimeSchema.optional().nullable(),
});

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;

// ============================================
// Task Completion Validation
// ============================================

/**
 * Failure indicators that suggest the AI reported success but didn't actually complete the task.
 * These phrases in the output indicate the AI couldn't find resources, files, or complete the work.
 *
 * IMPORTANT: These are checked case-insensitively against the full output.
 * Add new patterns when you see tasks marked complete without actual work.
 *
 * THIS IS THE CANONICAL SOURCE - other files import from here:
 * - TaskExecutorWorkflow.ts (imports this)
 * - DE's nexus-callback.ts (MUST be manually synced)
 *
 * Used by:
 * - nexus_complete_task MCP tool
 * - /workflow-callback endpoint
 * - /api/tasks/:id/complete endpoint
 * - TaskExecutorWorkflow containsFailureIndicators()
 *
 * Last synced with DE: 2024-12-30
 */
export const FAILURE_INDICATORS = [
  // Resource not found patterns
  "couldn't find", "could not find", "can't find", "cannot find",
  "doesn't have", "does not have", "not found", "no such file",
  "doesn't exist", "does not exist", "file not found", "directory not found",
  "repo not found", "repository not found", "project not found",
  "reference not found", "idea not found",
  // Failure action patterns
  "failed to", "unable to", "i can't", "i cannot",
  "i'm unable", "i am unable", "cannot locate", "couldn't locate",
  "couldn't create", "could not create", "wasn't able", "was not able",
  // Empty/missing result patterns
  "no matching", "nothing found", "no results", "empty result", "no data",
  // Explicit error indicators
  "error:", "error occurred", "exception:",
  // Task incomplete patterns
  "task incomplete", "could not complete", "couldn't complete",
  "unable to complete", "did not complete", "didn't complete",
  // Missing reference patterns (for idea-based tasks)
  "reference doesn't have", "reference does not have",
  "doesn't have a corresponding", "does not have a corresponding",
  "no corresponding file", "no corresponding project",
  "missing reference", "invalid reference",
  // Additional patterns for edge cases (synced from DE nexus-callback.ts 2024-12)
  "i can find", // catches "file I can find" negation patterns
  "no repo", "no repository", "no project",
  "couldn't access", "could not access", "can't access", "cannot access",
  "no idea file", "idea file not", "idea reference not",
  "there is no", "there are no", "there isn't", "there aren't",
  "without a", "missing a", "lack of", "lacking",
  "haven't been created", "hasn't been created", "has not been created",
  "wasn't created", "were not created", "weren't created",
  "no github", "no cloudflare", "no d1", "no worker",
  "the task cannot", "the task could not", "this task cannot",
  // Additional patterns added 2024-12-30 after investigating false completions
  "idea reference doesn't", "idea reference does not",
  "file i can find", // catches "...a corresponding file I can find"
  "no repo was created", "no repository was created",
  "no worker deployed", "no database created",
  "completion result says", // meta-pattern for reflection about failed execution
  // Additional patterns added 2024-12-30 to catch more edge cases
  "haven't found", "have not found", "hasn't found", "has not found",
  "haven't set up", "have not set up", "hasn't set up", "has not set up",
  "setup yet", "not initialized", "not been initialized",
  "no setup", "no configuration", "not configured",
  "doesn't appear", "does not appear", "didn't find", "did not find",
  "looked for", // often followed by "but" in failure messages
  "searched for", // often followed by "but" in failure messages
  "need to create", "needs to be created", "must be created",
  "should be created", "would need to", "will need to",
  "before i can", "before we can", "in order to",
  "prerequisite", "prerequisites", "first need",
  "no code", "no files", "no implementation",
  "empty repo", "empty repository", "blank project",
  "scaffold", "scaffolding", "boilerplate",
  "set up the project", "set up the repo", "create the project",
  "initialize the project", "initialize the repo",
  "project structure", "folder structure", "directory structure",
  "does not have any", "doesn't have any", "don't have any",
  "nothing has been", "nothing was", "nothing is",
  // Additional patterns added 2024-12-30 after further investigation
  "no action taken", "no changes made", "nothing to do",
  "can not proceed", "cannot proceed", "couldn't proceed", "could not proceed",
  "doesn't point to", "does not point to", "not pointing to",
  "no valid", "invalid path", "path does not exist",
  "no work done", "no work performed", "no work completed",
  "unable to locate", "unable to access", "unable to read",
  "nothing to commit", "nothing to deploy", "nothing to execute",
  "empty project", "empty directory", "empty folder",
  "does not contain", "doesn't contain", "not containing",
  "outside of", "not within", "not part of",
  "requires setup", "requires configuration", "requires initialization",
  "not yet implemented", "not implemented", "to be implemented",
  "placeholder", "stub", "todo:",
] as const;

/**
 * Normalize text for comparison by replacing curly quotes with straight quotes.
 * This handles cases where AI outputs use typographic quotes instead of standard ASCII.
 *
 * Unicode ranges covered:
 * - \u2018, \u2019, \u201A, \u201B: Single curly quotes (', ', ‚, ‛)
 * - \u201C, \u201D, \u201E, \u201F: Double curly quotes (", ", „, ‟)
 */
export function normalizeQuotes(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")  // Single curly quotes → '
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"'); // Double curly quotes → "
}

/**
 * Check if text contains failure indicators suggesting the task wasn't actually completed.
 * Returns the matched indicator for logging, or null if no match.
 *
 * @param text - The text to check (notes, output, result, etc.)
 * @returns The matched failure indicator, or null if none found
 */
export function findFailureIndicator(text: string | undefined | null): string | null {
  if (!text) return null;
  const normalized = normalizeQuotes(text.toLowerCase());
  for (const indicator of FAILURE_INDICATORS) {
    if (normalized.includes(indicator)) {
      return indicator;
    }
  }
  return null;
}

/**
 * Check if text contains failure indicators (boolean version).
 */
export function containsFailureIndicators(text: string | undefined | null): boolean {
  return findFailureIndicator(text) !== null;
}

// ============================================
// Validation helper
// ============================================

export function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);

  if (!result.success) {
    // Zod 4.x uses 'issues', Zod 3.x uses 'errors'
    const issues = result.error.issues ?? (result.error as unknown as { errors: typeof result.error.issues }).errors ?? [];
    const details = issues.map((err) => ({
      field: err.path.join('.'),
      message: err.message,
    }));
    throw new ValidationError('Validation failed', details);
  }

  return result.data;
}
