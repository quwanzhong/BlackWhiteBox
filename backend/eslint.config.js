import js from '@eslint/js'
import globals from 'globals'

/**
 * 后端 lint 基线（ESLint 9 flat config）。
 *
 * 定位：只挡"真会出事"的问题（未定义变量、重复键、不可达代码、误用 Promise 等），
 * 不引入风格规则。存量代码一次性格式化没有收益，反而会淹没真实告警。
 */
export default [
  {
    ignores: ['node_modules/**', 'data/**', 'coverage/**'],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      // 未使用变量降为 warn：存量里有些为了可读性保留的解构/参数
      'no-unused-vars': [
        'warn',
        { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // 空 catch 是故意的降级处理（例如元数据写失败不影响主流程）
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // 宽松相等在表达式求值器/兼容旧数据里有明确用途
      eqeqeq: 'off',
      'no-control-regex': 'off',
    },
  },
]
