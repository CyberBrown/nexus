/**
 * Inbox page - Review and process captured items
 */

import { component$, useSignal, useTask$, $ } from '@builder.io/qwik';
import { routeLoader$ } from '@builder.io/qwik-city';
import { apiClient } from '~/lib/api-client';
import type { InboxItem } from '~/lib/types';
import { Card, CardHeader, CardTitle, CardContent, Button, Badge } from '~/components/ui';

export const useInboxItems = routeLoader$(async () => {
  // This will run on the server
  // In production, pass auth token from request
  try {
    return await apiClient.getInbox();
  } catch (error) {
    console.error('Failed to load inbox:', error);
    return [];
  }
});

export default component$(() => {
  const inboxData = useInboxItems();
  const items = useSignal<InboxItem[]>(inboxData.value);
  const selectedItem = useSignal<InboxItem | null>(null);
  const isLoading = useSignal(false);
  const error = useSignal<string | null>(null);

  // Reload items
  const loadItems = $(async () => {
    isLoading.value = true;
    error.value = null;
    try {
      items.value = await apiClient.getInbox();
    } catch (e: any) {
      error.value = e.message || 'Failed to load inbox items';
    } finally {
      isLoading.value = false;
    }
  });

  // Process item
  const processItem = $(async (itemId: string) => {
    isLoading.value = true;
    try {
      await apiClient.updateInboxItem(itemId, { processed: true });
      items.value = items.value.filter((item) => item.id !== itemId);
      selectedItem.value = null;
    } catch (e: any) {
      error.value = e.message || 'Failed to process item';
    } finally {
      isLoading.value = false;
    }
  });

  // Delete item
  const deleteItem = $(async (itemId: string) => {
    if (!confirm('Are you sure you want to delete this item?')) return;

    isLoading.value = true;
    try {
      await apiClient.deleteInboxItem(itemId);
      items.value = items.value.filter((item) => item.id !== itemId);
      selectedItem.value = null;
    } catch (e: any) {
      error.value = e.message || 'Failed to delete item';
    } finally {
      isLoading.value = false;
    }
  });

  const unprocessedItems = items.value.filter((item) => !item.processed);

  return (
    <div class="container mx-auto px-4 py-8">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-3xl font-bold text-gray-900">Inbox</h1>
        <Button onClick$={loadItems} disabled={isLoading.value}>
          {isLoading.value ? 'Loading...' : 'Refresh'}
        </Button>
      </div>

      {error.value && (
        <div class="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-800">
          {error.value}
        </div>
      )}

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Item List */}
        <div class="space-y-3">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-lg font-semibold text-gray-700">
              Unprocessed ({unprocessedItems.length})
            </h2>
          </div>

          {unprocessedItems.length === 0 ? (
            <Card>
              <CardContent>
                <p class="text-center text-gray-500 py-8">
                  No items to process. Your inbox is empty!
                </p>
              </CardContent>
            </Card>
          ) : (
            unprocessedItems.map((item) => (
              <Card
                key={item.id}
                class={`cursor-pointer transition-all hover:shadow-md ${
                  selectedItem.value?.id === item.id
                    ? 'ring-2 ring-blue-500'
                    : ''
                }`}
                onClick$={() => {
                  selectedItem.value = item;
                }}
              >
                <CardContent>
                  <div class="flex justify-between items-start mb-2">
                    <div class="flex gap-2">
                      <Badge variant="default">{item.source}</Badge>
                      {item.classification && (
                        <Badge variant="primary">{item.classification}</Badge>
                      )}
                    </div>
                    {item.confidence && (
                      <span class="text-xs text-gray-500">
                        {Math.round(item.confidence * 100)}% confidence
                      </span>
                    )}
                  </div>
                  <p class="text-sm text-gray-900 line-clamp-2">
                    {item.raw_content}
                  </p>
                  <p class="text-xs text-gray-500 mt-2">
                    {new Date(item.created_at).toLocaleString()}
                  </p>
                </CardContent>
              </Card>
            ))
          )}
        </div>

        {/* Detail View */}
        <div class="lg:sticky lg:top-4 lg:h-fit">
          {selectedItem.value ? (
            <Card>
              <CardHeader>
                <CardTitle>Item Details</CardTitle>
              </CardHeader>
              <CardContent>
                <div class="space-y-4">
                  <div>
                    <label class="block text-sm font-medium text-gray-700 mb-1">
                      Content
                    </label>
                    <p class="text-gray-900 whitespace-pre-wrap">
                      {selectedItem.value.raw_content}
                    </p>
                  </div>

                  {selectedItem.value.processed_content && (
                    <div>
                      <label class="block text-sm font-medium text-gray-700 mb-1">
                        Processed
                      </label>
                      <p class="text-gray-900 whitespace-pre-wrap">
                        {selectedItem.value.processed_content}
                      </p>
                    </div>
                  )}

                  <div class="grid grid-cols-2 gap-4">
                    <div>
                      <label class="block text-sm font-medium text-gray-700 mb-1">
                        Source
                      </label>
                      <Badge variant="default">{selectedItem.value.source}</Badge>
                    </div>

                    {selectedItem.value.classification && (
                      <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">
                          Classification
                        </label>
                        <Badge variant="primary">
                          {selectedItem.value.classification}
                        </Badge>
                      </div>
                    )}
                  </div>

                  <div>
                    <label class="block text-sm font-medium text-gray-700 mb-1">
                      Created
                    </label>
                    <p class="text-sm text-gray-600">
                      {new Date(selectedItem.value.created_at).toLocaleString()}
                    </p>
                  </div>

                  <div class="flex gap-2 pt-4 border-t">
                    <Button
                      onClick$={() => processItem(selectedItem.value!.id)}
                      disabled={isLoading.value}
                      fullWidth
                    >
                      Mark as Processed
                    </Button>
                    <Button
                      onClick$={() => deleteItem(selectedItem.value!.id)}
                      disabled={isLoading.value}
                      variant="danger"
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent>
                <p class="text-center text-gray-500 py-8">
                  Select an item to view details
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
});
