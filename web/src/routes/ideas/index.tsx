import { component$, useSignal, useTask$, $, useVisibleTask$ } from '@builder.io/qwik';
import { Card, CardContent, CardHeader, CardTitle, Button, Badge } from '~/components/ui';
import { apiClient } from '~/lib/api-client';
import type { IdeaListItem, IdeaStatus } from '~/lib/types';

// Status badge colors
const statusColors: Record<string, string> = {
  new: 'bg-gray-100 text-gray-800',
  planned: 'bg-blue-100 text-blue-800',
  executing: 'bg-yellow-100 text-yellow-800',
  done: 'bg-green-100 text-green-800',
  blocked: 'bg-red-100 text-red-800',
};

// Task status colors
const taskStatusColors: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-800',
  ready: 'bg-blue-100 text-blue-800',
  in_progress: 'bg-yellow-100 text-yellow-800',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  blocked: 'bg-orange-100 text-orange-800',
};

// Agent type badges
const agentTypeLabels: Record<string, { label: string; color: string }> = {
  ai: { label: 'AI', color: 'bg-purple-100 text-purple-800' },
  human: { label: 'Human', color: 'bg-amber-100 text-amber-800' },
  'human-ai': { label: 'Human+AI', color: 'bg-blue-100 text-blue-800' },
};

