/**
 * Voice Capture Component
 * Records voice input and sends to API for processing
 */

import { component$, useSignal, $, useVisibleTask$ } from '@builder.io/qwik';
import { apiClient } from '~/lib/api-client';
import { Button } from './ui';

export const VoiceCapture = component$(() => {
  const isRecording = useSignal(false);
  const isProcessing = useSignal(false);
  const error = useSignal<string | null>(null);
  const transcript = useSignal('');
  const mediaRecorder = useSignal<MediaRecorder | null>(null);

  const startRecording = $(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];

      recorder.ondataavailable = (e) => {
        chunks.push(e.data);
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        // In production, convert audio to text using speech-to-text service
        // For now, show placeholder
        transcript.value = '[Voice recording completed - transcription would go here]';

        // Process the capture
        await processCapture('[Transcribed text from voice]');

        stream.getTracks().forEach((track) => track.stop());
      };

      recorder.start();
      mediaRecorder.value = recorder;
      isRecording.value = true;
      error.value = null;
    } catch (e: any) {
      error.value = 'Microphone access denied or not available';
    }
  });

  const stopRecording = $(() => {
    if (mediaRecorder.value) {
      mediaRecorder.value.stop();
      isRecording.value = false;
    }
  });

  const processCapture = $(async (text: string) => {
    isProcessing.value = true;
    try {
      await apiClient.capture({
        content: text,
        source: 'voice',
      });
      transcript.value = '';
      alert('Voice capture saved to inbox!');
    } catch (e: any) {
      error.value = e.message || 'Failed to save capture';
    } finally {
      isProcessing.value = false;
    }
  });

  return (
    <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
      <h3 class="text-lg font-semibold mb-4">Voice Capture</h3>

      <div class="flex flex-col items-center gap-4">
        {/* Recording button */}
        <div class="relative">
          <Button
            onClick$={isRecording.value ? stopRecording : startRecording}
            variant={isRecording.value ? 'danger' : 'primary'}
            size="lg"
            class={`rounded-full w-20 h-20 ${isRecording.value ? 'animate-pulse' : ''}`}
            disabled={isProcessing.value}
          >
            {isRecording.value ? (
              <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 20 20">
                <rect x="6" y="6" width="8" height="8" />
              </svg>
            ) : (
              <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 20 20">
                <path d="M10 2a3 3 0 00-3 3v5a3 3 0 006 0V5a3 3 0 00-3-3zM3 10a1 1 0 011-1h1a1 1 0 110 2H4a6 6 0 0012 0h-1a1 1 0 110-2h1a1 1 0 011 1 8 8 0 11-16 0z" />
              </svg>
            )}
          </Button>
        </div>

        <p class="text-sm text-gray-600 text-center">
          {isRecording.value
            ? 'Recording... Click to stop'
            : isProcessing.value
              ? 'Processing...'
              : 'Click to start recording'}
        </p>

        {transcript.value && (
          <div class="w-full p-3 bg-gray-50 rounded border border-gray-200">
            <p class="text-sm text-gray-700">{transcript.value}</p>
          </div>
        )}

        {error.value && (
          <div class="w-full p-3 bg-red-50 rounded border border-red-200 text-red-800 text-sm">
            {error.value}
          </div>
        )}
      </div>
    </div>
  );
});
