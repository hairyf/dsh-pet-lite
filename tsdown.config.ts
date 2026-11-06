import type { UserConfig } from 'tsdown'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { defineConfig } from 'tsdown'

/**
 * 宿主 / 客户端 bundle 的 externals：这些由 DSH 运行时以 `require` 提供，不打包。
 */
export const dshExternal = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  /^@deepseek-ai\//,
]

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { name: string }
const id = JSON.stringify(pkg.name)

const common: UserConfig = {
  outDir: 'dist',
  format: 'esm',
  outExtensions: () => ({ js: '.js' }),
  publint: true,
  external: dshExternal,
}

export default defineConfig([
  // Host half：ESM + 类型声明。
  {
    ...common,
    entry: { index: 'src/index.ts' },
    dts: true,
    sourcemap: false,
    clean: true,
  },
  // Client half：CJS 经典脚本，包在 `window.__ModuleLoader__.load` 工厂里。
  {
    ...common,
    entry: { client: 'src/client/index.ts' },
    format: 'cjs',
    outExtensions: () => ({ js: '.cjs' }),
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    banner: `window.__ModuleLoader__.load({id:${id},factory:(require)=>{var module={exports:{}};var exports=module.exports;`,
    footer: 'return module.exports;}});',
    dts: false,
    sourcemap: true,
    minify: true,
    clean: false,
  },
  // Electron 桌宠窗口的渲染端：独立 IIFE bundle。
  //
  // 与 client half 的区别是根本性的：这个页面是 `file://` 加载的普通网页，**没有**
  // `window.__ModuleLoader__`，因此必须把 react / react-dom / dsh-pet-component 全部打进
  // 产物里，而不是当 external 留给宿主提供。
  {
    entry: { renderer: 'src/renderer/index.tsx' },
    outDir: 'runtime/electron-helper/renderer',
    format: 'iife',
    platform: 'browser',
    // IIFE 产物默认按「名称.iife.js」命名；页面里固定引用 renderer.js，所以显式改回来。
    outputOptions: { entryFileNames: 'renderer.js' },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    dts: false,
    sourcemap: false,
    minify: true,
    clean: false,
    publint: false,
    // 这些默认会被当依赖外置；渲染端必须自包含，因此显式要求全部打进来。
    noExternal: ['dsh-pet-component', 'react', 'react-dom', 'react/jsx-runtime', 'scheduler'],
  },
])
