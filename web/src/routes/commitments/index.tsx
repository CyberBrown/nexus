import { component$ } from '@builder.io/qwik';
import { Card, CardContent } from '~/components/ui';

export default component$(() => {
  return (
    <div class="container mx-auto px-4 py-8">
      <h1 class="text-3xl font-bold mb-6">Commitments</h1>
      <Card>
        <CardContent class="p-8 text-center text-gray-500">
          <p>Commitments (Waiting For / Owed To) - Coming soon!</p>
          <p class="text-sm mt-2">Track what you're waiting for and what you owe</p>
        </CardContent>
      </Card>
    </div>
  );
});
