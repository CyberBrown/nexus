/**
 * Sandbox Executor Client
 *
 * Connects Nexus to the sandbox-executor service for task execution.
 * All task types route through /execute endpoint which uses OAuth credentials.
 * - /execute - Main execution path for all tasks (uses OAuth credentials)
 * - /execute/sdk - Legacy SDK path (deprecated, not used - would consume API credits)
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
    const startTime = Date.now();
    try {
      if (this.serviceBinding) {
        // Use service binding - no base URL needed, just the path
        const url = `https://sandbox-executor${path}`;
        console.log(`Sandbox fetch via service binding: ${url}`);
        const response = await this.serviceBinding.fetch(url, init);
        const elapsed = Date.now() - startTime;
        console.log(`Sandbox response: ${response.status} (${elapsed}ms)`);
        return response;
      } else {
        // Fall back to URL-based fetch
        const url = `${this.baseUrl}${path}`;
        console.log(`Sandbox fetch via URL: ${url}`);
        const response = await fetch(url, init);
        const elapsed = Date.now() - startTime;
        console.log(`Sandbox response: ${response.status} (${elapsed}ms)`);
        return response;
      }
    } catch (error) {
      const elapsed = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Sandbox fetch failed after ${elapsed}ms:`, errorMsg);
      // Re-throw with more context
      throw new Error(`Sandbox fetch to ${path} failed: ${errorMsg}`);
    }
  }

  /**
   * Execute a quick AI task via the SDK path.
   * @deprecated This method uses the Anthropic API directly and consumes credits.
   * Use executeCode() instead which routes through /execute with OAuth credentials.
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
   * Execute a task via the container path using OAuth credentials.
   * Works for all task types (research, code, analysis, etc).
   * For code tasks, pass repo/branch to work on a specific repository.
   */
  async executeCode(task: string, options?: { repo?: string; branch?: string; timeout_seconds?: number; commit_message?: string }): Promise<ContainerExecuteResponse> {
    const body: ContainerExecuteRequest & { commit_message?: string } = {
      task,
      repo: options?.repo,
      branch: options?.branch,
      timeout_seconds: options?.timeout_seconds,
      commit_message: options?.commit_message,
    };

    console.log(`Sandbox executeCode: repo=${options?.repo}, branch=${options?.branch}, task length=${task.length}`);

    try {
      const response = await this.doFetch('/execute', {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        console.error(`Sandbox executeCode failed: ${response.status} - ${errorText}`);
        return {
          success: false,
          error: `Container execution failed (${response.status}): ${errorText}`,
        };
      }

      const result = await response.json() as ContainerExecuteResponse;
      console.log(`Sandbox executeCode result: success=${result.success}, has_logs=${!!result.logs}`);
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Sandbox executeCode exception: ${errorMsg}`);
      return {
        success: false,
        error: `Container execution exception: ${errorMsg}`,
      };
    }
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
