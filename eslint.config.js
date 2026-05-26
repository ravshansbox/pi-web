import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist', 'build', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { URL: 'readonly', console: 'readonly', process: 'readonly' } },
  },
  prettierConfig,
);
