import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/e2e/**', 'test/browser/**'],
          sequence: {
            groupOrder: 0,
          },
        },
      },
      'vitest.e2e.config.ts',
    ],
  },
})
