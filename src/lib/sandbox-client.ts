/**
 * Sandbox Executor Client
 *
 * Connects Nexus to the sandbox-executor service for task execution.
 * Routes tasks to appropriate execution paths:
 * - /execute/sdk - Fast path for simple AI tasks (claude-ai)
 * - /execute - Container path for code tasks (claude-code)
 */

// ========================================
// Types
// ========================================

export interface SdkExecuteRequest {
  prompt: string;
  max_tokens?: number;
  temperature?: number;
}

export interface SdkExecuteResponse {
  success: boolean;
  result?: string;
  error?: string;
  tokens_used?: number;
  model?: string;
}

export interface ContainerExecuteRequest {
  task: string;
  repo?: string;
  branch?: string;
  timeout_seconds?: number;
}

export interface ContainerExecuteResponse {
  success: boolean;
  logs?: string;
  error?: string;
  exit_code?: number;
  duration_ms?: number;
}

// Health response can vary between sandbox-executor versions
// Some return sdk_available/container_available, others just return service/timestamp
export interface SandboxHealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  sdk_available?: boolean;
  container_available?: boolean;
  service?: string;
  timestamp?: string;
  version?: string;
}

// ========================================
// Client
// ========================================

export class SandboxClient {
  private baseUrl: string;
  private authToken?: string;
  private serviceBinding?: Fetcher; // Cloudflare Service Binding (preferred)

  constructor(baseUrl: string, authToken?: string, serviceBinding?: Fetcher) {
    // Ensure no trailing slash
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.authToken = authToken;
    this.serviceBinding = serviceBinding;
  }

  private getHeaders(): HeadersInit {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }
    return headers;
  }

  /**
   * Make a fetch request using service binding if available, otherwise fall back to URL
   */
  private async doFetch(path: string, init?: RequestInit): Promise<Response> {
    if (this.serviceBinding) {
      // Use service binding - no base URL needed, just the path
      console.log(`Sandbox fetch via service binding: ${path}`);
      return this.serviceBinding.fetch(`https://sandbox-executor${path}`, init);
    } else {
      // Fall back to URL-based fetch
      console.log(`Sandbox fetch via URL: ${this.baseUrl}${path}`);
      return fetch(`${this.baseUrl}${path}`, init);
    }
  }

  /**
   * Execute a quick AI task via the SDK path.
   * Best for research, analysis, writing, and other non-code tasks.
   */
  async executeQuick(prompt: string, options?: { max_tokens?: number; temperature?: number }): Promise<SdkExecuteResponse> {
    const body: SdkExecuteRequest = {
      prompt,
      max_tokens: options?.max_tokens,
      temperature: options?.temperature,
    };

    const response = await this.doFetch('/execute/sdk', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      return {
        success: false,
        error: `SDK execution failed (${response.status}): ${errorText}`,
      };
    }

    return response.json() as Promise<SdkExecuteResponse>;
  }

  /**
   * Execute a code task via the container path.
   * Best for implementation, deployment, testing, and other code tasks.
   */
  async executeCode(task: string, options?: { repo?: string; branch?: string; timeout_seconds?: number }): Promise<ContainerExecuteResponse> {
    const body: ContainerExecuteRequest = {
      task,
      repo: options?.repo,
      branch: options?.branch,
      timeout_seconds: options?.timeout_seconds,
    };

    const response = await this.doFetch('/execute', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      return {
        success: false,
        error: `Container execution failed (${response.status}): ${errorText}`,
      };
    }

    return response.json() as Promise<ContainerExecuteResponse>;
  }

  /**
   * Check if the sandbox executor is healthy and available.
   */
  async healthCheck(): Promise<SandboxHealthResponse> {
    try {
      console.log(`Sandbox health check (${this.serviceBinding ? 'service binding' : 'URL'})`);
      const response = await this.doFetch('/health', {
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        console.log(`Sandbox health check failed: HTTP ${response.status}`);
        return {
          status: 'unhealthy',
        };
      }

      const data = await response.json() as SandboxHealthResponse;
      console.log(`Sandbox health check response:`, JSON.stringify(data));
      return data;
    } catch (error) {
      console.error(`Sandbox health check error:`, error);
      return {
        status: 'unhealthy',
      };
    }
  }

  /**
   * Check if the service is reachable (simple connectivity test).
   */
  async isAvailable(): Promise<boolean> {
    try {
      const health = await this.healthCheck();
      const available = health.status === 'healthy' || health.status === 'degraded';
      console.log(`Sandbox isAvailable: status=${health.status}, available=${available}`);
      return available;
    } catch (error) {
      console.error(`Sandbox isAvailable error:`, error);
      return false;
    }
  }
}

// ========================================
// Factory Functions
// ========================================

interface SandboxEnv {
  SANDBOX_EXECUTOR_URL?: string;
  SANDBOX_AUTH_TOKEN?: string;
  SANDBOX_EXECUTOR?: Fetcher; // Service binding (preferred)
}

/**
 * Create a sandbox client from environment variables.
 * Prefers service binding over URL for worker-to-worker communication.
 * Returns null if neither SANDBOX_EXECUTOR binding nor SANDBOX_EXECUTOR_URL is configured.
 */
export function createSandboxClient(env: SandboxEnv): SandboxClient | null {
  // Prefer service binding if available
  if (env.SANDBOX_EXECUTOR) {
    console.log('Using SANDBOX_EXECUTOR service binding');
    // URL is just a fallback/placeholder when using service binding
    return new SandboxClient(
      env.SANDBOX_EXECUTOR_URL || 'https://sandbox-executor.local',
      env.SANDBOX_AUTH_TOKEN,
      env.SANDBOX_EXECUTOR
    );
  }

  // Fall back to URL-based fetch
  if (env.SANDBOX_EXECUTOR_URL) {
    console.log('Using SANDBOX_EXECUTOR_URL (no service binding)');
    return new SandboxClient(env.SANDBOX_EXECUTOR_URL, env.SANDBOX_AUTH_TOKEN);
  }

  return null;
}

/**
 * Get sandbox client or throw if not available.
 */
export function getSandboxClient(env: SandboxEnv): SandboxClient {
  const client = createSandboxClient(env);
  if (!client) {
    throw new Error('Sandbox executor is required but neither SANDBOX_EXECUTOR nor SANDBOX_EXECUTOR_URL is configured');
  }
  return client;
}
