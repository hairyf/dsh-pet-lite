#!/usr/bin/env node
/**
 * scripts/copy-assets.mjs
 *
 * 把运行时需要的静态资源复制进 `dist/`。
 *
 * 目前只有 `presets.json`：它是内置宠物清单（与 apps/desktop `resources/manifest.jsonc`
 * 的 `pets.built-in` 同源），宿主半侧运行时按 `dist/presets.json` 读取，因此必须随产物走。
 *
 * 为什么不放在 `dist/` 里手写：`dist/` 是构建产物，不能手改（模板与 AGENTS 都这么要求）。
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'host', 'presets.json')
const targetDir = join(root, 'dist')
const target = join(targetDir, 'presets.json')

if (!existsSync(source)) {
  console.error(`[copy-assets] missing source: ${source}`)
  process.exit(1)
}

mkdirSync(targetDir, { recursive: true })
copyFileSync(source, target)
console.log(`[copy-assets] ${source} -> ${target}`)
