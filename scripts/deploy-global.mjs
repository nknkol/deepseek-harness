#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const deploymentDirectory = resolve(root, 'dist/local-global/dsh')

function usage() {
  console.log('usage: pnpm run deploy:global [-- --prefix <npm-prefix>]')
  console.log('       --prefix selects the npm global prefix; the default is npm\'s configured global prefix')
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: root,
    stdio: 'inherit',
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !options.allowStatuses?.includes(result.status)) {
    throw new Error(`${commandName} ${args.join(' ')} failed with exit code ${String(result.status)}`)
  }
}

function parsePrefix(args) {
  let prefix
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '--') continue
    if (argument === '--help' || argument === '-h') {
      usage()
      process.exit(0)
    }
    if (argument === '--prefix') {
      prefix = args[++index]
      if (!prefix) throw new Error('--prefix requires an npm prefix path')
      continue
    }
    if (argument.startsWith('--prefix=')) {
      prefix = argument.slice('--prefix='.length)
      if (!prefix) throw new Error('--prefix requires an npm prefix path')
      continue
    }
    throw new Error(`unknown option: ${argument}`)
  }
  return prefix === undefined ? undefined : resolve(process.cwd(), prefix)
}

function withHarmonybrew(commandName, args, options = {}) {
  command(process.execPath, ['scripts/with-harmonybrew-libs.mjs', commandName, ...args], options)
}

function copyRuntimePackage(source, destination) {
  if (existsSync(destination)) return
  const sourceDirectory = realpathSync(source)
  cpSync(sourceDirectory, destination, {
    recursive: true,
    filter: (path) => {
      if (path === sourceDirectory) return true
      const relativePath = relative(sourceDirectory, path)
      const segments = relativePath.split(sep)
      const basename = segments.at(-1) ?? ''
      if (segments.includes('node_modules') || segments[0] === 'src' || segments[0] === 'tests' || segments[0] === 'test') {
        return false
      }
      return !basename.startsWith('tsconfig') && !basename.endsWith('.ts') && !basename.endsWith('.tsx') && !basename.endsWith('.map')
    },
  })
}

function findWorkspacePackages() {
  const workspaceRoots = [
    join(root, 'apps'),
    join(root, 'native'),
    join(root, 'packages'),
    join(root, 'vendor'),
  ]
  const packages = new Map()

  function visit(directory) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      try {
        const packageJson = JSON.parse(readFileSync(manifest, 'utf8'))
        if (typeof packageJson.name === 'string') packages.set(packageJson.name, directory)
      } catch {
        // The build already validates package manifests; an unreadable nested manifest is not a deployable package.
      }
      return
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || !entry.isDirectory() || entry.isSymbolicLink()) continue
      visit(join(directory, entry.name))
    }
  }

  for (const workspaceRoot of workspaceRoots) {
    if (existsSync(workspaceRoot)) visit(workspaceRoot)
  }
  return packages
}

