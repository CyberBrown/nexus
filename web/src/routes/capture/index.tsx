/**
 * Capture page - Quick capture interface with voice and text
 */

import { component$, useSignal, $ } from '@builder.io/qwik';
import { apiClient } from '~/lib/api-client';
import { Card, CardHeader, CardTitle, CardContent, Button, Textarea } from '~/components/ui';
import { VoiceCapture } from '~/components/voice-capture';

export default component$(() => {
  const textContent = useSignal('');
  const isSubmitting = useSignal(false);
  const error = useSignal<string | null>(null);
  const success = useSignal(false);

  const handleTextCapture = $(async () => {
    if (!textContent.value.trim()) {
      error.value = 'Please enter some text';
      return;
    }

    isSubmitting.value = true;
    error.value = null;
    success.value = false;

    try {
      await apiClient.capture({
        content: textContent.value,
        source: 'text',
      });
      textContent.value = '';
      success.value = true;
      setTimeout(() => {
        success.value = false;
      }, 3000);
    } catch (e: any) {
      error.value = e.message || 'Failed to capture';
    } finally {
      isSubmitting.value = false;
    }
  });

  return (
    <div class="container mx-auto px-4 py-8 max-w-3xl">
      <h1 class="text-3xl font-bold mb-6">Quick Capture</h1>

      <div class="grid gap-6">
        {/* Voice Capture */}
        <VoiceCapture />

        {/* Text Capture */}
        <Card>
          <CardHeader>
            <CardTitle>Text Capture</CardTitle>
          </CardHeader>
          <CardContent>
            <div class="space-y-4">
              <Textarea
                placeholder="Type or paste anything here..."
                rows={4}
                value={textContent.value}
                onInput$={(e) => {
                  textContent.value = (e.target as HTMLTextAreaElement).value;
                }}
              />

              <Button
                onClick$={handleTextCapture}
                disabled={isSubmitting.value}
                fullWidth
              >
                {isSubmitting.value ? 'Saving...' : 'Save to Inbox'}
              </Button>

              {error.value && (
                <div class="p-3 bg-red-50 border border-red-200 rounded text-red-800 text-sm">
                  {error.value}
                </div>
              )}

              {success.value && (
                <div class="p-3 bg-green-50 border border-green-200 rounded text-green-800 text-sm">
                  Saved to inbox successfully!
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Quick Tips */}
        <Card class="bg-blue-50 border-blue-200">
          <CardContent class="p-4">
            <h3 class="font-semibold text-blue-900 mb-2">Quick Tips</h3>
            <ul class="text-sm text-blue-800 space-y-1 list-disc list-inside">
              <li>Use voice capture for hands-free input</li>
              <li>Text capture supports quick typing or paste</li>
              <li>All captures are AI-classified automatically</li>
              <li>Review items in your Inbox</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
});
