/**
 * Type-safe API client for Nexus backend
 * Handles authentication, error handling, and type conversion
 */

import type {
  Task,
  Project,
  InboxItem,
  Idea,
  Person,
  Commitment,
  ApiResponse,
  ApiError,
  CreateTaskInput,
  UpdateTaskInput,
  CreateProjectInput,
  UpdateProjectInput,
  CaptureInput,
  CreateIdeaInput,
  CreatePersonInput,
  CreateCommitmentInput,
} from './types';

export class ApiClientError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
    public details?: any
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: any;
  headers?: Record<string, string>;
}

export class ApiClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string = '/api') {
    this.baseUrl = baseUrl;

    // Try to load token from localStorage
    if (typeof window !== 'undefined') {
      this.token = localStorage.getItem('nexus_token');
    }
  }

  setToken(token: string) {
    this.token = token;
    if (typeof window !== 'undefined') {
      localStorage.setItem('nexus_token', token);
    }
  }

  clearToken() {
    this.token = null;
    if (typeof window !== 'undefined') {
      localStorage.removeItem('nexus_token');
    }
  }

  private async request<T>(
    endpoint: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const { method = 'GET', body, headers = {} } = options;

    const url = `${this.baseUrl}${endpoint}`;

    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...headers,
    };

    if (this.token) {
      requestHeaders['Authorization'] = `Bearer ${this.token}`;
    }

    try {
      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const errorData: ApiError = await response.json().catch(() => ({
          error: {
            code: 'UNKNOWN_ERROR',
            message: 'An unexpected error occurred',
          },
        }));

        throw new ApiClientError(
          errorData.error.message,
          errorData.error.code,
          response.status,
          errorData.error.details
        );
      }

      // Handle 204 No Content
      if (response.status === 204) {
        return null as T;
      }

      const data = await response.json();
      return data;
    } catch (error) {
      if (error instanceof ApiClientError) {
        throw error;
      }

      // Network error or other unexpected error
      throw new ApiClientError(
        'Network error or server unavailable',
        'NETWORK_ERROR',
        0
      );
    }
  }

  // Tasks API
  async getTasks(): Promise<Task[]> {
    const response = await this.request<ApiResponse<Task[]>>('/tasks');
    return response.data;
  }

  async getTask(id: string): Promise<Task> {
    const response = await this.request<ApiResponse<Task>>(`/tasks/${id}`);
    return response.data;
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const response = await this.request<ApiResponse<Task>>('/tasks', {
      method: 'POST',
      body: input,
    });
    return response.data;
  }

  async updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
    const response = await this.request<ApiResponse<Task>>(`/tasks/${id}`, {
      method: 'PATCH',
      body: input,
    });
    return response.data;
  }

  async deleteTask(id: string): Promise<void> {
    await this.request<void>(`/tasks/${id}`, {
      method: 'DELETE',
    });
  }

  // Projects API
  async getProjects(): Promise<Project[]> {
    const response = await this.request<ApiResponse<Project[]>>('/projects');
    return response.data;
  }

  async getProject(id: string): Promise<Project> {
    const response = await this.request<ApiResponse<Project>>(
      `/projects/${id}`
    );
    return response.data;
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    const response = await this.request<ApiResponse<Project>>('/projects', {
      method: 'POST',
      body: input,
    });
    return response.data;
  }

  async updateProject(id: string, input: UpdateProjectInput): Promise<Project> {
    const response = await this.request<ApiResponse<Project>>(
      `/projects/${id}`,
      {
        method: 'PATCH',
        body: input,
      }
    );
    return response.data;
  }

  async deleteProject(id: string): Promise<void> {
    await this.request<void>(`/projects/${id}`, {
      method: 'DELETE',
    });
  }

  // Inbox API
  async getInbox(): Promise<InboxItem[]> {
    const response = await this.request<ApiResponse<InboxItem[]>>('/inbox');
    return response.data;
  }

  async getInboxItem(id: string): Promise<InboxItem> {
    const response = await this.request<ApiResponse<InboxItem>>(
      `/inbox/${id}`
    );
    return response.data;
  }

  async createInboxItem(input: Partial<InboxItem>): Promise<InboxItem> {
    const response = await this.request<ApiResponse<InboxItem>>('/inbox', {
      method: 'POST',
      body: input,
    });
    return response.data;
  }

  async updateInboxItem(
    id: string,
    input: Partial<InboxItem>
  ): Promise<InboxItem> {
    const response = await this.request<ApiResponse<InboxItem>>(
      `/inbox/${id}`,
      {
        method: 'PATCH',
        body: input,
      }
    );
    return response.data;
  }

  async deleteInboxItem(id: string): Promise<void> {
    await this.request<void>(`/inbox/${id}`, {
      method: 'DELETE',
    });
  }

  // Capture API
  async capture(input: CaptureInput): Promise<InboxItem> {
    const response = await this.request<ApiResponse<InboxItem>>('/capture', {
      method: 'POST',
      body: input,
    });
    return response.data;
  }

  async batchCapture(inputs: CaptureInput[]): Promise<InboxItem[]> {
    const response = await this.request<ApiResponse<InboxItem[]>>(
      '/capture/batch',
      {
        method: 'POST',
        body: { items: inputs },
      }
    );
    return response.data;
  }

  // Ideas API
  async getIdeas(): Promise<Idea[]> {
    const response = await this.request<ApiResponse<Idea[]>>('/ideas');
    return response.data;
  }

  async getIdea(id: string): Promise<Idea> {
    const response = await this.request<ApiResponse<Idea>>(`/ideas/${id}`);
    return response.data;
  }

  async createIdea(input: CreateIdeaInput): Promise<Idea> {
    const response = await this.request<ApiResponse<Idea>>('/ideas', {
      method: 'POST',
      body: input,
    });
    return response.data;
  }

  async updateIdea(id: string, input: Partial<CreateIdeaInput>): Promise<Idea> {
    const response = await this.request<ApiResponse<Idea>>(`/ideas/${id}`, {
      method: 'PATCH',
      body: input,
    });
    return response.data;
  }

  async deleteIdea(id: string): Promise<void> {
    await this.request<void>(`/ideas/${id}`, {
      method: 'DELETE',
    });
  }

  // People API
  async getPeople(): Promise<Person[]> {
    const response = await this.request<ApiResponse<Person[]>>('/people');
    return response.data;
  }

  async getPerson(id: string): Promise<Person> {
    const response = await this.request<ApiResponse<Person>>(`/people/${id}`);
    return response.data;
  }

  async createPerson(input: CreatePersonInput): Promise<Person> {
    const response = await this.request<ApiResponse<Person>>('/people', {
      method: 'POST',
      body: input,
    });
    return response.data;
  }

  async updatePerson(
    id: string,
    input: Partial<CreatePersonInput>
  ): Promise<Person> {
    const response = await this.request<ApiResponse<Person>>(`/people/${id}`, {
      method: 'PATCH',
      body: input,
    });
    return response.data;
  }

  async deletePerson(id: string): Promise<void> {
    await this.request<void>(`/people/${id}`, {
      method: 'DELETE',
    });
  }

  // Commitments API
  async getCommitments(): Promise<Commitment[]> {
    const response =
      await this.request<ApiResponse<Commitment[]>>('/commitments');
    return response.data;
  }

  async getCommitment(id: string): Promise<Commitment> {
    const response = await this.request<ApiResponse<Commitment>>(
      `/commitments/${id}`
    );
    return response.data;
  }

  async createCommitment(input: CreateCommitmentInput): Promise<Commitment> {
    const response = await this.request<ApiResponse<Commitment>>(
      '/commitments',
      {
        method: 'POST',
        body: input,
      }
    );
    return response.data;
  }

  async updateCommitment(
    id: string,
    input: Partial<CreateCommitmentInput>
  ): Promise<Commitment> {
    const response = await this.request<ApiResponse<Commitment>>(
      `/commitments/${id}`,
      {
        method: 'PATCH',
        body: input,
      }
    );
    return response.data;
  }

  async deleteCommitment(id: string): Promise<void> {
    await this.request<void>(`/commitments/${id}`, {
      method: 'DELETE',
    });
  }

  // Auth API
  async getMe(): Promise<{ user: any; tenant: any }> {
    const response = await this.request<ApiResponse<{ user: any; tenant: any }>>(
      '/auth/me'
    );
    return response.data;
  }

  // WebSocket for real-time updates
  createWebSocket(): WebSocket | null {
    if (typeof window === 'undefined') return null;

    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/capture/ws';
    const ws = new WebSocket(wsUrl);

    return ws;
  }
}

// Singleton instance
export const apiClient = new ApiClient();
