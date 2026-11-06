// genapi.config.ts
import { defineConfig } from '@genapi/core'
import pipeline from '@genapi/pipeline'
import { fetch } from '@genapi/presets'
import { original } from 'dsh-h3/genapi'

export default defineConfig({
  preset: pipeline(
    fetch.ts.config,
    original,
    fetch.ts.parser,
    fetch.ts.compiler,
    fetch.ts.generate,
    fetch.ts.dest,
  ),
  input: './src/host/server/index.ts',
  output: {
    main: 'src/client/apis/index.ts',
    type: 'src/client/apis/index.type.ts',
  },
})
