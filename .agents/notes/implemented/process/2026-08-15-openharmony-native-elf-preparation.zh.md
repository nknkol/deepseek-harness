# Agent Note: 自动准备 OpenHarmony native ELF

Status: implemented

[English](2026-08-15-openharmony-native-elf-preparation.md) | 中文

## 问题

OpenHarmony arm64 会将 Node native addon 和 host 工具作为预构建 ELF 文件安装；加载或执行它们前要求文件包含有效的 self-sign section。安装过程还可能让这些文件缺少可执行权限，因此有效签名本身并不能保证 artifact 可用。ELF 被修改后，必须校验签名内容，而不能只检查 `.codesign` 是否存在。

## 决策

[`scripts/elf-self-sign.ts`](../../../../scripts/elf-self-sign.ts) 是 ELF 校验、签名和工作区准备的唯一实现。它的 `prepare` 命令只在 OpenHarmony arm64 上运行，扫描 `node_modules` 下的 OpenHarmony `.node` 文件、映射后的 `lefthook-linux-arm64/bin/lefthook` 可执行文件、映射后的 `oxlint-tsgolint/linux-arm64/tsgolint` 可执行文件和已编译的 `node-pty` release artifact，校验 Merkle root 与 self-sign digest，在文件无效时原地重新签名，在缺少 `.codesign` 时添加签名，并恢复执行权限。已有有效签名的文件保持密码学内容不变。

根目录的 `postinstall` 脚本会在安装 Git 钩子前调用 `prepare-native-elfs`，`build:lib:host` 会在 TypeScript 和 tsdown 加载 native binding 前调用它。在 OpenHarmony 上，pnpm 会将现有的 `lefthook-linux-arm64` 包映射为 Lefthook 所请求的平台名称。`with-harmonybrew-libs.mjs` 只向这些子进程传递 Homebrew 库目录，因此系统命令不会继承项目依赖路径。用户侧流程仍然是 `pnpm install` 后执行 `pnpm run build`；非 OpenHarmony 主机会跳过准备步骤。

在 OpenHarmony arm64 上，pnpm 会跳过 Koffi 不受支持的 native 安装脚本。根目录 `postinstall` 还会运行 `scripts/prepare-koffi.mjs`，仅在 Koffi 缺少 native 产物时通过 Homebrew 的 `uname-is-linux` 库调用其原有的 CMake 命令；同时运行 `scripts/prepare-node-pty.mjs`，仅在缺少 `build/Release/pty.node` 时通过同一个库调用 node-pty 原有的 node-gyp 构建。伪装只作用于各自的构建子进程，不会改变工作区其余部分看到的平台。这样普通的 `pnpm install` 就能修复未完成的 Koffi 和 node-pty 安装，同时其他包的生命周期脚本保持不变。

当已有 `.codesign` section 的结构有效时，重新签名只清空并重写它的 4 KiB 页面。当 section 不存在时，签名器会追加 section 和所需的 section 元数据，同时原样复制原始 ELF 内容。

## 替代方案

**每次重新签名前手动移除 `.codesign`。** 否决：ELF 被修改后应由准备命令检测并修复，不应要求安装或构建路径额外执行一个可能被遗漏的移除 section 步骤。

**只检查 self-sign flag 或 section 名称。** 否决：这些字段不能证明 ELF 内容、Merkle root、descriptor 与 self-sign digest 仍然一致。

**在签名器外单独维护平台包装脚本。** 否决：将准备逻辑保留在复制过来的单文件 TypeScript 工具中，可以让 Node 调用方和 CLI 使用同一份签名与校验实现。

## 后果

OpenHarmony native addon 会在安装时以及 host 构建工具首次加载前自动准备。重复准备是幂等的：有效签名会保留，无效签名会被替换，权限会独立修复。Linux、macOS、Windows 和其他主机不会扫描或修改自己的 native artifact。准备步骤会给 OpenHarmony 的安装和 host 构建路径增加一次对 `node_modules` 的小范围递归扫描。