export default component$(() => {
  const ideas = useSignal<IdeaListItem[]>([]);
  const selectedIdea = useSignal<IdeaStatus | null>(null);
  const loading = useSignal(true);
  const error = useSignal<string | null>(null);
  const actionLoading = useSignal(false);
  const statusFilter = useSignal<string>('');
  const needsInputCount = useSignal(0);

  // Load ideas on mount
  useVisibleTask$(async () => {
    try {
      const [ideasData, needsInputData] = await Promise.all([
        apiClient.getExecutionIdeas(),
        apiClient.getNeedsInput(),
      ]);
      ideas.value = ideasData;
      needsInputCount.value = needsInputData.length;
    } catch (e: any) {
      error.value = e.message || 'Failed to load ideas';
    } finally {
      loading.value = false;
    }
  });

  // Reload ideas when filter changes
  useTask$(async ({ track }) => {
    track(() => statusFilter.value);
    if (typeof window === 'undefined') return;

    try {
      loading.value = true;
      ideas.value = await apiClient.getExecutionIdeas(statusFilter.value || undefined);
    } catch (e: any) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  });

  const loadIdeaStatus = $(async (ideaId: string) => {
    try {
      loading.value = true;
      selectedIdea.value = await apiClient.getIdeaStatus(ideaId);
    } catch (e: any) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  });

  const handlePlan = $(async (ideaId: string) => {
    try {
      actionLoading.value = true;
      await apiClient.planIdea(ideaId);
      // Reload ideas and status
      ideas.value = await apiClient.getExecutionIdeas(statusFilter.value || undefined);
      if (selectedIdea.value?.idea.id === ideaId) {
        selectedIdea.value = await apiClient.getIdeaStatus(ideaId);
      }
    } catch (e: any) {
      error.value = e.message;
    } finally {
      actionLoading.value = false;
    }
  });

  const handleExecuteAll = $(async (ideaId: string) => {
    try {
      actionLoading.value = true;
      await apiClient.executeAllTasks(ideaId);
      // Reload
      ideas.value = await apiClient.getExecutionIdeas(statusFilter.value || undefined);
      if (selectedIdea.value?.idea.id === ideaId) {
        selectedIdea.value = await apiClient.getIdeaStatus(ideaId);
      }
    } catch (e: any) {
      error.value = e.message;
    } finally {
      actionLoading.value = false;
    }
  });

  const handleCompleteTask = $(async (taskId: string) => {
    try {
      actionLoading.value = true;
      await apiClient.completeTask(taskId);
      // Reload status
      if (selectedIdea.value) {
        selectedIdea.value = await apiClient.getIdeaStatus(selectedIdea.value.idea.id);
        ideas.value = await apiClient.getExecutionIdeas(statusFilter.value || undefined);
        needsInputCount.value = (await apiClient.getNeedsInput()).length;
      }
    } catch (e: any) {
      error.value = e.message;
    } finally {
      actionLoading.value = false;
    }
  });

  const handleRetryTask = $(async (taskId: string) => {
    try {
      actionLoading.value = true;
      await apiClient.retryTask(taskId);
      if (selectedIdea.value) {
        selectedIdea.value = await apiClient.getIdeaStatus(selectedIdea.value.idea.id);
      }
    } catch (e: any) {
      error.value = e.message;
    } finally {
      actionLoading.value = false;
    }
  });

  const handleExecuteTask = $(async (taskId: string) => {
    try {
      actionLoading.value = true;
      await apiClient.executeTask(taskId);
      if (selectedIdea.value) {
        selectedIdea.value = await apiClient.getIdeaStatus(selectedIdea.value.idea.id);
      }
    } catch (e: any) {
      error.value = e.message;
    } finally {
      actionLoading.value = false;
    }
  });

  return (
    <div class="container mx-auto px-4 py-8">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-3xl font-bold">Idea Execution</h1>
        {needsInputCount.value > 0 && (
          <Badge class="bg-red-500 text-white px-3 py-1">
            {needsInputCount.value} need{needsInputCount.value > 1 ? 's' : ''} input
          </Badge>
        )}
      </div>

      {error.value && (
        <Card class="mb-4 border-red-500">
          <CardContent class="p-4 text-red-600">
            {error.value}
            <button
              class="ml-4 underline"
              onClick$={() => error.value = null}
            >
              Dismiss
            </button>
          </CardContent>
        </Card>
      )}

      {/* Status filter tabs */}
      <div class="flex gap-2 mb-6 flex-wrap">
        {['', 'new', 'planned', 'executing', 'done', 'blocked'].map((status) => (
          <button
            key={status}
            class={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              statusFilter.value === status
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
            onClick$={() => statusFilter.value = status}
          >
            {status === '' ? 'All' : status.charAt(0).toUpperCase() + status.slice(1)}
          </button>
        ))}
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Ideas List */}
        <div class="space-y-4">
          <h2 class="text-xl font-semibold">Ideas</h2>

          {loading.value && !ideas.value.length ? (
            <Card>
              <CardContent class="p-8 text-center text-gray-500">
                Loading ideas...
              </CardContent>
            </Card>
          ) : ideas.value.length === 0 ? (
            <Card>
              <CardContent class="p-8 text-center text-gray-500">
                No ideas found. Create one to get started!
              </CardContent>
            </Card>
          ) : (
            ideas.value.map((idea) => (
              <Card
                key={idea.id}
                class={`cursor-pointer transition-all hover:shadow-md ${
                  selectedIdea.value?.idea.id === idea.id ? 'ring-2 ring-blue-500' : ''
                }`}
                onClick$={() => loadIdeaStatus(idea.id)}
              >
                <CardContent class="p-4">
                  <div class="flex justify-between items-start mb-2">
                    <h3 class="font-medium text-lg">{idea.title}</h3>
                    <Badge class={statusColors[idea.execution_status] || statusColors.new}>
                      {idea.execution_status || 'new'}
                    </Badge>
                  </div>

                  {idea.description && (
                    <p class="text-gray-600 text-sm mb-3 line-clamp-2">
                      {idea.description}
                    </p>
                  )}

                  <div class="flex justify-between items-center text-sm text-gray-500">
                    <span>
                      {idea.category && <Badge class="mr-2">{idea.category}</Badge>}
                      {idea.domain && <Badge class="mr-2">{idea.domain}</Badge>}
                    </span>
                    {idea.total_tasks > 0 && (
                      <span>
                        {idea.completed_tasks}/{idea.total_tasks} tasks
                      </span>
                    )}
                  </div>

                  {/* Progress bar */}
                  {idea.total_tasks > 0 && (
                    <div class="mt-3 h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        class="h-full bg-green-500 transition-all"
                        style={{ width: `${(idea.completed_tasks / idea.total_tasks) * 100}%` }}
                      />
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </div>

        {/* Selected Idea Details */}
        <div class="space-y-4">
          <h2 class="text-xl font-semibold">Details</h2>

          {!selectedIdea.value ? (
            <Card>
              <CardContent class="p-8 text-center text-gray-500">
                Select an idea to view details
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Idea Info */}
              <Card>
                <CardHeader>
                  <div class="flex justify-between items-start">
                    <CardTitle>{selectedIdea.value.idea.title}</CardTitle>
                    <Badge class={statusColors[selectedIdea.value.idea.execution_status || 'new']}>
                      {selectedIdea.value.idea.execution_status || 'new'}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  {selectedIdea.value.idea.description && (
                    <p class="text-gray-600 mb-4">
                      {selectedIdea.value.idea.description}
                    </p>
                  )}

                  {/* Stats */}
                  <div class="grid grid-cols-4 gap-2 mb-4">
                    <div class="text-center p-2 bg-gray-50 rounded">
                      <div class="text-2xl font-bold">{selectedIdea.value.stats.total}</div>
                      <div class="text-xs text-gray-500">Total</div>
                    </div>
                    <div class="text-center p-2 bg-green-50 rounded">
                      <div class="text-2xl font-bold text-green-600">
                        {selectedIdea.value.stats.completed}
                      </div>
                      <div class="text-xs text-gray-500">Done</div>
                    </div>
                    <div class="text-center p-2 bg-red-50 rounded">
                      <div class="text-2xl font-bold text-red-600">
                        {selectedIdea.value.stats.failed}
                      </div>
                      <div class="text-xs text-gray-500">Failed</div>
                    </div>
                    <div class="text-center p-2 bg-orange-50 rounded">
                      <div class="text-2xl font-bold text-orange-600">
                        {selectedIdea.value.stats.blocked}
                      </div>
                      <div class="text-xs text-gray-500">Blocked</div>
                    </div>
                  </div>

                  {/* Completion progress */}
                  <div class="mb-4">
                    <div class="flex justify-between text-sm mb-1">
                      <span>Progress</span>
                      <span>{selectedIdea.value.stats.completion_pct}%</span>
                    </div>
                    <div class="h-3 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        class="h-full bg-blue-500 transition-all"
                        style={{ width: `${selectedIdea.value.stats.completion_pct}%` }}
                      />
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div class="flex gap-2 flex-wrap">
                    {(!selectedIdea.value.idea.execution_status ||
                      selectedIdea.value.idea.execution_status === 'new') && (
                      <Button
                        onClick$={() => handlePlan(selectedIdea.value!.idea.id)}
                        disabled={actionLoading.value}
                      >
                        {actionLoading.value ? 'Planning...' : 'Plan Tasks'}
                      </Button>
                    )}

                    {selectedIdea.value.idea.execution_status === 'planned' && (
                      <Button
                        onClick$={() => handleExecuteAll(selectedIdea.value!.idea.id)}
                        disabled={actionLoading.value}
                      >
                        {actionLoading.value ? 'Starting...' : 'Execute All'}
                      </Button>
                    )}

                    {selectedIdea.value.tasks.some(t => t.status === 'ready') && (
                      <Button
                        onClick$={() => handleExecuteAll(selectedIdea.value!.idea.id)}
                        disabled={actionLoading.value}
                        class="bg-green-600 hover:bg-green-700"
                      >
                        Execute Ready Tasks
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* Blockers (if any) */}
              {selectedIdea.value.blockers.length > 0 && (
                <Card class="border-orange-300">
                  <CardHeader>
                    <CardTitle class="text-orange-600">Needs Your Input</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {selectedIdea.value.blockers.map((blocker) => (
                      <div
                        key={blocker.task_id}
                        class="flex justify-between items-center p-2 bg-orange-50 rounded mb-2"
                      >
                        <span>{blocker.title}</span>
                        <Button
                          class="bg-orange-500 hover:bg-orange-600 text-sm"
                          onClick$={() => handleCompleteTask(blocker.task_id)}
                          disabled={actionLoading.value}
                        >
                          Complete
                        </Button>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* Tasks List */}
              {selectedIdea.value.tasks.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Tasks</CardTitle>
                  </CardHeader>
                  <CardContent class="space-y-3">
                    {selectedIdea.value.tasks.map((task, index) => (
                      <div
                        key={task.id}
                        class="p-3 border rounded-lg"
                      >
                        <div class="flex justify-between items-start mb-2">
                          <div class="flex items-center gap-2">
                            <span class="text-gray-400 text-sm">#{index + 1}</span>
                            <span class="font-medium">{task.title}</span>
                          </div>
                          <div class="flex gap-2">
                            <Badge class={agentTypeLabels[task.agent_type]?.color}>
                              {agentTypeLabels[task.agent_type]?.label}
                            </Badge>
                            <Badge class={taskStatusColors[task.status]}>
                              {task.status}
                            </Badge>
                          </div>
                        </div>

                        {task.description && (
                          <p class="text-gray-600 text-sm mb-2">{task.description}</p>
                        )}

                        {task.estimated_effort && (
                          <Badge class="text-xs">{task.estimated_effort.toUpperCase()}</Badge>
                        )}

                        {/* Task actions */}
                        <div class="flex gap-2 mt-2">
                          {task.status === 'ready' && (
                            <Button
                              class="text-xs py-1 px-2"
                              onClick$={() => handleExecuteTask(task.id)}
                              disabled={actionLoading.value}
                            >
                              Execute
                            </Button>
                          )}
                          {task.status === 'blocked' && task.agent_type === 'human' && (
                            <Button
                              class="text-xs py-1 px-2 bg-orange-500 hover:bg-orange-600"
                              onClick$={() => handleCompleteTask(task.id)}
                              disabled={actionLoading.value}
                            >
                              Complete
                            </Button>
                          )}
                          {task.status === 'failed' && (
                            <Button
                              class="text-xs py-1 px-2 bg-red-500 hover:bg-red-600"
                              onClick$={() => handleRetryTask(task.id)}
                              disabled={actionLoading.value}
                            >
                              Retry
                            </Button>
                          )}
                        </div>

                        {/* Show result for completed tasks */}
                        {task.status === 'completed' && task.result && (
                          <details class="mt-2">
                            <summary class="text-sm text-blue-600 cursor-pointer">
                              View Result
                            </summary>
                            <pre class="mt-2 p-2 bg-gray-50 rounded text-xs overflow-auto max-h-48">
                              {typeof task.result === 'string'
                                ? task.result
                                : JSON.stringify(task.result, null, 2)}
                            </pre>
                          </details>
                        )}

                        {/* Show error for failed tasks */}
                        {task.status === 'failed' && task.error_message && (
                          <div class="mt-2 p-2 bg-red-50 rounded text-xs text-red-600">
                            {task.error_message}
                          </div>
                        )}
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
});
