import { defineConfig } from 'vitest/config';
import { transformWithOxc } from 'vite';

// The repo keeps React components in .js files, so parse project .js files
// as JSX (automatic runtime) before Vite's own transform sees them.
const jsxInJs = {
  name: 'jsx-in-js',
  enforce: 'pre',
  async transform(code, id) {
    const file = id.split('?')[0];
    if (file.includes('node_modules') || !file.endsWith('.js')) return null;
    return transformWithOxc(code, file, {
      lang: 'jsx',
      jsx: { runtime: 'automatic' },
    });
  },
};

export default defineConfig({
  plugins: [jsxInJs],
  css: { modules: { classNameStrategy: 'non-scoped' } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    setupFiles: ['./tests/helpers/mockEnv.js'],
  },
});
