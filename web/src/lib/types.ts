/**
 * Core TypeScript interfaces for Nexus
 * Matches backend API types
 */

export interface Task {
  id: string;
  tenant_id: string;
  user_id: string;
  project_id?: string;
  title: string; // encrypted
  description?: string; // encrypted
  status: 'todo' | 'in_progress' | 'done' | 'blocked' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  due_date?: string;
  completed_at?: string;
  tags?: string[];
  energy_level?: 'low' | 'medium' | 'high';
  time_estimate_minutes?: number;
  context?: string;
  parent_task_id?: string;
  sort_order?: number;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

export interface Project {
  id: string;
  tenant_id: string;
  user_id: string;
  name: string; // encrypted
  description?: string; // encrypted
  status: 'active' | 'on_hold' | 'completed' | 'archived';
  objective?: string; // encrypted
  start_date?: string;
  target_date?: string;
  completed_at?: string;
  tags?: string[];
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

export interface InboxItem {
  id: string;
  tenant_id: string;
  user_id: string;
  raw_content: string; // encrypted
  processed_content?: string; // encrypted
  source: 'voice' | 'text' | 'email' | 'api' | 'web' | 'android';
  classification?: string;
  confidence?: number;
  processed: boolean;
  processed_at?: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

export interface Idea {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string; // encrypted
  description?: string; // encrypted
  category?: string;
  domain?: string;
  tags?: string[];
  execution_status?: 'new' | 'planned' | 'executing' | 'done' | 'blocked';
  effort_estimate?: 'xs' | 's' | 'm' | 'l' | 'xl';
  energy_type?: 'creative' | 'analytical' | 'maintenance';
  priority_score?: number;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

export interface IdeaTask {
  id: string;
  idea_id: string;
  title: string;
  description?: string;
  agent_type: 'claude' | 'local' | 'human';
  estimated_effort?: 'xs' | 's' | 'm' | 'l' | 'xl';
  sequence_order: number;
  status: 'pending' | 'ready' | 'in_progress' | 'completed' | 'failed' | 'blocked';
  started_at?: string;
  completed_at?: string;
  result?: any;
  error_message?: string;
}

export interface IdeaExecution {
  id: string;
  idea_id: string;
  workflow_instance_id?: string;
  status: 'pending' | 'planning' | 'planned' | 'executing' | 'completed' | 'failed' | 'blocked';
  total_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  started_at?: string;
  planned_at?: string;
  completed_at?: string;
}

export interface IdeaStatus {
  idea: {
    id: string;
    title: string;
    description?: string;
    execution_status?: string;
    category?: string;
    domain?: string;
  };
  execution?: IdeaExecution;
  tasks: IdeaTask[];
  stats: {
    total: number;
    completed: number;
    failed: number;
    blocked: number;
    completion_pct: number;
  };
  blockers: Array<{
    task_id: string;
    title: string;
    agent_type: string;
  }>;
}

export interface IdeaListItem {
  id: string;
  title: string;
  description?: string;
  category?: string;
  domain?: string;
  execution_status: string;
  exec_status?: string;
  total_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  created_at: string;
}

export interface Person {
  id: string;
  tenant_id: string;
  user_id: string;
  name: string; // encrypted
  email?: string; // encrypted
  phone?: string; // encrypted
  notes?: string; // encrypted
  tags?: string[];
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

export interface Commitment {
  id: string;
  tenant_id: string;
  user_id: string;
  person_id?: string;
  type: 'waiting_for' | 'owed_to';
  description: string; // encrypted
  due_date?: string;
  status: 'pending' | 'fulfilled' | 'cancelled';
  fulfilled_at?: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

// API Response types
export interface ApiResponse<T> {
  data: T;
  meta?: {
    timestamp: string;
    requestId?: string;
  };
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: any;
  };
  meta?: {
    timestamp: string;
    requestId?: string;
  };
}

// Request types
export interface CreateTaskInput {
  project_id?: string;
  title: string;
  description?: string;
  status?: Task['status'];
  priority?: Task['priority'];
  due_date?: string;
  tags?: string[];
  energy_level?: Task['energy_level'];
  time_estimate_minutes?: number;
  context?: string;
  parent_task_id?: string;
}

export interface UpdateTaskInput {
  project_id?: string;
  title?: string;
  description?: string;
  status?: Task['status'];
  priority?: Task['priority'];
  due_date?: string;
  completed_at?: string;
  tags?: string[];
  energy_level?: Task['energy_level'];
  time_estimate_minutes?: number;
  context?: string;
  parent_task_id?: string;
  sort_order?: number;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  status?: Project['status'];
  objective?: string;
  start_date?: string;
  target_date?: string;
  tags?: string[];
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  status?: Project['status'];
  objective?: string;
  start_date?: string;
  target_date?: string;
  completed_at?: string;
  tags?: string[];
}

export interface CaptureInput {
  content: string;
  source?: InboxItem['source'];
}

export interface CreateIdeaInput {
  title: string;
  description?: string;
  category?: string;
  tags?: string[];
}

export interface CreatePersonInput {
  name: string;
  email?: string;
  phone?: string;
  notes?: string;
  tags?: string[];
}

export interface CreateCommitmentInput {
  person_id?: string;
  type: Commitment['type'];
  description: string;
  due_date?: string;
  status?: Commitment['status'];
}
