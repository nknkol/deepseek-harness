# Agent Note: 本机全局部署使用隔离的 workspace 产物

Status: implemented

[English](2026-08-16-local-global-deployment-uses-isolated-workspace-artifact.md) | 中文

## Problem

只安装 CLI tarball 无法携带已修改的兄弟 workspace 包，而 `pnpm deploy` 会为 peer-only 包留下 workspace 链接，也不会物化 `@deepseek-ai/cordis-plugin-group` 这类运行时 peer。于是全局命令可能回到源代码目录解析，或者在 CLI 启动前失败。

## Decision

`pnpm run deploy:global` 先构建仓库，再把 `@deepseek-ai/dsh` 的依赖树部署到 `dist/local-global/dsh`，随后用 `pnpm install` 恢复根 workspace，并为每个 workspace 包建立运行时副本和解析别名。部署虚拟商店中的第三方包也会从隔离 workspace 包目录建立别名，使复制后的包仍能解析自身的第三方依赖。在 OpenHarmony arm64 上，部署会准备 `koffi` 和 `node-pty`，加入 sharp 的 WASM fallback，并在原生准备移动 `koffi` 后刷新别名。生成的 launcher 会以 `--expose-internals` 启动已安装的 CLI。最后由 npm 把这个目录安装到指定的全局 prefix。

部署产物独立于源代码树，不复制根 `node_modules`。全局 npm 入口可以指向部署目录，但部署目录内没有任何依赖链接回指 `apps/`、`packages/` 或 `vendor/`。

## Alternatives considered

**只安装 CLI tarball。** 否决：一个包的 tarball 不携带已修改的兄弟包，而 npm 也无法在没有发布兄弟版本的情况下解析 workspace-only 依赖集合。

**发布或本地安装所有 workspace tarball。** 否决：这会为一次本机部署增加很大的临时发布面；既然构建后的 workspace 包可以复制进一棵隔离目录，就没有必要这样做。

**保留 `pnpm deploy` 生成的 workspace 链接。** 否决：全局命令会依赖 checkout 始终位于同一路径，且 peer-only workspace 包仍可能缺失。

**复制仓库完整的 `node_modules`。** 否决：这会把开发依赖一并复制，产物可能扩展到数 GB；部署树只需要解析后的运行时闭包和选定的 workspace 包内容。

## Consequences

本机部署继续使用标准的 `pnpm run build` 流程，并支持 npm 默认全局 prefix 或显式的 `--prefix` 路径。它比安装一个包耗时更长，因为需要解析 workspace 运行时闭包，并可能编译 OpenHarmony 原生模块；由于 CLI 有完整插件树和隔离的 workspace 运行时副本，产物也会较大。重复运行会替换全局 `@deepseek-ai/dsh` 安装，并只重新生成 `dist/local-global/dsh`。

## Testing

在 OpenHarmony arm64 上，`node scripts/deploy-global.mjs` 已完成构建、隔离部署、根 workspace 恢复、原生准备、launcher 生成和全局安装。`dsh --version` 输出 `0.1.0-rc.5`；`timeout 25s dsh web --port 0` 输出监听地址并持续运行至有意触发的超时；部署目录内没有链接解析到仓库的 `apps/`、`packages/` 或 `vendor/` 目录。
