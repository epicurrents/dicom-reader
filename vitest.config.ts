import { defineConfig } from 'vitest/config'
import { ALIASES } from './vite.shared.mjs'

export default defineConfig({
    resolve: {
        alias: ALIASES,
    },
    test: {
        environment: 'jsdom',
        globals: true,
        include: ['tests/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            // Without these, v8 reports only the files a test imported, so the percentage describes
            // the tested corner of the package rather than the package and rises as coverage
            // narrows. Naming `src` counts every source file, reached or not.
            all: true,
            include: ['src/**'],
            reportsDirectory: 'tests/coverage',
        },
    },
})
