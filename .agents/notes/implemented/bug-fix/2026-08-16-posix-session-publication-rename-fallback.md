# Agent Note: no-replace publication survives OpenHarmony hard-link restrictions

Status: implemented

English | [中文](2026-08-16-posix-session-publication-rename-fallback.zh.md)

## Problem

Several file-backed stores published staged files with `link()` so a competing creator could not overwrite an already committed file. OpenHarmony HMFS accepts the temporary file write but denies the hard-link operation with `EACCES`, so attachment, guarded-file, and first-session publication could fail even though the process owned the directory and had already synced the staged file.

## Decision

The shared `publishNoReplace()` helper still tries the hard-link publication first. When the filesystem reports `EACCES`, `EPERM`, `ENOTSUP`, or `EOPNOTSUPP`, Linux and OpenHarmony call `renameat2(RENAME_NOREPLACE)` through Koffi. Other link failures, including `EEXIST`, remain errors. Consumers keep their existing directory fsync and cleanup sequences, while ordinary POSIX hosts retain the hard-link path.

## Alternatives considered

**Require hard-link support on every POSIX filesystem.** Rejected because OpenHarmony HMFS can write and sync the session file but refuses this publication primitive, making an otherwise usable local backend fail at the first append.

**Always use `rename()` on POSIX.** Rejected because rename replaces an existing destination and would remove the no-overwrite race protection on Linux and other filesystems that support hard links.

**Change permissions or move the session root.** Rejected because the observed directory is already owned by the process with owner-only permissions; the failure is the filesystem's hard-link policy, not an ordinary access-bit defect.

## Consequences

OpenHarmony-like filesystems can publish staged files without changing the no-overwrite guarantee. Hosts with hard-link support keep the existing first attempt; Koffi is loaded only when the filesystem rejects that attempt. A missing `renameat2` implementation still fails explicitly rather than silently replacing a target.

## Testing

The atomic-write, guarded-file, and Zstandard JSONL tests cover the shared fallback, including injected `EACCES` hard-link failures and collision handling. The OpenHarmony host probe confirmed `renameat2(RENAME_NOREPLACE)` returns success for a missing target and `EEXIST` without changing either file for an existing target.
