import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import unicorn from 'eslint-plugin-unicorn';
import perfectionist from 'eslint-plugin-perfectionist';
import globals from 'globals';

export default tseslint.config(
  // Base JavaScript recommended rules
  eslint.configs.recommended,

  // TypeScript ESLint recommended rules
  ...tseslint.configs.recommended,

  // Unicorn recommended rules
  unicorn.configs.recommended,

  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parser: tseslint.parser,
      globals: {
        ...globals.node24,
        ...globals.es2023,
      },
    },

    // Configure import-x settings
    settings: {
      'import-x/extensions': ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
      'import-x/external-module-folders': ['node_modules'],
    },

    plugins: {
      'import-x': importX,
      perfectionist,
    },

    rules: {
      // ========== TypeScript Rules ==========
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'always' }],
      '@typescript-eslint/no-require-imports': 'error',

      // ========== Import-x Rules ==========
      'import-x/no-unresolved': 'off', // TypeScript handles this
      'import-x/named': 'off', // TypeScript handles this
      'import-x/no-duplicates': 'error',
      'import-x/no-dynamic-require': 'warn',
      // Disabled: conflicts with unicorn/prefer-node-protocol
      'import-x/no-nodejs-modules': 'off',
      'import-x/order': [
        'error',
        {
          groups: [
            'type',
            ['builtin', 'internal'],
            ['parent', 'sibling', 'index'],
            'external',
            'object',
            'unknown',
          ],
          alphabetize: {
            order: 'asc',
            caseInsensitive: true,
          },
          'newlines-between': 'always',
        },
      ],
      'import-x/namespace': 'off', // TypeScript handles this
      'import-x/default': 'off', // Can cause issues with ES modules
      'import-x/no-named-as-default': 'off',
      'import-x/no-named-as-default-member': 'off',

      // ========== Perfectionist Rules ==========
      'perfectionist/sort-named-imports': [
        'error',
        {
          type: 'alphabetical',
          order: 'asc',
          ignoreCase: true,
        },
      ],
      'perfectionist/sort-named-exports': [
        'error',
        {
          type: 'alphabetical',
          order: 'asc',
          ignoreCase: true,
        },
      ],

      // ========== Unicorn Rules ==========
      'unicorn/no-process-exit': 'off',
      'unicorn/prefer-node-protocol': 'error',
      'unicorn/prefer-module': 'off',
      'unicorn/prefer-top-level-await': 'off',
      'unicorn/explicit-length-check': ['error', { 'non-zero': 'greater-than' }],
      'unicorn/filename-case': [
        'error',
        {
          case: 'kebabCase',
          ignore: ['^\\.\\w+'], // ignore dotfiles
        },
      ],
      'unicorn/no-abusive-eslint-config': 'off',
      'unicorn/prevent-abbreviations': 'off',
      //'unicorn/no-array-for-each': 'warn',
      'unicorn/no-null': 'warn',
      'unicorn/prefer-number-properties': 'warn',

      // ========== General Rules (from js recommended) ==========
      'no-console': 'off',
      'no-control-regex': 'off',
    },
  },

  // Ignore patterns
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'data/**',
      'plans/**',
      'eslint.config.js',
    ],
  }
);
