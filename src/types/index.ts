// Workflow binding type
interface Workflow {
  create(options?: { id?: string; params?: unknown }): Promise<WorkflowInstance>;
  get(id: string): Promise<WorkflowInstance>;
}

interface WorkflowInstance {
  id: string;
  status(): Promise<{
    status: 'queued' | 'running' | 'paused' | 'complete' | 'errored' | 'terminated' | 'waiting';
    output?: unknown;
    error?: string;
  }>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  terminate(): Promise<void>;
  restart(): Promise<void>;
  sendEvent(event: { type: string; payload?: unknown }): Promise<void>;
}

// Environment bindings
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
  INBOX_MANAGER: DurableObjectNamespace;
  CAPTURE_BUFFER: DurableObjectNamespace;
  SYNC_MANAGER: DurableObjectNamespace;
  USER_SESSION: DurableObjectNamespace;
  IDEA_EXECUTOR: DurableObjectNamespace;
  // Service Bindings
  DE: Fetcher; // DE (distributed-electrons) service for LLM operations
  SANDBOX_EXECUTOR?: Fetcher; // Sandbox executor service for task execution
  INTAKE?: Fetcher; // DE intake worker for workflow-based parallel execution
  // Self URL for workflow callbacks
  NEXUS_URL?: string;
  // DE text-gen URL (for workflows that can't use service bindings)
  TEXT_GEN_URL?: string;
  // Sandbox executor URL for task execution
  SANDBOX_EXECUTOR_URL?: string;
  SANDBOX_AUTH_TOKEN?: string;
  // DE Workflows URL for triggering CodeExecutionWorkflow via HTTP
  DE_WORKFLOWS_URL?: string;
  // Fallback Anthropic API key (for environments without DE)
  ANTHROPIC_API_KEY?: string;
  // Write passphrase for MCP destructive operations
  WRITE_PASSPHRASE?: string;
  // Primary tenant for MCP access (single-tenant mode)
  PRIMARY_TENANT_ID?: string;
  PRIMARY_USER_ID?: string;
  // Cloudflare Access
  TEAM_DOMAIN?: string; // e.g., https://your-team.cloudflareaccess.com
  POLICY_AUD?: string; // Application Audience (AUD) tag
  // Cloudflare Workflows (local workflows only)
  IDEA_EXECUTION_WORKFLOW: Workflow; // Legacy workflow binding
  IDEA_TO_PLAN_WORKFLOW: Workflow;
  TASK_EXECUTOR_WORKFLOW: Workflow;
  IDEA_PLANNING_WORKFLOW: Workflow;
  // Note: CodeExecutionWorkflow is triggered via HTTP to DE_WORKFLOWS_URL
  // Cross-worker workflow bindings are NOT supported by CF Workflows
}

// Cloudflare Scheduled Event
export interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}

// AI Classification types
export interface ClassificationResult {
  type: 'task' | 'event' | 'idea' | 'reference' | 'someday';
  domain: 'work' | 'personal' | 'side_project' | 'family' | 'health';
  title: string;
  description: string | null;
  urgency: number; // 1-5
  importance: number; // 1-5
  due_date: string | null; // ISO date
  due_time: string | null; // ISO time
  contexts: string[]; // ["@phone", "@computer", "@errands"]
  people: string[]; // names mentioned
  project_id: string | null; // matched project
  confidence_score: number; // 0-1
}

// Context variables (set by middleware)
export interface Variables {
  tenantId: string;
  userId: string;
  userEmail?: string; // Available with Cloudflare Access auth
}

// App type for Hono
export type AppType = { Bindings: Env; Variables: Variables };

