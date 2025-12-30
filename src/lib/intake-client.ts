/**
 * Intake Client
 *
 * Triggers code execution workflows via DE's intake worker.
 * Workflows run in parallel with durable execution guarantees:
 * - Automatic fallover (Claude -> Gemini)
 * - Built-in retries with exponential backoff
 * - Crash recovery (resume from checkpoint)
 * - Callbacks to Nexus on completion/failure
 *
 * ROUTING ARCHITECTURE (Dec 2024):
 * All code execution goes through: Nexus → Intake → PrimeWorkflow → CodeExecutionWorkflow → sandbox-executor
 * Direct calls to /workflows/* endpoints are BLOCKED with 403.
 * See Nexus note 8915b506 for architecture details.
 */

// ========================================
// Types
// ========================================

export interface IntakeRequest {
  query: string;
  task_type: 'code';
  app_id?: string;
  task_id?: string;
  prompt?: string;
  repo_url?: string;
  executor?: 'claude' | 'gemini';
  callback_url?: string;
  metadata?: Record<string, unknown>;
  timeout_ms?: number;
}

export interface IntakeResponse {
  success: boolean;
  request_id?: string;
  workflow_instance_id?: string;
  workflow_name?: string;
  message?: string;
  error?: string;
}

// ========================================
// Client
// ========================================

export class IntakeClient {
  private serviceBinding: Fetcher;

  constructor(serviceBinding: Fetcher) {
    this.serviceBinding = serviceBinding;
  }

  /**
   * Trigger a code execution workflow.
   * Returns immediately after workflow is created - does not wait for completion.
   * The workflow will callback to Nexus with results.
   */
  async triggerWorkflow(request: IntakeRequest): Promise<IntakeResponse> {
    const startTime = Date.now();

    try {
      console.log(`Intake: Triggering workflow for task ${request.task_id}`);

      const response = await this.serviceBinding.fetch('https://intake/intake', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });

      const elapsed = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        console.error(`Intake: Workflow trigger failed (${response.status}) in ${elapsed}ms: ${errorText}`);

        // Check for routing errors (403 from DE means we're calling a blocked endpoint)
        if (response.status === 403) {
          let errorBody: { code?: string; error?: string } = {};
          try {
            errorBody = JSON.parse(errorText);
          } catch {
            // Not JSON, use raw text
          }

          if (errorBody.code === 'USE_EXECUTE_ENDPOINT') {
            console.error(
              `ROUTING ERROR: Nexus is calling a blocked DE endpoint. ` +
              `All calls must go through POST /execute (PrimeWorkflow). ` +
              `See Nexus note 8915b506 for correct architecture.`
            );
          }
        }

        return {
          success: false,
          error: `Intake error (${response.status}): ${errorText}`,
        };
      }

      const result = await response.json() as IntakeResponse;

      // Check for runner errors that might indicate routing issues
      if (!result.success && result.error) {
        const error = result.error;
        if (error.includes('ALL_RUNNERS_FAILED') || error.includes('RUNNER_UNREACHABLE')) {
          console.error(
            `POSSIBLE ROUTING ISSUE: Received ${error}. ` +
            `If sandbox-executor is trying both runners, the call may be bypassing PrimeWorkflow. ` +
            `Verify Nexus is calling /execute not /workflows/* endpoints. ` +
            `See Nexus note 8915b506 for correct architecture.`
          );
        }
      }

      console.log(`Intake: Workflow triggered in ${elapsed}ms: ${result.workflow_instance_id}`);

      return result;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Intake: Workflow trigger exception after ${elapsed}ms: ${errorMsg}`);
      return {
        success: false,
        error: `Intake exception: ${errorMsg}`,
      };
    }
  }

  /**
   * Health check for intake service
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.serviceBinding.fetch('https://intake/health', {
        method: 'GET',
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// ========================================
// Factory
// ========================================

interface IntakeEnv {
  INTAKE?: Fetcher;
}

/**
 * Create an intake client from environment bindings.
 * Returns null if INTAKE service binding is not configured.
 */
export function createIntakeClient(env: IntakeEnv): IntakeClient | null {
  if (!env.INTAKE) {
    console.log('INTAKE service binding not configured');
    return null;
  }
  return new IntakeClient(env.INTAKE);
}
