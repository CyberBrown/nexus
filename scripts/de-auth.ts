#!/usr/bin/env node
/**
 * de-auth.ts
 * CLI tool for managing Claude OAuth credentials
 *
 * Commands:
 *   de-auth status     - Check current OAuth credential status
 *   de-auth refresh    - Trigger browser OAuth flow and update credentials
 *   de-auth deploy     - Deploy updated credentials to sandbox-executor
 *
 * Environment Variables:
 *   CONFIG_SERVICE_URL  - API endpoint (default: https://config-service.distributedelectrons.workers.dev)
 *   DE_API_KEY          - API key for authentication
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

const CONFIG_SERVICE_URL =
  process.env.CONFIG_SERVICE_URL || 'https://api.distributedelectrons.com';
const DE_API_KEY = process.env.DE_API_KEY || '';

// Colors for terminal output
const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
};

function log(color: keyof typeof colors, message: string): void {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logBold(color: keyof typeof colors, message: string): void {
  console.log(`${colors.bold}${colors[color]}${message}${colors.reset}`);
}

/**
 * Check OAuth credential status
 */
async function checkStatus(): Promise<void> {
  log('blue', '🔍 Checking OAuth credential status...\n');

  if (!DE_API_KEY) {
    log('yellow', 'Warning: DE_API_KEY not set. Using config-service without auth.');
    log('yellow', 'Set DE_API_KEY environment variable for authenticated access.\n');
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (DE_API_KEY) {
      headers['Authorization'] = `Bearer ${DE_API_KEY}`;
    }

    const response = await fetch(`${CONFIG_SERVICE_URL}/oauth/claude/status`, {
      headers,
    });

    if (!response.ok) {
      if (response.status === 401) {
        log('red', 'Error: Unauthorized. Check your DE_API_KEY.');
        return;
      }
      log('red', `Error: ${response.status} ${response.statusText}`);
      return;
    }

    const data = (await response.json()) as {
      data: {
        configured: boolean;
        expired: boolean;
        expires_at?: string;
        hours_remaining?: number;
        updated_at?: string;
        needs_refresh?: boolean;
        message?: string;
      };
    };

    console.log('');
    if (!data.data.configured) {
      logBold('yellow', '⚠️  No OAuth credentials configured.');
      log('yellow', '\nTo configure credentials, run:');
      log('cyan', '  bun run de-auth:refresh');
      return;
    }

    if (data.data.expired) {
      logBold('red', '❌ OAuth credentials have EXPIRED!');
      log('yellow', '\nYou need to re-authenticate. Run:');
      log('cyan', '  bun run de-auth:refresh');
    } else if (data.data.needs_refresh) {
      logBold('yellow', `⚠️  OAuth credentials expiring soon!`);
      log('yellow', `   Hours remaining: ${data.data.hours_remaining}`);
      log('yellow', '\nConsider refreshing soon:');
      log('cyan', '  bun run de-auth:refresh');
    } else {
      logBold('green', '✅ OAuth credentials are valid.');
      log('green', `   Expires: ${data.data.expires_at}`);
      log('green', `   Hours remaining: ${data.data.hours_remaining}`);
    }

    if (data.data.updated_at) {
      console.log(`\n   Last updated: ${data.data.updated_at}`);
    }
  } catch (error) {
    log('red', `Error checking status: ${error}`);
    log('yellow', '\nMake sure the config-service is running and accessible.');
  }
}

/**
 * Refresh OAuth credentials via browser flow
 */
async function refreshCredentials(): Promise<void> {
  logBold('blue', '🔄 Starting OAuth refresh flow...\n');

  // Step 1: Check for existing Claude CLI
  try {
    execSync('which claude', { stdio: 'pipe' });
  } catch {
    log('red', '❌ Claude CLI not found.');
    log('yellow', '\nPlease install it first:');
    log('cyan', '  npm install -g @anthropic-ai/claude-code');
    return;
  }

  // Step 2: Prompt user to perform OAuth login
  console.log('');
  log('yellow', '═'.repeat(60));
  logBold('yellow', '  MANUAL STEP REQUIRED');
  log('yellow', '═'.repeat(60));
  console.log('');
  log('green', '1. Run this command in your terminal:\n');
  log('cyan', '   claude login\n');
  log('green', '2. Complete the browser-based OAuth login');
  log('green', '3. Come back here and press ENTER when done\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  await new Promise<void>(resolve => {
    rl.question('Press ENTER when OAuth login is complete: ', () => {
      rl.close();
      resolve();
    });
  });

  // Step 3: Read the credentials file
  const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');

  if (!fs.existsSync(credentialsPath)) {
    log('red', `\n❌ Credentials file not found at: ${credentialsPath}`);
    log('yellow', 'Please run "claude login" first and complete the OAuth flow.');
    return;
  }

  const credentials = fs.readFileSync(credentialsPath, 'utf-8');

  // Validate credentials
  try {
    const parsed = JSON.parse(credentials);
    // Handle both old format (accessToken at root) and new format (claudeAiOauth nested)
    const hasToken = parsed.accessToken || parsed.claudeAiOauth?.accessToken;
    if (!hasToken) {
      throw new Error('No accessToken found in credentials');
    }
    log('green', '\n✅ Credentials file found and validated.');
  } catch (e) {
    log('red', `\n❌ Invalid credentials file format: ${e}`);
    return;
  }

  // Step 4: Upload to Config Service (optional, for status tracking)
  if (DE_API_KEY) {
    log('blue', '\n📤 Uploading credentials to Config Service...');

    try {
      const response = await fetch(`${CONFIG_SERVICE_URL}/oauth/claude`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${DE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ credentials_json: credentials }),
      });

      if (!response.ok) {
        log('yellow', `Warning: Upload to config-service failed: ${response.status}`);
        const body = await response.text();
        console.log(body);
      } else {
        const result = (await response.json()) as { data: { expires_at?: string } };
        log('green', '✅ Credentials stored in config-service.');
        if (result.data.expires_at) {
          log('green', `   Expires at: ${result.data.expires_at}`);
        }
      }
    } catch (error) {
      log('yellow', `Warning: Could not upload to config-service: ${error}`);
    }
  }

  // Step 5: Deploy to sandbox-executor
  log('blue', '\n🚀 Deploying to sandbox-executor...');
  await deployToSandbox(credentials);
}

