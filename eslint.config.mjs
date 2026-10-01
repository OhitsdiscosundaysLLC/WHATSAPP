// @ts-check
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // scripts/ is a plain Node CommonJS helper (not part of the TS build);
    // src/web/public/**/*.js runs in the browser, not Node — neither
    // belongs under the backend's TypeScript-aware lint rules.
    ignores: ['dist/**', 'node_modules/**', 'scripts/**', 'src/web/public/**/*.js'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  eslintConfigPrettier,
);
