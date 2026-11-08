// ESLint flat config. Type-aware strict rules plus project security rules.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const securityRules = {
  'no-eval': 'error',
  'no-implied-eval': 'off',
  '@typescript-eslint/no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-script-url': 'error',
  'no-restricted-properties': [
    'error',
    { property: 'innerHTML', message: 'Use textContent / createElement.' },
    { property: 'outerHTML', message: 'Use textContent / createElement.' },
    { property: 'insertAdjacentHTML', message: 'Use createElement.' },
    { object: 'document', property: 'write', message: 'Never use document.write.' },
    { object: 'document', property: 'writeln', message: 'Never use document.write.' },
  ],
  'no-restricted-syntax': [
    'error',
    { selector: 'ImportExpression', message: 'No dynamic import().' },
  ],
  'no-restricted-imports': [
    'error',
    { paths: [{ name: 'child_process', message: 'No child processes.' }, { name: 'node:child_process', message: 'No child processes.' }] },
  ],
};

export default tseslint.config(
  { ignores: ['dist/**', 'dist-check/**', 'coverage/**', 'node_modules/**', 'python/**', 'scripts/*.mjs', 'openapi/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...securityRules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': true, 'ts-nocheck': true, 'ts-expect-error': 'allow-with-description' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['error'] }],
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-properties': 'off',
    },
  },
  {
    // README examples print their results.
    files: ['examples/**/*.ts', 'scripts/**/*.ts', 'src/cli/bin.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
