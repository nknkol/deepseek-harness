# Agent Note: 不覆盖发布兼容 OpenHarmony 的硬链接限制

Status: implemented

[English](2026-08-16-posix-session-publication-rename-fallback.md) | 中文

## Problem

多个文件型后端使用 `link()` 发布暂存文件，使并发创建者无法覆盖已经提交的文件。OpenHarmony HMFS 可以接受临时文件写入，却以 `EACCES` 拒绝硬链接操作，因此附件、带防护文件创建和第一次会话发布即使进程拥有目录、且已经同步暂存文件，仍然可能失败。

## Decision

共享的 `publishNoReplace()` 辅助函数仍然首先尝试硬链接发布。如果文件系统报告 `EACCES`、`EPERM`、`ENOTSUP` 或 `EOPNOTSUPP`，Linux 和 OpenHarmony 就通过 Koffi 调用 `renameat2(RENAME_NOREPLACE)`。其他 link 错误（包括 `EEXIST`）仍然作为错误抛出。各消费方保留现有的目录 fsync 与清理顺序，普通 POSIX 主机继续使用硬链接路径。

## Alternatives considered

**要求每个 POSIX 文件系统都支持硬链接。** 否决，因为 OpenHarmony HMFS 可以写入并同步会话文件，却拒绝这种发布原语，会让本来可用的本地后端在第一次 append 时失败。

**POSIX 始终使用 `rename()`。** 否决，因为 rename 会替换已存在的目标，从而在 Linux 及其他支持硬链接的文件系统上移除无覆盖竞态保护。

**修改权限或移动会话根目录。** 否决，因为当前目录已经属于进程用户且使用仅所有者权限；该失败来自文件系统的硬链接策略，而不是普通访问位缺陷。

## Consequences

OpenHarmony 类文件系统现在可以发布暂存文件，同时保持不覆盖保证。支持硬链接的主机仍然先使用原有路径；只有文件系统拒绝该路径时才加载 Koffi。如果系统没有 `renameat2` 实现，操作会明确失败，不会静默替换目标。

## Testing

atomic-write、带防护文件和 Zstandard JSONL 测试覆盖共享回退，包括注入 `EACCES` 硬链接失败和冲突处理。OpenHarmony 主机探针已确认：目标不存在时 `renameat2(RENAME_NOREPLACE)` 成功，目标存在时返回 `EEXIST` 且两个文件均不改变。