/**
 * Deploy credentials to sandbox-executor worker secret
 */
async function deployToSandbox(credentials: string): Promise<void> {
  try {
    // Write credentials to temp file for wrangler
    const tempFile = path.join(os.tmpdir(), `claude-oauth-${Date.now()}.json`);
    fs.writeFileSync(tempFile, credentials);

    try {
      // Use wrangler to update the secret
      log('blue', '   Updating CLAUDE_OAUTH_CREDENTIALS secret...');

      // Get the project root (where wrangler.toml files are)
      const projectRoot = path.resolve(__dirname, '..');

      execSync(
        `npx wrangler secret put CLAUDE_OAUTH_CREDENTIALS --name sandbox-executor < "${tempFile}"`,
        {
          cwd: projectRoot,
          stdio: 'pipe',
          env: { ...process.env },
        }
      );

      log('green', '\n✅ Secret updated successfully!');
      logBold('green', '\n🎉 OAuth credentials have been refreshed and deployed.');
      log('blue', '   The sandbox-executor will use the new credentials on next execution.\n');
    } finally {
      // Clean up temp file
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
  } catch (error) {
    log('red', `\n❌ Deployment failed: ${error}`);
    log('yellow', '\nYou can manually deploy using:');
    log(
      'cyan',
      '  cat ~/.claude/.credentials.json | npx wrangler secret put CLAUDE_OAUTH_CREDENTIALS --name sandbox-executor'
    );
  }
}

/**
 * Deploy existing local credentials without re-authenticating
 */
async function deployOnly(): Promise<void> {
  logBold('blue', '🚀 Deploying existing credentials...\n');

  const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');

  if (!fs.existsSync(credentialsPath)) {
    log('red', `❌ Credentials file not found at: ${credentialsPath}`);
    log('yellow', '\nRun "bun run de-auth:refresh" to authenticate first.');
    return;
  }

  const credentials = fs.readFileSync(credentialsPath, 'utf-8');

  // Validate
  try {
    const parsed = JSON.parse(credentials);
    const hasToken = parsed.accessToken || parsed.claudeAiOauth?.accessToken;
    if (!hasToken) {
      throw new Error('No accessToken found');
    }
  } catch (e) {
    log('red', `❌ Invalid credentials file: ${e}`);
    return;
  }

  await deployToSandbox(credentials);
}

/**
 * Print help message
 */
function printHelp(): void {
  console.log(`
${colors.bold}Claude OAuth Management Tool${colors.reset}

${colors.cyan}Usage:${colors.reset}
  bun run de-auth <command>
  npx tsx scripts/de-auth.ts <command>

${colors.cyan}Commands:${colors.reset}
  ${colors.green}status${colors.reset}   Check current OAuth credential status
  ${colors.green}refresh${colors.reset}  Perform OAuth login and update credentials
  ${colors.green}deploy${colors.reset}   Deploy existing credentials to sandbox-executor
  ${colors.green}help${colors.reset}     Show this help message

${colors.cyan}Environment Variables:${colors.reset}
  CONFIG_SERVICE_URL  API endpoint (default: https://config-service.distributedelectrons.workers.dev)
  DE_API_KEY          API key for authentication (optional)

${colors.cyan}Examples:${colors.reset}
  # Check if credentials need refresh
  ${colors.yellow}bun run de-auth:status${colors.reset}

  # Perform full refresh flow (browser login + deploy)
  ${colors.yellow}bun run de-auth:refresh${colors.reset}

  # Deploy existing local credentials
  ${colors.yellow}bun run de-auth:deploy${colors.reset}

${colors.cyan}Notification Setup:${colors.reset}
  To receive alerts when OAuth expires, set up a webhook subscription:

  ${colors.yellow}curl -X POST ${CONFIG_SERVICE_URL}/events/subscriptions \\
    -H "Authorization: Bearer \$DE_API_KEY" \\
    -H "Content-Type: application/json" \\
    -d '{
      "tenant_id": "system",
      "name": "OAuth Alerts",
      "webhook_url": "https://ntfy.sh/YOUR_TOPIC",
      "event_types": ["oauth.expired"]
    }'${colors.reset}
`);
}

// Main entry point
const command = process.argv[2];

switch (command) {
  case 'status':
    checkStatus().catch(console.error);
    break;
  case 'refresh':
    refreshCredentials().catch(console.error);
    break;
  case 'deploy':
    deployOnly().catch(console.error);
    break;
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;
  default:
    if (command) {
      log('red', `Unknown command: ${command}\n`);
    }
    printHelp();
}