function findPackagesInVirtualStore(virtualStore) {
  const packages = new Map()
  if (!existsSync(virtualStore)) return packages

  for (const entry of readdirSync(virtualStore, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    const packageNodeModules = join(virtualStore, entry.name, 'node_modules')
    if (!existsSync(packageNodeModules)) continue
    for (const packageEntry of readdirSync(packageNodeModules, { withFileTypes: true })) {
      if (packageEntry.name === '.pnpm' || (!packageEntry.isDirectory() && !packageEntry.isSymbolicLink())) continue
      const packageRoots = packageEntry.name.startsWith('@')
        ? readdirSync(join(packageNodeModules, packageEntry.name), { withFileTypes: true })
          .filter((nested) => nested.isDirectory() || nested.isSymbolicLink())
          .map((nested) => join(packageNodeModules, packageEntry.name, nested.name))
        : [join(packageNodeModules, packageEntry.name)]
      for (const packageRoot of packageRoots) {
        const manifest = join(packageRoot, 'package.json')
        if (!existsSync(manifest)) continue
        try {
          const packageJson = JSON.parse(readFileSync(manifest, 'utf8'))
          if (typeof packageJson.name === 'string' && !packages.has(packageJson.name)) {
            packages.set(packageJson.name, packageRoot)
          }
        } catch {
          // The deployer already validated the virtual store; ignore an entry without a readable manifest.
        }
      }
    }
  }
  return packages
}

function findDeployedPackages(deploymentDirectory) {
  return findPackagesInVirtualStore(join(deploymentDirectory, 'node_modules/.pnpm'))
}

function rewriteWorkspaceLinks(deploymentDirectory) {
  const localRoot = join(deploymentDirectory, '.workspace-packages')
  const workspaceRoots = [
    join(root, 'apps'),
    join(root, 'native'),
    join(root, 'packages'),
    join(root, 'vendor'),
  ]
  const workspacePackages = findWorkspacePackages()
  const deployedPackages = findDeployedPackages(deploymentDirectory)
  const copies = new Map()

  function localPackage(source) {
    let destination = copies.get(source)
    if (destination !== undefined) return destination
    const name = relative(root, source).split(sep).join('__')
    destination = join(localRoot, name)
    mkdirSync(localRoot, { recursive: true })
    copyRuntimePackage(source, destination)
    copies.set(source, destination)
    return destination
  }

  function linkPackage(link, destination) {
    mkdirSync(dirname(link), { recursive: true })
    rmSync(link, { recursive: true, force: true })
    symlinkSync(relative(dirname(link), destination), link)
  }

  // Peer-only workspace packages are absent from pnpm deploy output. Make every
  // workspace package available from both the deployed root and local copies'
  // shared node_modules directory so ESM resolution does not depend on the checkout.
  for (const [packageName, source] of workspacePackages) {
    const destination = localPackage(source)
    linkPackage(join(deploymentDirectory, 'node_modules', ...packageName.split('/')), destination)
    linkPackage(join(localRoot, 'node_modules', ...packageName.split('/')), destination)
  }
  for (const [packageName, destination] of deployedPackages) {
    if (workspacePackages.has(packageName)) continue
    linkPackage(join(localRoot, 'node_modules', ...packageName.split('/')), destination)
  }
  if (process.platform === 'openharmony' && process.arch === 'arm64') {
    const installedPackages = findPackagesInVirtualStore(join(root, 'node_modules/.pnpm'))
    for (const packageName of ['@img/sharp-wasm32', '@emnapi/runtime']) {
      const source = installedPackages.get(packageName)
      if (source === undefined) continue
      const destination = join(localRoot, `.external-${packageName.replaceAll('/', '__')}`)
      copyRuntimePackage(source, destination)
      linkPackage(join(deploymentDirectory, 'node_modules', ...packageName.split('/')), destination)
      linkPackage(join(localRoot, 'node_modules', ...packageName.split('/')), destination)
    }
  }

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        let target
        try {
          target = realpathSync(path)
        } catch {
          continue
        }
        if (!workspaceRoots.some((workspaceRoot) => target.startsWith(`${workspaceRoot}${sep}`))) continue
        if (!existsSync(join(target, 'package.json'))) continue
        const destination = localPackage(target)
        rmSync(path)
        symlinkSync(relative(dirname(path), destination), path)
        continue
      }
      if (entry.isDirectory()) visit(path)
    }
  }

  visit(join(deploymentDirectory, 'node_modules'))
}

function installGlobal(deploymentDirectory, prefix) {
  const npmPrefixArguments = prefix === undefined ? [] : ['--prefix', prefix]
  withHarmonybrew('npm', [
    'uninstall', '--global', ...npmPrefixArguments, '@deepseek-ai/dsh',
  ], {
    // npm exits non-zero when the package is not installed yet.
    stdio: 'ignore',
    allowStatuses: [1],
  })
  withHarmonybrew('npm', [
    'install', '--global', '--force', ...npmPrefixArguments, deploymentDirectory,
  ])
  console.log(`Installed @deepseek-ai/dsh from ${deploymentDirectory}`)
  console.log(prefix === undefined ? 'npm global prefix: default' : `npm global prefix: ${prefix}`)
}

