#!/usr/bin/env bun
import { resolve } from 'node:path'
import { validateInstalledServerLayout } from './server-release-layout'

const root = resolve(process.argv[2] ?? 'dist/server')
const result = validateInstalledServerLayout(root)
console.log(JSON.stringify({ root, ...result }, null, 2))
