import js from '@eslint/js'
import globals from 'globals'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'

/**
 * 前端 lint 基线（ESLint 9 flat config）。
 *
 * - `.ts`：typescript-eslint 推荐集，关掉与存量风格冲突的显式 any
 * - `.vue`：vue 官方 essential 规则 + TS 解析器（模板里也能用 TS 语法）
 * - 类型正确性仍以 `tsc --noEmit` 为准，lint 只补逻辑类问题
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },

  {
    files: ['**/*.{js,mjs,cjs}'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  ...tseslint.configs.recommended,

  ...pluginVue.configs['flat/essential'],

  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
      globals: { ...globals.browser },
    },
  },

  {
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 存量里接口响应普遍是 any；等 protocol 包落地后再收紧
      '@typescript-eslint/no-explicit-any': 'off',
      // 单文件视图组件（Dashboard / FlowList 等）沿用现有命名
      'vue/multi-word-component-names': 'off',
    },
  },

  {
    files: ['vite.config.ts'],
    languageOptions: { globals: { ...globals.node } },
  }
)
