import { component$, Slot, useStyles$ } from "@builder.io/qwik";
import { routeLoader$ } from "@builder.io/qwik-city";
import { AuthProvider } from "~/lib/auth-context";
import { Nav } from "~/components/layout/nav";

import styles from "./styles.css?inline";

export const useServerTimeLoader = routeLoader$(() => {
  return {
    date: new Date().toISOString(),
  };
});

export default component$(() => {
  useStyles$(styles);
  return (
    <AuthProvider>
      <div class="min-h-screen bg-gray-50 flex flex-col">
        <Nav />
        <main class="flex-1">
          <Slot />
        </main>
        <footer class="bg-white border-t border-gray-200 py-4">
          <div class="container mx-auto px-4 text-center text-sm text-gray-600">
            Nexus - Personal AI Command Center
          </div>
        </footer>
      </div>
    </AuthProvider>
  );
});