// Base entity with common fields
export interface BaseEntity {
  id: string;
  tenant_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

// Tenant
export interface Tenant extends Omit<BaseEntity, 'tenant_id'> {
  name: string;
  encryption_key_ref: string;
  settings: string | null;
}

// User
export interface User extends BaseEntity {
  user_id?: string; // Some tables use user_id
  email: string;
  name: string;
  role: string;
  preferences: string | null;
  timezone: string;
}

// Inbox Item
export interface InboxItem extends BaseEntity {
  user_id: string;
  source_type: string;
  source_id: string | null;
  source_platform: string | null;
  raw_content: string; // encrypted
  processed_content: string | null; // encrypted
  ai_classification: string | null;
  confidence_score: number | null;
  status: 'pending' | 'processed' | 'dismissed' | 'promoted';
  promoted_to_type: string | null;
  promoted_to_id: string | null;
  user_overrides: string | null;
  captured_at: string;
  processed_at: string | null;
}

// Task
export interface Task extends BaseEntity {
  user_id: string;
  title: string; // encrypted
  description: string | null; // encrypted
  parent_task_id: string | null;
  project_id: string | null;
  domain: string;
  area: string | null;
  contexts: string | null;
  tags: string | null;
  due_date: string | null;
  due_time: string | null;
  start_date: string | null;
  completed_at: string | null;
  time_estimate_minutes: number | null;
  actual_time_minutes: number | null;
  recurrence_rule: string | null;
  recurrence_parent_id: string | null;
  urgency: number;
  importance: number;
  energy_required: 'low' | 'medium' | 'high';
  status: 'inbox' | 'next' | 'scheduled' | 'waiting' | 'someday' | 'completed' | 'cancelled';
  assigned_by_id: string | null;
  assigned_by_name: string | null;
  delegated_to_id: string | null;
  delegated_to_name: string | null;
  waiting_on: string | null;
  waiting_since: string | null;
  source_type: string | null;
  source_inbox_item_id: string | null;
  source_reference: string | null;
  calendar_event_id: string | null;
  calendar_source: string | null;
}

// Project
export interface Project extends BaseEntity {
  user_id: string;
  name: string; // encrypted
  description: string | null; // encrypted
  objective: string | null; // encrypted
  domain: string;
  area: string | null;
  tags: string | null;
  status: 'planning' | 'active' | 'on_hold' | 'completed' | 'cancelled';
  health: 'on_track' | 'at_risk' | 'off_track' | null;
  target_date: string | null;
  started_at: string | null;
  completed_at: string | null;
  parent_project_id: string | null;
  external_id: string | null;
  external_source: string | null;
}

// Idea
export interface Idea extends BaseEntity {
  user_id: string;
  title: string; // encrypted
  description: string | null; // encrypted
  category: string;
  domain: string | null;
  tags: string | null;
  excitement_level: number | null;
  feasibility: number | null;
  potential_impact: number | null;
  last_reviewed_at: string | null;
  next_review_at: string | null;
  review_count: number;
  promoted_to_project_id: string | null;
  archived_at: string | null;
  archive_reason: string | null;
  source_inbox_item_id: string | null;
  // Execution loop fields
  execution_status: 'new' | 'planned' | 'executing' | 'done' | 'blocked' | null;
  effort_estimate: 'xs' | 's' | 'm' | 'l' | 'xl' | null;
  energy_type: 'creative' | 'analytical' | 'maintenance' | null;
  dependencies: string | null; // JSON array
  priority_score: number | null;
}

// IdeaTask - Tasks generated from ideas
export interface IdeaTask extends BaseEntity {
  user_id: string;
  idea_id: string;
  title: string; // encrypted
  description: string | null; // encrypted
  agent_type: 'ai' | 'human' | 'human-ai';
  estimated_effort: 'xs' | 's' | 'm' | 'l' | 'xl' | null;
  sequence_order: number;
  status: 'pending' | 'ready' | 'in_progress' | 'completed' | 'failed' | 'blocked';
  started_at: string | null;
  completed_at: string | null;
  result: string | null; // encrypted JSON
  error_message: string | null;
  retry_count: number;
  max_retries: number;
  // Code execution fields (for sandbox-executor)
  repo: string | null; // e.g., "CyberBrown/distributed-electrons"
  branch: string | null; // e.g., "feature/my-feature"
  commit_message: string | null;
}

// IdeaExecution - Workflow run tracking
export interface IdeaExecution extends Omit<BaseEntity, 'deleted_at'> {
  user_id: string;
  idea_id: string;
  workflow_instance_id: string | null;
  status: 'pending' | 'planning' | 'planned' | 'executing' | 'completed' | 'failed' | 'blocked';
  total_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  blockers: string | null; // JSON array
  started_at: string | null;
  planned_at: string | null;
  completed_at: string | null;
  error_message: string | null;
}

// Person
export interface Person extends BaseEntity {
  user_id: string;
  name: string; // encrypted
  email: string | null; // encrypted
  phone: string | null; // encrypted
  relationship: string | null;
  organization: string | null;
  role: string | null;
  preferred_contact: string | null;
  google_contact_id: string | null;
  notes: string | null; // encrypted
}

// Commitment
export interface Commitment extends BaseEntity {
  user_id: string;
  direction: 'waiting_for' | 'owed_to';
  person_id: string | null;
  person_name: string | null;
  description: string; // encrypted
  context_type: string | null;
  context_reference: string | null;
  requested_at: string;
  due_date: string | null;
  reminded_at: string | null;
  reminder_count: number;
  status: 'open' | 'fulfilled' | 'cancelled';
  fulfilled_at: string | null;
  task_id: string | null;
}

// Note - persistent note storage
export interface Note extends BaseEntity {
  user_id: string;
  title: string; // encrypted
  content: string | null; // encrypted
  category: 'general' | 'meeting' | 'research' | 'reference' | 'idea' | 'log';
  tags: string | null; // JSON array
  source_type: string | null; // claude_conversation, idea_execution, task, manual, capture
  source_reference: string | null;
  source_context: string | null;
  pinned: number; // 0 or 1
  archived_at: string | null;
}

// Task Dependency - blocking relationship between tasks
export interface TaskDependency {
  id: string;
  tenant_id: string;
  task_id: string; // The task that is blocked
  depends_on_task_id: string; // The task that must complete first
  dependency_type: 'blocks' | 'suggests' | 'related';
  created_at: string;
}

// API response types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface ListResponse<T> {
  success: boolean;
  data: T[];
  total?: number;
}