function prepareDeploymentLauncher(deploymentDirectory) {
  const manifestPath = join(deploymentDirectory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (typeof manifest.bin !== 'object' || manifest.bin === null || typeof manifest.bin.dsh !== 'string') {
    throw new Error(`deployed package has no dsh bin: ${manifestPath}`)
  }
  const launcherPath = join(deploymentDirectory, 'lib/dsh-launcher.js')
  writeFileSync(launcherPath, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const result = spawnSync(process.execPath, ['--expose-internals', fileURLToPath(new URL('./bin.js', import.meta.url)), ...process.argv.slice(2)], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
`)
  manifest.bin.dsh = 'lib/dsh-launcher.js'
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function containsFile(directory, filename) {
  if (!existsSync(directory)) return false
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isFile() && entry.name === filename) return true
    if (entry.isDirectory() && containsFile(path, filename)) return true
  }
  return false
}

function prepareDeploymentNative(deploymentDirectory) {
  const packageName = '@deepseek-ai/dsh-subprocess-local'
  const directPackageRoot = join(deploymentDirectory, 'node_modules', packageName)
  const virtualStore = join(deploymentDirectory, 'node_modules/.pnpm')
  const packageRoots = existsSync(virtualStore)
    ? readdirSync(virtualStore, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(virtualStore, entry.name, 'node_modules', packageName))
    : []
  const packageRootLink = [directPackageRoot, ...packageRoots].find((candidate) => {
    const manifest = join(candidate, 'package.json')
    if (!existsSync(manifest)) return false
    try {
      return JSON.parse(readFileSync(manifest, 'utf8')).name === packageName
    } catch {
      return false
    }
  })
  if (packageRootLink === undefined) {
    throw new Error(`missing deployed package: ${packageName}`)
  }
  const packageRoot = realpathSync(packageRootLink)
  const script = join(packageRoot, 'scripts/prepare-native.mjs')
  if (!existsSync(script)) throw new Error(`missing native preparation script: ${script}`)
  withHarmonybrew(process.execPath, [script], {
    env: { ...process.env, INIT_CWD: deploymentDirectory },
  })
  if (process.platform !== 'openharmony' || process.arch !== 'arm64') return

  const localPackageRoot = join(deploymentDirectory, '.workspace-packages/packages__subprocess__subprocess-local')
  const nativeRoots = (name) => {
    const candidates = [
      join(localPackageRoot, 'node_modules', name),
      findDeployedPackages(deploymentDirectory).get(name),
    ]
    return candidates
      .filter((candidate) => candidate !== undefined && existsSync(candidate))
      .map((candidate) => realpathSync(candidate))
  }
  const nativeReady = () => nativeRoots('koffi').some((candidate) => containsFile(candidate, 'koffi.node'))
    && nativeRoots('node-pty').some((candidate) => containsFile(candidate, 'pty.node'))
  if (!nativeReady()) {
    command(process.execPath, [script], {
      env: { ...process.env, INIT_CWD: deploymentDirectory },
    })
  }
  const preparedKoffi = join(localPackageRoot, 'node_modules/koffi')
  if (existsSync(preparedKoffi)) {
    for (const link of [
      join(deploymentDirectory, 'node_modules/koffi'),
      join(deploymentDirectory, '.workspace-packages/node_modules/koffi'),
    ]) {
      mkdirSync(dirname(link), { recursive: true })
      rmSync(link, { recursive: true, force: true })
      symlinkSync(relative(dirname(link), preparedKoffi), link)
    }
  }
  if (!nativeReady()) throw new Error('deployed koffi and node-pty native modules are not prepared')
}

try {
  const prefix = parsePrefix(process.argv.slice(2))

  command('pnpm', ['run', 'build'], { env: { ...process.env, CI: 'true' } })

  rmSync(deploymentDirectory, { recursive: true, force: true })
  try {
    withHarmonybrew('pnpm', [
      '--filter', '@deepseek-ai/dsh',
      'deploy', '--legacy', '--ignore-scripts', deploymentDirectory,
    ], {
      env: { ...process.env, CI: 'true' },
    })
  } finally {
    command('pnpm', ['install'], { env: { ...process.env, CI: 'true' } })
  }
  rewriteWorkspaceLinks(deploymentDirectory)
  prepareDeploymentNative(deploymentDirectory)
  prepareDeploymentLauncher(deploymentDirectory)
  installGlobal(deploymentDirectory, prefix)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
