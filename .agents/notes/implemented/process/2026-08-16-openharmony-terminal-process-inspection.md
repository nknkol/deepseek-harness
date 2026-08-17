# Agent Note: OpenHarmony terminal process inspection

Status: implemented

English | [中文](2026-08-16-openharmony-terminal-process-inspection.zh.md)

## Problem

The persistent terminal backend uses node-pty for terminal I/O and a process inspector for foreground-group readiness, signalling, and cleanup. OpenHarmony exposes the Linux-compatible `/proc` and syscall interfaces needed by the existing Linux inspector, but Node reports `process.platform` as `openharmony`, so the platform factory rejected the terminal before node-pty could serve a persistent session.

## Decision

[`createProcessInspector`](../../../../packages/subprocess/subprocess-local/src/process-inspector.ts) selects the Linux `/proc` inspector for both `linux` and `openharmony`. OpenHarmony terminal sessions retain node-pty allocation, process-tree/session inspection, and cleanup semantics. The persistent bash consumer resolves `bash` from the provider PATH when its `/bin/bash` default is absent on OpenHarmony. Because OpenHarmony reports `tpgid=0` in `/proc/<pid>/stat`, the terminal provider reads the foreground process group with `tcgetpgrp()` on node-pty's PTY descriptor and fails closed when that lookup is unavailable. The Linux architecture tables remain selected from `process.arch`; unsupported architectures still fail closed through the existing probe behavior.

## Alternatives considered

**Spoof the whole Node process as Linux.** Rejected: the native terminal build only needs a scoped platform shim, while runtime platform mapping must continue to observe OpenHarmony.

**Skip inspection on OpenHarmony.** Rejected: readiness and termination would lose foreground-group and process-identity protections even though the required Linux-compatible interfaces are available.

**Create a separate OpenHarmony inspector.** Rejected: the available `/proc` and syscall semantics are the Linux inspector's input contract, so a duplicate implementation would add a second source of behavior without adding capability.

## Consequences

The minimal persistent-bash preset can allocate and use a real node-pty session on OpenHarmony arm64, including foreground-group signal delivery. Linux and macOS behavior is unchanged, and unsupported platforms continue to fail with the existing diagnostic. The PTY descriptor remains an implementation detail of the local provider; if a future node-pty version removes its fd, the provider must retain the fail-closed behavior or move the `tcgetpgrp()` call into a supported native node-pty API.
