/**
 * Input component
 * Text input with label and error support
 */

import { component$, type QwikIntrinsicElements } from '@builder.io/qwik';

interface InputProps extends QwikIntrinsicElements['input'] {
  label?: string;
  error?: string;
  helperText?: string;
}

export const Input = component$<InputProps>(
  ({ label, error, helperText, ...props }) => {
    const inputClasses = `w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 transition-colors ${
      error
        ? 'border-red-500 focus:ring-red-500'
        : 'border-gray-300 focus:ring-blue-500'
    } ${props.class || ''}`;

    return (
      <div class="w-full">
        {label && (
          <label class="block text-sm font-medium text-gray-700 mb-1">
            {label}
          </label>
        )}
        <input {...props} class={inputClasses} />
        {error && <p class="mt-1 text-sm text-red-600">{error}</p>}
        {helperText && !error && (
          <p class="mt-1 text-sm text-gray-500">{helperText}</p>
        )}
      </div>
    );
  }
);
