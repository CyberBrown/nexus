// Example usage of the Recurring Tasks API
// This file demonstrates common patterns for working with recurring tasks

import type { Task } from '../src/types/index.ts';

// Base API URL (adjust for your environment)
const API_BASE = 'http://localhost:8787/api';

// Example: Create a daily recurring task
async function createDailyTask() {
  const response = await fetch(`${API_BASE}/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Add your auth headers here
    },
    body: JSON.stringify({
      title: 'Morning review',
      description: 'Review goals and priorities for the day',
      domain: 'personal',
      status: 'scheduled',
      due_date: '2025-01-15',
      due_time: '08:00:00',
      recurrence_rule: 'FREQ=DAILY',
      urgency: 4,
      importance: 5,
      energy_required: 'low',
    }),
  });

  const result = await response.json();
  console.log('Created daily task:', result);
  return result.data.id;
}

// Example: Create a weekly task on specific days
async function createWeeklyMeetingTask() {
  const response = await fetch(`${API_BASE}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Team standup',
      description: 'Daily standup with engineering team',
      domain: 'work',
      project_id: 'some-project-id',
      status: 'scheduled',
      due_date: '2025-01-15', // Start date (a Monday)
      due_time: '09:30:00',
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
      time_estimate_minutes: 15,
      urgency: 3,
      importance: 4,
      energy_required: 'medium',
    }),
  });

  return await response.json();
}

// Example: Create a monthly recurring task
async function createMonthlyReview() {
  const response = await fetch(`${API_BASE}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Monthly budget review',
      description: 'Review spending and adjust budget categories',
      domain: 'personal',
      area: 'finance',
      status: 'scheduled',
      due_date: '2025-01-31',
      recurrence_rule: 'FREQ=MONTHLY',
      time_estimate_minutes: 60,
      urgency: 3,
      importance: 4,
      energy_required: 'high',
    }),
  });

  return await response.json();
}

// Example: Create a recurring task with a count limit
async function createLimitedRecurrenceTask() {
  const response = await fetch(`${API_BASE}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: '30-day meditation challenge',
      description: 'Meditate for 10 minutes',
      domain: 'personal',
      area: 'health',
      status: 'scheduled',
      due_date: '2025-01-15',
      recurrence_rule: 'FREQ=DAILY;COUNT=30',
      time_estimate_minutes: 10,
      urgency: 3,
      importance: 4,
      energy_required: 'low',
      tags: 'challenge,habit',
    }),
  });

  return await response.json();
}

// Example: Create a recurring task with an end date
async function createTaskWithEndDate() {
  const response = await fetch(`${API_BASE}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Q1 goals review',
      description: 'Review progress on quarterly goals',
      domain: 'work',
      status: 'scheduled',
      due_date: '2025-01-15',
      recurrence_rule: 'FREQ=WEEKLY;UNTIL=2025-03-31',
      urgency: 4,
      importance: 5,
      energy_required: 'medium',
    }),
  });

  return await response.json();
}

// Example: Complete a task (auto-spawns next instance)
async function completeTask(taskId: string) {
  const response = await fetch(`${API_BASE}/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'completed',
      actual_time_minutes: 12,
    }),
  });

  const result = await response.json();

  if (result.spawned_task_id) {
    console.log('Task completed and next instance spawned:', result.spawned_task_id);
  } else {
    console.log('Task completed (no more recurrences)');
  }

  return result;
}

