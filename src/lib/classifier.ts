import type { Env, ClassificationResult, Project } from '../types/index.ts';
import { getEncryptionKey, decryptField } from './encryption.ts';

interface ClassifierInput {
  raw_content: string;
  source_type: string;
  source_platform?: string;
  captured_at: string;
}

interface ProjectContext {
  id: string;
  name: string;
  domain: string;
  status: string;
}

const SYSTEM_PROMPT = `You are an AI assistant that classifies inbox items for a personal productivity system. Your job is to analyze the input and extract structured information.

Analyze the input and return a JSON object with these fields:
- type: "task" | "event" | "idea" | "reference" | "someday"
  - task: actionable item that needs to be done
  - event: calendar event or meeting
  - idea: creative thought, maybe worth exploring later
  - reference: information to store, not actionable
  - someday: something to consider in the future, not urgent
- domain: "work" | "personal" | "side_project" | "family" | "health"
- title: clean, actionable title (imperative mood for tasks, e.g., "Call mom" not "Calling mom")
- description: any additional context or details (null if none)
- urgency: 1-5 (1=not urgent, 5=extremely urgent)
- importance: 1-5 (1=not important, 5=critical)
- due_date: ISO date string if mentioned (parse relative dates like "tomorrow", "next week", "Friday")
- due_time: ISO time string if specific time mentioned (e.g., "15:00:00")
- contexts: array of GTD-style contexts like ["@phone", "@computer", "@errands", "@home", "@office", "@anywhere"]
- people: array of people names mentioned
- project_id: ID of matching project from the list provided, or null
- confidence_score: 0-1 how confident you are in this classification

Today's date for reference: {{TODAY}}

Guidelines:
- For relative dates, calculate from today's date
- "tomorrow" = today + 1 day
- "next week" = next Monday
- "this weekend" = upcoming Saturday
- Be conservative with urgency/importance unless explicitly stated
- Default urgency and importance to 3 unless context suggests otherwise
- Match projects by keywords in the title/description
- Contexts should reflect where/how the task can be done
- "@phone" for calls, "@computer" for digital tasks, "@errands" for shopping/outside tasks

Return ONLY valid JSON, no markdown or explanation.`;

export async function classifyInboxItem(
  input: ClassifierInput,
  env: Env,
  tenantId: string,
  userId: string
): Promise<ClassificationResult> {
  // Get user's active projects for context
  const projects = await getUserProjects(env.DB, env.KV, tenantId, userId);

  const today = new Date().toISOString().split('T')[0]!;
  const systemPrompt = SYSTEM_PROMPT.replace('{{TODAY}}', today);

  const userPrompt = buildUserPrompt(input, projects);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('Claude API error:', error);
    throw new Error(`Classification failed: ${response.status}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>;
  };

  let text = data.content[0]?.text;
  if (!text) {
    throw new Error('No response from classifier');
  }

  // Strip markdown code blocks if present
  text = text.trim();
  if (text.startsWith('```json')) {
    text = text.slice(7);
  } else if (text.startsWith('```')) {
    text = text.slice(3);
  }
  if (text.endsWith('```')) {
    text = text.slice(0, -3);
  }
  text = text.trim();

  try {
    const result = JSON.parse(text) as ClassificationResult;
    return validateClassificationResult(result);
  } catch (error) {
    console.error('Failed to parse classification:', text);
    throw new Error('Invalid classification response');
  }
}

async function getUserProjects(
  db: D1Database,
  kv: KVNamespace,
  tenantId: string,
  userId: string
): Promise<ProjectContext[]> {
  const results = await db.prepare(`
    SELECT id, name, domain, status
    FROM projects
    WHERE tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    AND status IN ('planning', 'active')
    ORDER BY created_at DESC
    LIMIT 20
  `).bind(tenantId, userId).all<Project>();

  if (!results.results.length) {
    return [];
  }

  // Decrypt project names
  const key = await getEncryptionKey(kv, tenantId);
  const projects: ProjectContext[] = [];

  for (const project of results.results) {
    try {
      const decryptedName = await decryptField(project.name, key);
      projects.push({
        id: project.id,
        name: decryptedName,
        domain: project.domain,
        status: project.status,
      });
    } catch {
      // Skip projects we can't decrypt
    }
  }

  return projects;
}

function buildUserPrompt(input: ClassifierInput, projects: ProjectContext[]): string {
  let prompt = `Classify this inbox item:\n\n`;
  prompt += `Source: ${input.source_type}`;
  if (input.source_platform) {
    prompt += ` (${input.source_platform})`;
  }
  prompt += `\nCaptured: ${input.captured_at}\n\n`;
  prompt += `Content:\n"${input.raw_content}"`;

  if (projects.length > 0) {
    prompt += `\n\nUser's active projects:\n`;
    for (const project of projects) {
      prompt += `- ${project.name} (id: ${project.id}, domain: ${project.domain})\n`;
    }
  }

  return prompt;
}

function validateClassificationResult(result: ClassificationResult): ClassificationResult {
  // Ensure required fields exist with defaults
  return {
    type: result.type || 'reference',
    domain: result.domain || 'personal',
    title: result.title || 'Untitled',
    description: result.description || null,
    urgency: Math.min(5, Math.max(1, result.urgency || 3)),
    importance: Math.min(5, Math.max(1, result.importance || 3)),
    due_date: result.due_date || null,
    due_time: result.due_time || null,
    contexts: Array.isArray(result.contexts) ? result.contexts : [],
    people: Array.isArray(result.people) ? result.people : [],
    project_id: result.project_id || null,
    confidence_score: Math.min(1, Math.max(0, result.confidence_score || 0.5)),
  };
}
