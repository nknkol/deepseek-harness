#!/usr/bin/env node

/** Prepare the native dependencies owned by dsh-subprocess-local on OpenHarmony. */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const KOFFI_VERSION = '3.1.5'
const NODE_PTY_VERSION = '1.1.0'

function packageRoot(name, from) {
  let entry
  try {
    entry = createRequire(join(from, 'package.json')).resolve(name)
  } catch {
    return undefined
  }
  let directory = dirname(entry)
  while (directory !== dirname(directory)) {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (manifest.name === name) return directory
      } catch {
        // Continue upward when an entry's nearest manifest is not readable JSON.
      }
    }
    directory = dirname(directory)
  }
  return undefined
}

function brewPrefix() {
  const configured = process.env.HOMEBREW_PREFIX?.trim()
  if (configured) return resolve(configured)

  const executable = resolve(process.execPath)
  const marker = `${sep}Cellar${sep}`
  const markerIndex = executable.indexOf(marker)
  return markerIndex > 0 ? executable.slice(0, markerIndex) : undefined
}

function unameLibrary() {
  const prefix = brewPrefix()
  if (!prefix) return undefined

  const library = join(prefix, 'opt/uname-is-linux/lib/libuname.so')
  return existsSync(library) ? library : undefined
}

function childEnvironment(preload, buildFromSource = false) {
  const prefix = brewPrefix()
  const sdkLibrary = prefix && join(prefix, 'opt/ohos-sdk/native/llvm/lib')
  const current = process.env.LD_LIBRARY_PATH?.split(':').filter(Boolean) ?? []
  const libraries = sdkLibrary && existsSync(sdkLibrary)
    ? [sdkLibrary, ...current.filter((path) => path !== sdkLibrary)]
    : current
  return {
    ...process.env,
    ...(libraries.length > 0 ? { LD_LIBRARY_PATH: libraries.join(':') } : {}),
    LD_PRELOAD: preload,
    ...(buildFromSource ? { npm_config_build_from_source: 'true' } : {}),
  }
}

function nativeFiles(directory, name) {
  const result = []
  const pending = [directory]

  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
      } else if (entry.isFile() && entry.name === name) {
        result.push(path)
      }
    }
  }

  return result
}

function firstPackage(name, roots) {
  for (const root of roots) {
    const directory = packageRoot(name, root)
    if (directory !== undefined) return directory
  }
  return undefined
}

function nodeGypPath() {
  const candidates = []
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath) {
    candidates.push(join(dirname(dirname(resolve(npmExecPath))), 'node_modules/node-gyp/bin/node-gyp.js'))
  }

  const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' })
  if (npmRoot.status === 0) {
    const root = npmRoot.stdout.trim()
    candidates.push(join(root, 'npm/node_modules/node-gyp/bin/node-gyp.js'))
    candidates.push(join(root, 'pnpm/dist/node_modules/node-gyp/bin/node-gyp.js'))
  }

  return candidates.find((candidate) => existsSync(candidate))
}

/** Prepare Koffi using its original source build when OpenHarmony has no native output. */
export function prepareKoffi(roots, packageDirectory) {
  if (process.platform !== 'openharmony' || process.arch !== 'arm64') return
  const directory = firstPackage('koffi', roots)
  if (directory === undefined) return

  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (manifest.version !== KOFFI_VERSION) {
    throw new Error(`Expected koffi@${KOFFI_VERSION}, found koffi@${manifest.version}`)
  }
  if (nativeFiles(directory, 'koffi.node').length > 0) return

  const preload = unameLibrary()
  if (!preload) throw new Error(`Cannot prepare koffi@${KOFFI_VERSION}: uname-is-linux is not installed`)

  // npm may leave a failed OpenHarmony CMake cache that selected the wrong ABI.
  rmSync(join(directory, 'build'), { recursive: true, force: true })
  console.log(`[prepare-koffi] building koffi@${KOFFI_VERSION} with uname-is-linux`)
  const result = spawnSync(process.execPath, ['./cnoke.cjs', '-P', '.', '-D', 'src/koffi', '--prebuild', '--release'], {
    cwd: directory,
    env: childEnvironment(preload),
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`koffi@${KOFFI_VERSION} build failed with exit code ${String(result.status)}`)
  }
  if (nativeFiles(directory, 'koffi.node').length === 0) {
    throw new Error(`koffi@${KOFFI_VERSION} build completed without producing koffi.node`)
  }
  if (packageDirectory !== undefined && !existsSync(join(packageDirectory, 'src'))) {
    const privateDirectory = join(packageDirectory, 'node_modules/koffi')
    if (directory !== privateDirectory) {
      mkdirSync(dirname(privateDirectory), { recursive: true })
      renameSync(directory, privateDirectory)
    }
  }
}

/** Prepare node-pty using its original node-gyp build when OpenHarmony has no native output. */
export function prepareNodePty(roots) {
  if (process.platform !== 'openharmony' || process.arch !== 'arm64') return
  const directory = firstPackage('node-pty', roots)
  if (directory === undefined) return

  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (manifest.version !== NODE_PTY_VERSION) {
    throw new Error(`Expected node-pty@${NODE_PTY_VERSION}, found node-pty@${manifest.version}`)
  }
  const nativeModule = join(directory, 'build/Release/pty.node')
  if (existsSync(nativeModule)) return

  const preload = unameLibrary()
  if (!preload) throw new Error(`Cannot prepare node-pty@${NODE_PTY_VERSION}: uname-is-linux is not installed`)
  const nodeGyp = nodeGypPath()
  if (!nodeGyp) throw new Error(`Cannot prepare node-pty@${NODE_PTY_VERSION}: node-gyp is not available`)

  console.log(`[prepare-node-pty] building node-pty@${NODE_PTY_VERSION} with uname-is-linux`)
  const result = spawnSync(process.execPath, [nodeGyp, 'rebuild'], {
    cwd: directory,
    env: childEnvironment(preload, true),
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`node-pty@${NODE_PTY_VERSION} build failed with exit code ${String(result.status)}`)
  }
  if (!existsSync(nativeModule)) {
    throw new Error(`node-pty@${NODE_PTY_VERSION} build completed without producing build/Release/pty.node`)
  }
}

async function prepareElfs(packageRoot, roots) {
  if (process.platform !== 'openharmony' || process.arch !== 'arm64') return
  const signer = join(packageRoot, 'lib/elf-self-sign.js')
  // Source installs run the root TypeScript signer after the first package build.
  if (!existsSync(signer)) return

  for (const root of [...new Set(roots)]) {
    const result = spawnSync(process.execPath, [signer, 'prepare', root], {
      cwd: packageRoot,
      stdio: 'inherit',
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`ELF preparation failed with exit code ${String(result.status)}`)
  }
}

async function main() {
  const packageRootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const roots = [packageRootDirectory]
  if (process.env.INIT_CWD) roots.push(resolve(process.env.INIT_CWD))
  prepareKoffi(roots, packageRootDirectory)
  prepareNodePty(roots)
  await prepareElfs(packageRootDirectory, roots)
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
