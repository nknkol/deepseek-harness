# Agent Note: OpenHarmony node-pty 源码构建

Status: implemented

[English](2026-08-16-openharmony-node-pty-source-build.md) | 中文

## 问题

node-pty@1.1.0 没有提供 OpenHarmony arm64 native 包。它的安装脚本在没有匹配预构建产物时会回退到 node-gyp，但构建系统看到的是 OpenHarmony，因此不能直接使用这个回退路径。

## 决策

[`packages/subprocess/subprocess-local/scripts/prepare-native.mjs`](../../../../packages/subprocess/subprocess-local/scripts/prepare-native.mjs) 只在 OpenHarmony arm64 上运行。发布包安装时，Koffi 作为 optional dependency，因此其不兼容的安装失败不会中止包生命周期；`postinstall` 会清除失败的构建缓存，使用 Homebrew 的 `uname-is-linux` preload 调用 Koffi 原有的源码构建，并在调用 node-pty 原有的 node-gyp 构建前将已准备好的 Koffi 包移动到发布提供方的私有依赖目录。preload 只属于这次构建子进程；工作区和无关的包脚本继续看到真实的 OpenHarmony 平台。根准备包装脚本和发布包会调用同一套构建函数，再执行 ELF 准备。

[`scripts/elf-self-sign.ts`](../../../../scripts/elf-self-sign.ts) 会和其他 native artifact 一起校验并自签名生成的 node-pty ELF。发布包携带相同实现的 `lib/elf-self-sign.js`，因此其 `postinstall` 不依赖工作区的 `tsx` 启动器。它校验签名内容，而不是只接受 `.codesign` 存在，并且独立恢复执行权限。

## 替代方案

**伪装整个 pnpm 或 Node 进程为 Linux。** 否决：包解析和无关生命周期脚本必须继续看到 OpenHarmony，才能保持平台映射与 OpenHarmony 专用处理。

**依赖 node-pty 的 OpenHarmony 预构建包。** 否决：所需包没有发布，而现有源码构建已经提供 native 实现。

**运行 `npm rebuild node-pty`。** 否决：npm 还会运行 node-pty 的 TypeScript `prepare` 步骤；该步骤与 native 编译无关，并且在仓库当前 TypeScript 设置下失败。直接调用 node-gyp 可以保留包原有的 native 构建路径，同时避开额外的生命周期步骤。

## 后果

在 OpenHarmony arm64 上，`pnpm install` 和 `pnpm run build` 可以自动准备 node-pty，不需要手动重复 rebuild。首次源码构建需要本地 node-gyp、Python、Node headers、编译器和 Homebrew `uname-is-linux` 安装。其他主机继续使用包原有的预构建与安装流程。
