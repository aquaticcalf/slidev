#!/usr/bin/env node
'use strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distPath = resolve(__dirname, '../dist/cli.mjs')

if (existsSync(distPath)) {
  import(distPath)
} else {
  import('tsx/esm/api')
    .then(({ register }) => {
      register()
      import('../node/cli.ts')
    })
    .catch(() => {
      // Fallback if tsx is not available or failed to register
      import('../node/cli.ts')
    })
}
