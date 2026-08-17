# Agent Note: OpenHarmony tsgolint 包映射

Status: implemented

[English](2026-08-16-openharmony-tsgolint-package-mapping.md) | 中文

## 问题

仓库启用了 Oxlint 的类型感知模式，但 `oxlint-tsgolint@7.0.2001` 只发布 Linux、macOS 和 Windows 平台包，没有 OpenHarmony arm64 包。它的启动器根据 `process.platform` 解析平台包，也没有源码编译或跨平台回退流程，因此在 OpenHarmony 上安装后无法解析所需的 `tsgolint` 可执行文件。

## 决策

在 OpenHarmony arm64 上，pnpm 为 `oxlint-tsgolint@7.0.2001` 增加 `@oxlint-tsgolint/openharmony-arm64` 包别名，将其指向已发布的 `@oxlint-tsgolint/linux-arm64@7.0.2001` 包。`.pnpmfile.cjs` 中的平台钩子允许该 Linux 包在 OpenHarmony 上安装。运行时平台保持不变；只有现有启动器请求的包名被映射。

映射后的 Linux arm64 `tsgolint` 可执行文件会加入 `scripts/elf-self-sign.ts prepare`，在 lint 或其他 host 工具调用它之前校验 self-sign digest 并恢复执行权限。映射限定具体版本，因此上游包布局变化时不会静默选择无关的二进制文件。

## 考虑过的替代方案

**让 lint 进程使用 `uname-is-linux`。** 拒绝：修改进程平台会影响 Oxlint 进程中的所有平台相关依赖，而当前缺失的能力只是一个包查找。

**在 OpenHarmony 上关闭类型感知 lint。** 拒绝：仓库配置的 TypeScript 规则包含 floating-promise 和 thenable 等类型感知检查；关闭该模式会使本地 lint 结果弱于受支持主机上的结果。

**安装时从源码编译 `tsgolint`。** 拒绝：已发布包只包含各平台预构建可执行文件，没有安装时编译回退。映射经过测试的静态 Linux arm64 可执行文件，可以保持普通 `pnpm install` 和 lint 流程不变。

## 后果

OpenHarmony arm64 在执行 `pnpm install` 后可以运行与其他支持主机相同的类型感知 Oxlint 命令。Linux 可执行文件必须与 OpenHarmony 运行时兼容，并且必须在执行前完成签名；包管理器不会提供这两项保证，因此由准备步骤校验。其他平台继续使用上游的平台包选择。

## 测试

在 OpenHarmony arm64 上，`pnpm install --force --ignore-scripts --no-frozen-lockfile` 创建了包别名，`tsgolint --help` 通过该别名成功执行，`scripts/elf-self-sign.ts prepare` 校验了映射后的可执行文件并恢复了其执行权限。
