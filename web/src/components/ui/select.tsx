/**
 * Select component
 * Dropdown select with label and error support
 */

import { component$, Slot, type QwikIntrinsicElements } from '@builder.io/qwik';

interface SelectProps extends QwikIntrinsicElements['select'] {
  label?: string;
  error?: string;
  helperText?: string;
}

export const Select = component$<SelectProps>(
  ({ label, error, helperText, ...props }) => {
    const selectClasses = `w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 transition-colors bg-white ${
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
        <select {...props} class={selectClasses}>
          <Slot />
        </select>
        {error && <p class="mt-1 text-sm text-red-600">{error}</p>}
        {helperText && !error && (
          <p class="mt-1 text-sm text-gray-500">{helperText}</p>
        )}
      </div>
    );
  }
);
