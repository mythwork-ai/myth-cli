import { defineConfig } from 'vitest/config'

/**
 * Unit tests for `myth publish`. Node environment because the CLI is
 * Node-native (uses node:http, node:crypto, node:zlib). No browser
 * polyfills needed.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'bin/**/*.test.ts'],
    // Default 5s is plenty for unit tests; build-objects.test boots a
    // tiny synthetic dist tree, no Vite involvement.
    testTimeout: 5000,
  },
})
