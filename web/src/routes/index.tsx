/**
 * Home page - Dashboard overview
 */

import { component$, useSignal, useVisibleTask$ } from '@builder.io/qwik';
import { Link } from '@builder.io/qwik-city';
import { apiClient } from '~/lib/api-client';
import { Card, CardHeader, CardTitle, CardContent, Button } from '~/components/ui';

export default component$(() => {
  const stats = useSignal({
    inbox: 0,
    tasks: 0,
    projects: 0,
  });

  useVisibleTask$(async () => {
    try {
      const [inboxItems, tasks, projects] = await Promise.all([
        apiClient.getInbox(),
        apiClient.getTasks(),
        apiClient.getProjects(),
      ]);

      stats.value = {
        inbox: inboxItems.filter((i) => !i.processed).length,
        tasks: tasks.filter((t) => t.status !== 'done').length,
        projects: projects.filter((p) => p.status === 'active').length,
      };
    } catch (e) {
      console.error('Failed to load stats', e);
    }
  });

  return (
    <div class="container mx-auto px-4 py-8">
      <div class="max-w-4xl mx-auto">
        <div class="text-center mb-12">
          <h1 class="text-4xl font-bold text-gray-900 mb-4">
            Welcome to Nexus
          </h1>
          <p class="text-xl text-gray-600">
            Your Personal AI Command Center
          </p>
        </div>

        {/* Stats */}
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <Link href="/inbox">
            <Card class="hover:shadow-lg transition-shadow cursor-pointer">
              <CardContent class="p-6 text-center">
                <div class="text-4xl font-bold text-blue-600 mb-2">
                  {stats.value.inbox}
                </div>
                <div class="text-gray-600">Unprocessed Inbox</div>
              </CardContent>
            </Card>
          </Link>

          <Link href="/tasks">
            <Card class="hover:shadow-lg transition-shadow cursor-pointer">
              <CardContent class="p-6 text-center">
                <div class="text-4xl font-bold text-green-600 mb-2">
                  {stats.value.tasks}
                </div>
                <div class="text-gray-600">Active Tasks</div>
              </CardContent>
            </Card>
          </Link>

          <Link href="/projects">
            <Card class="hover:shadow-lg transition-shadow cursor-pointer">
              <CardContent class="p-6 text-center">
                <div class="text-4xl font-bold text-purple-600 mb-2">
                  {stats.value.projects}
                </div>
                <div class="text-gray-600">Active Projects</div>
              </CardContent>
            </Card>
          </Link>
        </div>

        {/* Quick Actions */}
        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
          </CardHeader>
          <CardContent>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Link href="/capture">
                <Button fullWidth size="lg">
                  <svg class="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M10 2a3 3 0 00-3 3v5a3 3 0 006 0V5a3 3 0 00-3-3zM3 10a1 1 0 011-1h1a1 1 0 110 2H4a6 6 0 0012 0h-1a1 1 0 110-2h1a1 1 0 011 1 8 8 0 11-16 0z" />
                  </svg>
                  Quick Capture
                </Button>
              </Link>

              <Link href="/inbox">
                <Button variant="secondary" fullWidth size="lg">
                  <svg class="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884z" />
                    <path d="M18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z" />
                  </svg>
                  Process Inbox
                </Button>
              </Link>

              <Link href="/tasks">
                <Button variant="secondary" fullWidth size="lg">
                  <svg class="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z" />
                    <path fill-rule="evenodd" d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm9.707 5.707a1 1 0 00-1.414-1.414L9 12.586l-1.293-1.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
                  </svg>
                  View Tasks
                </Button>
              </Link>

              <Link href="/projects">
                <Button variant="secondary" fullWidth size="lg">
                  <svg class="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M7 3a1 1 0 000 2h6a1 1 0 100-2H7zM4 7a1 1 0 011-1h10a1 1 0 110 2H5a1 1 0 01-1-1zM2 11a2 2 0 012-2h12a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2v-4z" />
                  </svg>
                  Manage Projects
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>

        {/* Features */}
        <div class="mt-12 grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card class="bg-gradient-to-br from-blue-50 to-white border-blue-200">
            <CardContent class="p-6">
              <h3 class="text-lg font-semibold text-blue-900 mb-2">
                Voice-First Capture
              </h3>
              <p class="text-blue-800 text-sm">
                Capture thoughts instantly with voice or text. AI automatically
                classifies and organizes everything.
              </p>
            </CardContent>
          </Card>

          <Card class="bg-gradient-to-br from-green-50 to-white border-green-200">
            <CardContent class="p-6">
              <h3 class="text-lg font-semibold text-green-900 mb-2">
                Smart Organization
              </h3>
              <p class="text-green-800 text-sm">
                Tasks, projects, ideas, and commitments organized automatically.
                Focus on what matters most.
              </p>
            </CardContent>
          </Card>

          <Card class="bg-gradient-to-br from-purple-50 to-white border-purple-200">
            <CardContent class="p-6">
              <h3 class="text-lg font-semibold text-purple-900 mb-2">
                Privacy-First
              </h3>
              <p class="text-purple-800 text-sm">
                End-to-end encryption for sensitive data. Your information stays
                secure and private.
              </p>
            </CardContent>
          </Card>

          <Card class="bg-gradient-to-br from-orange-50 to-white border-orange-200">
            <CardContent class="p-6">
              <h3 class="text-lg font-semibold text-orange-900 mb-2">
                AI-Powered
              </h3>
              <p class="text-orange-800 text-sm">
                Claude AI helps classify, prioritize, and surface the right
                information at the right time.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
});
