/**
 * Card component
 * Container for content sections
 */

import { component$, Slot } from '@builder.io/qwik';

interface CardProps {
  class?: string;
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

export const Card = component$<CardProps>(({ class: className, padding = 'md' }) => {
  const paddingClasses = {
    none: '',
    sm: 'p-3',
    md: 'p-4',
    lg: 'p-6',
  };

  return (
    <div
      class={`bg-white rounded-lg shadow-sm border border-gray-200 ${paddingClasses[padding]} ${className || ''}`}
    >
      <Slot />
    </div>
  );
});

export const CardHeader = component$<{ class?: string }>(({ class: className }) => {
  return (
    <div class={`mb-4 ${className || ''}`}>
      <Slot />
    </div>
  );
});

export const CardTitle = component$<{ class?: string }>(({ class: className }) => {
  return (
    <h3 class={`text-lg font-semibold text-gray-900 ${className || ''}`}>
      <Slot />
    </h3>
  );
});

export const CardContent = component$<{ class?: string }>(({ class: className }) => {
  return (
    <div class={className || ''}>
      <Slot />
    </div>
  );
});
