// Notification helpers for Nexus
// Sends alerts via ntfy.sh for critical events like OAuth expiration

const NTFY_OAUTH_TOPIC = 'https://ntfy.sh/nexus-oauth-expired';

/**
 * OAuth-related error patterns that should trigger immediate quarantine
 * These errors won't benefit from retrying - they need human intervention
 */
export const OAUTH_ERROR_PATTERNS = [
  /oauth.*expired/i,
  /refresh.*token.*expired/i,
  /token.*expired/i,
  /authentication.*required/i,
  /re-?authentication.*required/i,
  /manual.*re-?auth/i,
  /oauth.*fail/i,
  /invalid.*refresh.*token/i,
  /unauthorized.*oauth/i,
  /credential.*expired/i,
];

/**
 * Routing-related error patterns that indicate Nexus is calling wrong DE endpoints
 * These errors suggest architecture/configuration issues, not transient failures
 */
export const ROUTING_ERROR_PATTERNS = [
  /ALL_RUNNERS_FAILED/i,
  /RUNNER_UNREACHABLE/i,
  /USE_EXECUTE_ENDPOINT/i,
  /blocked.*endpoint/i,
  /routing.*error/i,
];

/**
 * Check if an error message indicates an OAuth/auth issue
 * that requires human intervention (not retryable)
 */
export function isOAuthError(errorMessage: string): boolean {
  return OAUTH_ERROR_PATTERNS.some(pattern => pattern.test(errorMessage));
}

/**
 * Check if an error message indicates a routing issue
 * (Nexus calling wrong DE endpoints). These suggest configuration problems.
 * See Nexus note 8915b506 for correct architecture.
 */
export function isRoutingError(errorMessage: string): boolean {
  return ROUTING_ERROR_PATTERNS.some(pattern => pattern.test(errorMessage));
}

/**
 * Send a notification via ntfy.sh
 * DISABLED: Notifications temporarily disabled to reduce noise
 */
export async function sendNtfyNotification(
  topic: string,
  title: string,
  message: string,
  options?: {
    priority?: 'min' | 'low' | 'default' | 'high' | 'urgent';
    tags?: string[];
    click?: string;
  }
): Promise<boolean> {
  // DISABLED: Uncomment to re-enable notifications
  console.log(`[NTFY DISABLED] Would send: ${title}`);
  return true;

  try {
    const headers: Record<string, string> = {
      'Title': title,
    };

    if (options?.priority) {
      headers['Priority'] = options.priority;
    }

    if (options?.tags?.length) {
      headers['Tags'] = options.tags.join(',');
    }

    if (options?.click) {
      headers['Click'] = options.click;
    }

    const response = await fetch(topic, {
      method: 'POST',
      headers,
      body: message,
    });

    if (!response.ok) {
      console.error(`ntfy notification failed: ${response.status} ${response.statusText}`);
      return false;
    }

    console.log(`ntfy notification sent successfully to ${topic}`);
    return true;
  } catch (error) {
    console.error('Failed to send ntfy notification:', error);
    return false;
  }
}

/**
 * Send OAuth expiration alert
 * Called when a task is quarantined due to OAuth issues
 */
export async function sendOAuthExpirationAlert(
  taskId: string,
  taskTitle: string,
  errorMessage: string,
  executorType: string
): Promise<boolean> {
  const title = '🔐 OAuth Re-auth Required';
  const message = [
    `Executor: ${executorType}`,
    `Task: ${taskTitle.slice(0, 50)}`,
    `Error: ${errorMessage.slice(0, 100)}`,
    '',
    'SSH to Spark and run:',
    'docker exec -it claude-runner claude login',
    '',
    'Or from this machine:',
    'ssh spark "docker exec -it claude-runner claude login"',
  ].join('\n');

  return sendNtfyNotification(NTFY_OAUTH_TOPIC, title, message, {
    priority: 'high',
    tags: ['lock', 'warning'],
  });
}

/**
 * Send quarantine alert for non-OAuth issues
 */
export async function sendQuarantineAlert(
  taskId: string,
  taskTitle: string,
  reason: string,
  attemptCount: number
): Promise<boolean> {
  // Check if this might be a routing issue
  const routingIssue = isRoutingError(reason);
  const title = routingIssue ? '🚨 Possible Routing Issue' : '⚠️ Task Quarantined';

  const lines = [
    `Task: ${taskTitle.slice(0, 50)}`,
    `Attempts: ${attemptCount}`,
    `Reason: ${reason.slice(0, 150)}`,
  ];

  if (routingIssue) {
    lines.push('');
    lines.push('This may be a routing issue:');
    lines.push('Verify Nexus is calling POST /execute');
    lines.push('not /workflows/* endpoints.');
    lines.push('See Nexus note 8915b506.');
  }

  const message = lines.join('\n');

  return sendNtfyNotification(NTFY_OAUTH_TOPIC, title, message, {
    priority: routingIssue ? 'high' : 'default',
    tags: routingIssue ? ['warning', 'rotating_light'] : ['warning'],
  });
}