// Create/Update DTOs
export type CreateTaskInput = Omit<Task, 'id' | 'tenant_id' | 'created_at' | 'updated_at' | 'deleted_at'>;
export type UpdateTaskInput = Partial<CreateTaskInput>;

export type CreateProjectInput = Omit<Project, 'id' | 'tenant_id' | 'created_at' | 'updated_at' | 'deleted_at'>;
export type UpdateProjectInput = Partial<CreateProjectInput>;

export type CreateInboxItemInput = Omit<InboxItem, 'id' | 'tenant_id' | 'created_at' | 'updated_at' | 'deleted_at'>;
export type UpdateInboxItemInput = Partial<CreateInboxItemInput>;

// SyncManager types
export interface DeviceInfo {
  device_id: string;
  device_name: string;
  platform: string;
  last_sync: string;
  last_sequence: number;
  connected: boolean;
}

export interface ChangeLogEntry {
  sequence: number;
  timestamp: string;
  device_id: string;
  entity_type: 'task' | 'project' | 'inbox_item' | 'idea' | 'person' | 'commitment';
  entity_id: string;
  operation: 'create' | 'update' | 'delete';
  changes: Record<string, unknown>;
  user_id: string;
}

export interface SyncPushRequest {
  device_id: string;
  device_name: string;
  platform: string;
  last_sequence: number;
  changes: Omit<ChangeLogEntry, 'sequence' | 'timestamp'>[];
}

export interface SyncPullRequest {
  device_id: string;
  since_sequence: number;
}

export interface ConflictInfo {
  entity_type: string;
  entity_id: string;
  conflicting_changes: ChangeLogEntry[];
  resolution: 'last_write_wins' | 'manual_required';
  winning_change?: ChangeLogEntry;
}
