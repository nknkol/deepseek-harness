# Agent Note: Local global deployment uses an isolated workspace artifact

Status: implemented

English | [中文](2026-08-16-local-global-deployment-uses-isolated-workspace-artifact.zh.md)

## Problem

Installing the CLI tarball alone cannot provide the modified sibling workspace packages, while `pnpm deploy` leaves workspace links for peer-only packages and does not materialize a runtime-only peer such as `@deepseek-ai/cordis-plugin-group`. A global command installed from that tree can therefore resolve into the source checkout or fail before the CLI starts.

## Decision

`pnpm run deploy:global` builds the repository, deploys the `@deepseek-ai/dsh` dependency tree into `dist/local-global/dsh`, restores the root workspace with `pnpm install`, and materializes runtime copies and aliases for every workspace package. External packages in the deployed virtual store are aliased from the isolated workspace package directory so copied packages retain their third-party dependencies. On OpenHarmony arm64, the deployment prepares `koffi` and `node-pty`, includes the sharp WASM fallback, and refreshes the `koffi` alias after preparation moves its package. A generated launcher starts the installed CLI with `--expose-internals`. npm installs this directory at the configured global prefix.

The deployment artifact is separate from the source tree and does not copy the root `node_modules`. The global npm entry may point to the deployment directory, but no dependency link in that directory points back to `apps/`, `packages/`, or `vendor/`.

## Alternatives considered

**Install only the CLI tarball.** Rejected: sibling packages with local fixes are not carried with one package tarball, and npm cannot resolve the workspace-only dependency set without published sibling versions.

**Publish or locally install every workspace tarball.** Rejected: this adds a large temporary release surface for a local deployment and is unnecessary when the built workspace packages can be copied into one isolated tree.

**Keep the `pnpm deploy` workspace links.** Rejected: the global command would depend on the checkout remaining at the same path, and peer-only workspace packages can remain absent from the deployed dependency tree.

**Copy the repository's complete `node_modules`.** Rejected: it copies development dependencies and can expand the artifact to several gigabytes; the deployment tree only needs the resolved runtime closure and selected workspace package payloads.

## Consequences

The local deployment command keeps the normal `pnpm run build` path and supports npm's default global prefix or an explicit `--prefix` path. Deployment takes longer than installing one package because it resolves the workspace runtime closure and may compile OpenHarmony native modules. The artifact is large because the CLI intentionally carries its plugin tree and isolated workspace runtime copies. Re-running the command replaces the global `@deepseek-ai/dsh` installation and regenerates only `dist/local-global/dsh`.

## Testing

On OpenHarmony arm64, `node scripts/deploy-global.mjs` completed build, isolated deployment, root restoration, native preparation, launcher generation, and global installation. `dsh --version` printed `0.1.0-rc.5`; `timeout 25s dsh web --port 0` printed a listening URL and remained running until the intentional timeout; and no deployment link resolved into the repository's `apps/`, `packages/`, or `vendor/` directories.
