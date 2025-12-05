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
