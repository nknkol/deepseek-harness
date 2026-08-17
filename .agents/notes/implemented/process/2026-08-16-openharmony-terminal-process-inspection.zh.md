# Agent Note: OpenHarmony 终端进程检查

Status: implemented

[English](2026-08-16-openharmony-terminal-process-inspection.md) | 中文

## 问题

持久终端后端使用 node-pty 处理终端 I/O，并使用进程检查器处理前台进程组就绪状态、信号发送和清理。OpenHarmony 提供现有 Linux 检查器所需的兼容 `/proc` 与 syscall 接口，但 Node 报告的 `process.platform` 是 `openharmony`，因此平台工厂会在 node-pty 提供持久会话之前拒绝该终端。

## 决策

[`createProcessInspector`](../../../../packages/subprocess/subprocess-local/src/process-inspector.ts) 对 `linux` 和 `openharmony` 都选择 Linux `/proc` 检查器。因此 OpenHarmony 终端会保留 node-pty 分配、进程树／会话检查和清理语义。OpenHarmony 没有 `/bin/bash` 时，持久 bash consumer 会从 provider PATH 解析 `bash`。由于 OpenHarmony 在 `/proc/<pid>/stat` 中报告 `tpgid=0`，终端 provider 改为在 node-pty 的 PTY 描述符上调用 `tcgetpgrp()` 获取前台进程组；该查询不可用时安全失败。Linux 架构表仍根据 `process.arch` 选择；不支持的架构继续通过现有探针行为安全失败。

## 替代方案

**将整个 Node 进程伪装为 Linux。** 否决：native 终端构建只需要受限的平台伪装，而运行时平台映射必须继续看到 OpenHarmony。

**在 OpenHarmony 上跳过检查。** 否决：既然所需的 Linux 兼容接口可用，就不应牺牲前台进程组和进程身份保护。

**单独实现 OpenHarmony 检查器。** 否决：现有 `/proc` 与 syscall 语义已经满足 Linux 检查器的输入约定，重复实现会增加第二套行为来源而不增加能力。

## 后果

极简模式的持久 bash 可以在 OpenHarmony arm64 上分配并使用真实的 node-pty 会话，包括前台进程组信号发送。Linux 和 macOS 行为保持不变，不支持的平台继续使用现有错误诊断失败。PTY 描述符仍是本地 provider 的实现细节；如果未来 node-pty 删除该 fd，provider 必须继续安全失败，或将 `tcgetpgrp()` 移入 node-pty 支持的 native API。