// Example: Manually spawn next instance without completing
async function spawnNextInstance(taskId: string) {
  const response = await fetch(`${API_BASE}/tasks/${taskId}/spawn-next`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  const result = await response.json();

  if (result.success) {
    console.log('Spawned next instance:', result.data.spawned_task_id);
  } else {
    console.log('Cannot spawn:', result.message);
  }

  return result;
}

// Example: Validate a recurrence rule before creating task
async function validateRecurrenceRule(rule: string) {
  const response = await fetch(`${API_BASE}/tasks/validate-recurrence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recurrence_rule: rule }),
  });

  const result = await response.json();

  if (result.valid) {
    console.log(`Valid rule: ${result.description}`);
  } else {
    console.log(`Invalid rule: ${result.error}`);
  }

  return result;
}

// Example: Get recurrence history
async function getRecurrenceHistory(taskId: string) {
  const response = await fetch(`${API_BASE}/tasks/${taskId}/recurrence-history`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  const result = await response.json();

  console.log(`Recurrence chain has ${result.data.total_instances} instances`);
  console.log('Parent ID:', result.data.parent_id);

  // Display all instances
  for (const task of result.data.tasks) {
    console.log(`- ${task.due_date}: ${task.status} (${task.id})`);
  }

  return result;
}

// Example: Update recurrence rule for existing task
async function updateRecurrenceRule(taskId: string, newRule: string) {
  // First validate the new rule
  const validation = await validateRecurrenceRule(newRule);
  if (!validation.valid) {
    throw new Error(`Invalid rule: ${validation.error}`);
  }

  // Update the task
  const response = await fetch(`${API_BASE}/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recurrence_rule: newRule,
    }),
  });

  return await response.json();
}

// Example: Remove recurrence from a task
async function removeRecurrence(taskId: string) {
  const response = await fetch(`${API_BASE}/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recurrence_rule: null,
    }),
  });

  console.log('Recurrence removed from task');
  return await response.json();
}

// Example workflow: Create, complete, and track recurring task
async function workflowExample() {
  console.log('=== Recurring Task Workflow ===\n');

  // 1. Create a weekly recurring task
  console.log('Step 1: Creating weekly task...');
  const createResult = await createWeeklyMeetingTask();
  const taskId = createResult.data.id;
  console.log(`Created task: ${taskId}\n`);

  // 2. Validate a different recurrence rule
  console.log('Step 2: Validating recurrence rule...');
  await validateRecurrenceRule('FREQ=DAILY;INTERVAL=2');
  console.log();

  // 3. Get the task
  console.log('Step 3: Fetching task...');
  const getResponse = await fetch(`${API_BASE}/tasks/${taskId}`);
  const task = await getResponse.json();
  console.log(`Task due date: ${task.data.due_date}\n`);

  // 4. Complete the task (auto-spawns next)
  console.log('Step 4: Completing task (should auto-spawn)...');
  const completeResult = await completeTask(taskId);
  console.log();

  // 5. View recurrence history
  console.log('Step 5: Viewing recurrence history...');
  await getRecurrenceHistory(taskId);
  console.log();

  // 6. Manually spawn another instance
  if (completeResult.spawned_task_id) {
    console.log('Step 6: Manually spawning next instance...');
    await spawnNextInstance(completeResult.spawned_task_id);
  }

  console.log('\n=== Workflow Complete ===');
}

// Common recurrence patterns
const COMMON_PATTERNS = {
  // Daily
  daily: 'FREQ=DAILY',
  everyOtherDay: 'FREQ=DAILY;INTERVAL=2',
  weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  weekends: 'FREQ=WEEKLY;BYDAY=SA,SU',

  // Weekly
  weekly: 'FREQ=WEEKLY',
  biweekly: 'FREQ=WEEKLY;INTERVAL=2',
  mondayWednesdayFriday: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
  tuesdayThursday: 'FREQ=WEEKLY;BYDAY=TU,TH',

  // Monthly
  monthly: 'FREQ=MONTHLY',
  quarterly: 'FREQ=MONTHLY;INTERVAL=3',
  biannually: 'FREQ=MONTHLY;INTERVAL=6',

  // Yearly
  yearly: 'FREQ=YEARLY',

  // With limits
  thirtyDayChallenge: 'FREQ=DAILY;COUNT=30',
  twelveWeekProgram: 'FREQ=WEEKLY;COUNT=12',
  quarterlyThisYear: 'FREQ=MONTHLY;INTERVAL=3;UNTIL=2025-12-31',
};

// Export examples for use
export {
  createDailyTask,
  createWeeklyMeetingTask,
  createMonthlyReview,
  createLimitedRecurrenceTask,
  createTaskWithEndDate,
  completeTask,
  spawnNextInstance,
  validateRecurrenceRule,
  getRecurrenceHistory,
  updateRecurrenceRule,
  removeRecurrence,
  workflowExample,
  COMMON_PATTERNS,
};
