/**
 * Badge component
 * Small status indicators and tags
 */

import { component$, Slot } from '@builder.io/qwik';

export type BadgeVariant = 'default' | 'primary' | 'success' | 'warning' | 'danger';

interface BadgeProps {
  variant?: BadgeVariant;
  class?: string;
}

export const Badge = component$<BadgeProps>(({ variant = 'default', class: className }) => {
  const variantClasses: Record<BadgeVariant, string> = {
    default: 'bg-gray-100 text-gray-700',
    primary: 'bg-blue-100 text-blue-700',
    success: 'bg-green-100 text-green-700',
    warning: 'bg-yellow-100 text-yellow-700',
    danger: 'bg-red-100 text-red-700',
  };

  return (
    <span
      class={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${variantClasses[variant]} ${className || ''}`}
    >
      <Slot />
    </span>
  );
});
