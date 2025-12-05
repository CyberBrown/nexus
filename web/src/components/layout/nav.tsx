/**
 * Main navigation component
 */

import { component$ } from '@builder.io/qwik';
import { Link } from '@builder.io/qwik-city';

export const Nav = component$(() => {
  const navItems = [
    { href: '/', label: 'Home' },
    { href: '/capture', label: 'Capture' },
    { href: '/inbox', label: 'Inbox' },
    { href: '/tasks', label: 'Tasks' },
    { href: '/projects', label: 'Projects' },
    { href: '/ideas', label: 'Ideas' },
    { href: '/people', label: 'People' },
    { href: '/commitments', label: 'Commitments' },
  ];

  return (
    <nav class="bg-white shadow-sm border-b border-gray-200">
      <div class="container mx-auto px-4">
        <div class="flex items-center justify-between h-16">
          <div class="flex items-center space-x-8">
            <Link href="/" class="text-xl font-bold text-blue-600">
              Nexus
            </Link>
            <div class="hidden md:flex space-x-4">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  class="text-gray-700 hover:text-blue-600 px-3 py-2 text-sm font-medium transition-colors"
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
          <div class="flex items-center space-x-4">
            <button class="text-gray-700 hover:text-blue-600">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
});
