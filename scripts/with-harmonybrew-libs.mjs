#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

function brewPrefix() {
  const configured = process.env.HOMEBREW_PREFIX?.trim()
  if (configured) return resolve(configured)

  const executable = resolve(process.execPath)
  const marker = `${sep}Cellar${sep}`
  const markerIndex = executable.indexOf(marker)
  return markerIndex > 0 ? executable.slice(0, markerIndex) : undefined
}

function childEnvironment() {
  if (process.platform !== 'openharmony' || process.arch !== 'arm64') {
    return process.env
  }

  const prefix = brewPrefix()
  if (!prefix) return process.env

  const libraryDirectory = join(prefix, 'lib')
  if (!existsSync(libraryDirectory)) return process.env

  const current = process.env.LD_LIBRARY_PATH?.split(':').filter(Boolean) ?? []
  const paths = [libraryDirectory, ...current.filter((path) => path !== libraryDirectory)]
  return { ...process.env, LD_LIBRARY_PATH: paths.join(':') }
}

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error('usage: with-harmonybrew-libs.mjs <command> [args...]')
  process.exit(2)
}

const result = spawnSync(command, args, {
  env: childEnvironment(),
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
