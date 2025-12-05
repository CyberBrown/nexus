import { component$ } from '@builder.io/qwik';
import { Card, CardContent } from '~/components/ui';

export default component$(() => {
  return (
    <div class="container mx-auto px-4 py-8">
      <h1 class="text-3xl font-bold mb-6">Ideas</h1>
      <Card>
        <CardContent class="p-8 text-center text-gray-500">
          <p>Ideas / Someday-Maybe view - Coming soon!</p>
          <p class="text-sm mt-2">Capture and organize future possibilities</p>
        </CardContent>
      </Card>
    </div>
  );
});
