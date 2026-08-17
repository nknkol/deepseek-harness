# Agent Note: Automatic OpenHarmony native ELF preparation

Status: implemented

English | [中文](2026-08-15-openharmony-native-elf-preparation.zh.md)

## Problem

OpenHarmony arm64 installs prebuilt native Node addons and host tools as ELF files that require a valid self-sign section before they can be loaded or executed. Package installation can also leave those files without an executable permission, so a valid signature alone does not make an artifact usable. A modified ELF must be detected by checking its signed contents rather than by checking whether `.codesign` exists.

## Decision

[`scripts/elf-self-sign.ts`](../../../../scripts/elf-self-sign.ts) is the single implementation for ELF verification, signing, and workspace preparation. Its `prepare` command runs only on OpenHarmony arm64, scans OpenHarmony `.node` files, the mapped `lefthook-linux-arm64/bin/lefthook` executable, the mapped `oxlint-tsgolint/linux-arm64/tsgolint` executable, and the compiled `node-pty` release artifacts below `node_modules`, verifies the Merkle root and self-sign digest, re-signs invalid files in place, signs files without `.codesign`, and restores execute permission. Existing valid files are left cryptographically unchanged.

The root `postinstall` script invokes `prepare-native-elfs` before installing the Git hooks, and `build:lib:host` invokes it before TypeScript and tsdown load native bindings. On OpenHarmony, pnpm maps the available `lefthook-linux-arm64` package to the platform name expected by Lefthook. The `with-harmonybrew-libs.mjs` launcher passes the Homebrew library directory only to these child processes, so system commands do not inherit the project dependency path. The user-facing workflow remains `pnpm install` followed by `pnpm run build`; non-OpenHarmony hosts skip preparation.

On OpenHarmony arm64, pnpm skips Koffi's unsupported native install script. The root `postinstall` runs `scripts/prepare-koffi.mjs`, which invokes Koffi's original CMake command with Homebrew's `uname-is-linux` library only when its native output is absent. It also runs `scripts/prepare-node-pty.mjs`, which invokes node-pty's original node-gyp build with the same library only when `build/Release/pty.node` is absent. The spoof is scoped to each build child process; it does not alter the platform reported to the rest of the workspace. This makes a normal `pnpm install` repair incomplete Koffi and node-pty installations while leaving every other package lifecycle script unchanged.

When an existing `.codesign` section is structurally valid, re-signing clears and rewrites only its 4 KiB page. When the section is absent, signing appends the section and the required section metadata while copying the original ELF contents unchanged.

## Alternatives considered

**Manual removal of `.codesign` before every re-sign.** Rejected: a modified ELF must be detected and repaired by the preparation command, without requiring a separate section-removal step that can be omitted by an install or build path.

**Checking only the self-sign flag or section name.** Rejected: those fields do not prove that the ELF contents, Merkle root, descriptor, and self-sign digest still agree.

**A separate platform-specific wrapper around the signer.** Rejected: keeping preparation in the copied single-file TypeScript tool gives Node callers and the CLI the same signing and verification implementation.

## Consequences

OpenHarmony native addons are prepared automatically at installation and immediately before the first host build tool loads them. Repeated preparation is idempotent: valid signatures are retained, invalid signatures are replaced, and permissions are repaired independently. Linux, macOS, Windows, and other hosts do not scan or modify their native artifacts. The preparation step adds a small recursive scan of `node_modules` to the OpenHarmony install and host-build paths.
