/**
 * Tasks page - View and manage tasks
 */

import { component$, useSignal, $ } from '@builder.io/qwik';
import { routeLoader$ } from '@builder.io/qwik-city';
import { apiClient } from '~/lib/api-client';
import type { Task, CreateTaskInput } from '~/lib/types';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  Button,
  Badge,
  Input,
  Select,
  Textarea,
} from '~/components/ui';

export const useTasks = routeLoader$(async () => {
  try {
    return await apiClient.getTasks();
  } catch (error) {
    return [];
  }
});

export default component$(() => {
  const tasksData = useTasks();
  const tasks = useSignal<Task[]>(tasksData.value);
  const showCreateModal = useSignal(false);
  const isLoading = useSignal(false);
  const error = useSignal<string | null>(null);

  // Form state
  const formData = useSignal<CreateTaskInput>({
    title: '',
    description: '',
    status: 'todo',
    priority: 'medium',
  });

  const loadTasks = $(async () => {
    isLoading.value = true;
    try {
      tasks.value = await apiClient.getTasks();
    } catch (e: any) {
      error.value = e.message;
    } finally {
      isLoading.value = false;
    }
  });

  const createTask = $(async () => {
    if (!formData.value.title.trim()) {
      error.value = 'Title is required';
      return;
    }

    isLoading.value = true;
    try {
      const newTask = await apiClient.createTask(formData.value);
      tasks.value = [...tasks.value, newTask];
      showCreateModal.value = false;
      formData.value = { title: '', description: '', status: 'todo', priority: 'medium' };
    } catch (e: any) {
      error.value = e.message;
    } finally {
      isLoading.value = false;
    }
  });

  const updateTaskStatus = $(async (taskId: string, status: Task['status']) => {
    isLoading.value = true;
    try {
      const updated = await apiClient.updateTask(taskId, { status });
      tasks.value = tasks.value.map((t) => (t.id === taskId ? updated : t));
    } catch (e: any) {
      error.value = e.message;
    } finally {
      isLoading.value = false;
    }
  });

  const deleteTask = $(async (taskId: string) => {
    if (!confirm('Delete this task?')) return;
    isLoading.value = true;
    try {
      await apiClient.deleteTask(taskId);
      tasks.value = tasks.value.filter((t) => t.id !== taskId);
    } catch (e: any) {
      error.value = e.message;
    } finally {
      isLoading.value = false;
    }
  });

  const todoTasks = tasks.value.filter((t) => t.status === 'todo');
  const inProgressTasks = tasks.value.filter((t) => t.status === 'in_progress');
  const doneTasks = tasks.value.filter((t) => t.status === 'done');

  return (
    <div class="container mx-auto px-4 py-8">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-3xl font-bold">Tasks</h1>
        <div class="flex gap-2">
          <Button onClick$={loadTasks} disabled={isLoading.value} variant="secondary">
            Refresh
          </Button>
          <Button onClick$={() => (showCreateModal.value = true)}>
            + New Task
          </Button>
        </div>
      </div>

      {error.value && (
        <div class="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-800">
          {error.value}
        </div>
      )}

      {/* Kanban Board */}
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* To Do */}
        <div>
          <h2 class="text-lg font-semibold mb-3 text-gray-700">
            To Do ({todoTasks.length})
          </h2>
          <div class="space-y-2">
            {todoTasks.map((task) => (
              <Card key={task.id} class="hover:shadow-md transition">
                <CardContent class="p-3">
                  <div class="flex justify-between items-start mb-2">
                    <h3 class="font-medium text-gray-900">{task.title}</h3>
                    <Badge
                      variant={
                        task.priority === 'urgent'
                          ? 'danger'
                          : task.priority === 'high'
                            ? 'warning'
                            : 'default'
                      }
                    >
                      {task.priority}
                    </Badge>
                  </div>
                  {task.description && (
                    <p class="text-sm text-gray-600 mb-3 line-clamp-2">
                      {task.description}
                    </p>
                  )}
                  <div class="flex gap-2">
                    <Button
                      size="sm"
                      onClick$={() => updateTaskStatus(task.id, 'in_progress')}
                    >
                      Start
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick$={() => deleteTask(task.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
            {todoTasks.length === 0 && (
              <p class="text-gray-500 text-center py-4">No tasks</p>
            )}
          </div>
        </div>

        {/* In Progress */}
        <div>
          <h2 class="text-lg font-semibold mb-3 text-gray-700">
            In Progress ({inProgressTasks.length})
          </h2>
          <div class="space-y-2">
            {inProgressTasks.map((task) => (
              <Card key={task.id} class="hover:shadow-md transition bg-blue-50">
                <CardContent class="p-3">
                  <div class="flex justify-between items-start mb-2">
                    <h3 class="font-medium text-gray-900">{task.title}</h3>
                    <Badge
                      variant={
                        task.priority === 'urgent'
                          ? 'danger'
                          : task.priority === 'high'
                            ? 'warning'
                            : 'default'
                      }
                    >
                      {task.priority}
                    </Badge>
                  </div>
                  {task.description && (
                    <p class="text-sm text-gray-600 mb-3 line-clamp-2">
                      {task.description}
                    </p>
                  )}
                  <div class="flex gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick$={() => updateTaskStatus(task.id, 'done')}
                    >
                      Complete
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick$={() => updateTaskStatus(task.id, 'todo')}
                    >
                      Back
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
            {inProgressTasks.length === 0 && (
              <p class="text-gray-500 text-center py-4">No tasks</p>
            )}
          </div>
        </div>

        {/* Done */}
        <div>
          <h2 class="text-lg font-semibold mb-3 text-gray-700">
            Done ({doneTasks.length})
          </h2>
          <div class="space-y-2">
            {doneTasks.map((task) => (
              <Card key={task.id} class="hover:shadow-md transition bg-green-50 opacity-75">
                <CardContent class="p-3">
                  <h3 class="font-medium text-gray-900 line-through">{task.title}</h3>
                  {task.completed_at && (
                    <p class="text-xs text-gray-500 mt-2">
                      Completed {new Date(task.completed_at).toLocaleDateString()}
                    </p>
                  )}
                  <div class="flex gap-2 mt-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick$={() => updateTaskStatus(task.id, 'todo')}
                    >
                      Reopen
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick$={() => deleteTask(task.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
            {doneTasks.length === 0 && (
              <p class="text-gray-500 text-center py-4">No tasks</p>
            )}
          </div>
        </div>
      </div>

      {/* Create Modal */}
      {showCreateModal.value && (
        <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <Card class="max-w-lg w-full">
            <CardHeader>
              <CardTitle>Create New Task</CardTitle>
            </CardHeader>
            <CardContent>
              <div class="space-y-4">
                <Input
                  label="Title"
                  value={formData.value.title}
                  onInput$={(e) => {
                    formData.value = {
                      ...formData.value,
                      title: (e.target as HTMLInputElement).value,
                    };
                  }}
                  placeholder="Enter task title"
                  required
                />

                <Textarea
                  label="Description"
                  value={formData.value.description}
                  onInput$={(e) => {
                    formData.value = {
                      ...formData.value,
                      description: (e.target as HTMLTextAreaElement).value,
                    };
                  }}
                  placeholder="Enter task description"
                  rows={3}
                />

                <Select
                  label="Priority"
                  value={formData.value.priority}
                  onChange$={(e) => {
                    formData.value = {
                      ...formData.value,
                      priority: (e.target as HTMLSelectElement).value as any,
                    };
                  }}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </Select>

                <div class="flex gap-2 pt-4">
                  <Button onClick$={createTask} disabled={isLoading.value} fullWidth>
                    Create Task
                  </Button>
                  <Button
                    variant="secondary"
                    onClick$={() => (showCreateModal.value = false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
});
