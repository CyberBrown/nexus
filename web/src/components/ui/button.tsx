/**
 * Button component
 * Reusable button with different variants
 */

import { component$, Slot, type QwikIntrinsicElements } from '@builder.io/qwik';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends QwikIntrinsicElements['button'] {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
}

export const Button = component$<ButtonProps>(
  ({ variant = 'primary', size = 'md', fullWidth = false, ...props }) => {
    const baseClasses =
      'inline-flex items-center justify-center font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed';

    const variantClasses: Record<ButtonVariant, string> = {
      primary:
        'bg-blue-600 hover:bg-blue-700 text-white focus:ring-blue-500',
      secondary:
        'bg-gray-200 hover:bg-gray-300 text-gray-900 focus:ring-gray-500',
      danger:
        'bg-red-600 hover:bg-red-700 text-white focus:ring-red-500',
      ghost:
        'bg-transparent hover:bg-gray-100 text-gray-700 focus:ring-gray-500',
    };

    const sizeClasses: Record<ButtonSize, string> = {
      sm: 'px-3 py-1.5 text-sm',
      md: 'px-4 py-2 text-base',
      lg: 'px-6 py-3 text-lg',
    };

    const widthClass = fullWidth ? 'w-full' : '';

    const className = `${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${widthClass} ${props.class || ''}`;

    return (
      <button {...props} class={className}>
        <Slot />
      </button>
    );
  }
);
