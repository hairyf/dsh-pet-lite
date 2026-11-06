// @ts-check
import antfu from '@antfu/eslint-config'

/**
 * 只检查本插件自己的代码。
 *
 * `source/` 是参考资料子模块（dsh-pet、deepseek-harness-desktop 的完整源码树），
 * `dist/`、`runtime/electron-helper/renderer/renderer.js` 是构建产物 —— 三者都不属于
 * 本仓库的代码风格责任范围。
 */
export default antfu({
  type: 'lib',
  pnpm: true,
  ignores: [
    'source/**',
    'dist/**',
    // 临时的截图 / 诊断脚本（.tmp-* 均为本地工作目录，不入库）
    '.tmp-*/**',
    'runtime/electron-helper/renderer/renderer.js',
    '**/*.tgz',
  ],
})
