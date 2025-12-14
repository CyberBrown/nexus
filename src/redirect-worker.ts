/**
 * Redirect Worker for deprecated nexus.solamp.workers.dev
 *
 * This worker returns a notice that users should use nexus-mcp.solamp.workers.dev instead.
 * It still exports the DO classes to satisfy Cloudflare's requirements.
 */

// Re-export Durable Objects to satisfy existing bindings
export { InboxManager } from './durable-objects/InboxManager.ts';
export { CaptureBuffer } from './durable-objects/CaptureBuffer.ts';
export { SyncManager } from './durable-objects/SyncManager.ts';
export { UserSession } from './durable-objects/UserSession.ts';
export { IdeaExecutor } from './durable-objects/IdeaExecutor.ts';

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const correctUrl = `https://nexus-mcp.solamp.workers.dev${url.pathname}${url.search}`;

    // For MCP requests, return a JSON error that MCP clients will understand
    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'WRONG ENDPOINT: This worker (nexus.solamp.workers.dev) is deprecated. Please update your MCP configuration to use: https://nexus-mcp.solamp.workers.dev/mcp',
          data: {
            deprecated_url: request.url,
            correct_url: correctUrl,
            action_required: 'Update your MCP server URL in Claude.ai settings'
          }
        },
        id: null
      }, null, 2), {
        status: 410, // Gone
        headers: {
          'Content-Type': 'application/json',
          'X-Deprecated': 'true',
          'X-Correct-URL': correctUrl,
        }
      });
    }

    // For API requests, return a helpful JSON message
    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({
        success: false,
        error: 'WRONG ENDPOINT',
        message: 'This worker (nexus.solamp.workers.dev) is deprecated.',
        correct_url: correctUrl,
        action_required: 'Update your API base URL to: https://nexus-mcp.solamp.workers.dev'
      }, null, 2), {
        status: 410,
        headers: {
          'Content-Type': 'application/json',
          'X-Deprecated': 'true',
          'X-Correct-URL': correctUrl,
        }
      });
    }

    // For browser/HTML requests, return a friendly HTML page
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nexus - Endpoint Moved</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 600px;
      margin: 100px auto;
      padding: 20px;
      text-align: center;
      background: #1a1a2e;
      color: #eee;
    }
    .box {
      background: #16213e;
      border-radius: 12px;
      padding: 40px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    }
    h1 { color: #e94560; margin-bottom: 10px; }
    .arrow { font-size: 48px; margin: 20px 0; }
    .old-url { color: #888; text-decoration: line-through; }
    .new-url {
      color: #4ecca3;
      font-weight: bold;
      word-break: break-all;
    }
    a {
      display: inline-block;
      margin-top: 20px;
      padding: 12px 24px;
      background: #e94560;
      color: white;
      text-decoration: none;
      border-radius: 6px;
    }
    a:hover { background: #ff6b6b; }
    code {
      background: #0f0f23;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="box">
    <h1>🚚 Nexus Has Moved!</h1>
    <p>This endpoint is deprecated.</p>

    <div class="arrow">⬇️</div>

    <p class="old-url">nexus.solamp.workers.dev</p>
    <p class="new-url">nexus-mcp.solamp.workers.dev</p>

    <a href="${correctUrl}">Go to New Location →</a>

    <p style="margin-top: 30px; font-size: 14px; color: #888;">
      If you're using MCP in Claude.ai, update your server URL to:<br>
      <code>https://nexus-mcp.solamp.workers.dev/mcp</code>
    </p>
  </div>
</body>
</html>`;

    return new Response(html, {
      status: 410,
      headers: {
        'Content-Type': 'text/html',
        'X-Deprecated': 'true',
        'X-Correct-URL': correctUrl,
      }
    });
  }
};
