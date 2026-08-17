# Agent Note: OpenHarmony node-pty source build

Status: implemented

English | [中文](2026-08-16-openharmony-node-pty-source-build.zh.md)

## Problem

node-pty@1.1.0 does not provide an OpenHarmony arm64 native package. Its install script falls back to node-gyp when no matching prebuild exists, but the build system sees OpenHarmony instead of Linux and cannot use that fallback directly.

## Decision

[`packages/subprocess/subprocess-local/scripts/prepare-native.mjs`](../../../../packages/subprocess/subprocess-local/scripts/prepare-native.mjs) runs only on OpenHarmony arm64. In a published install, Koffi is an optional dependency so its incompatible install failure does not abort the package lifecycle; `postinstall` then clears its failed build cache, invokes Koffi's original source build with Homebrew's `uname-is-linux` preload, and moves the prepared package under the published provider's private dependency directory before invoking node-pty's original node-gyp build. The preload belongs only to that build child process; the workspace and unrelated package scripts retain the real OpenHarmony platform. The root preparation wrappers and the published package call the same build functions before ELF preparation.

[`scripts/elf-self-sign.ts`](../../../../scripts/elf-self-sign.ts) verifies and self-signs the resulting node-pty ELF alongside the other native artifacts. The published package carries the same implementation as `lib/elf-self-sign.js`, so its `postinstall` does not require the workspace's `tsx` launcher. It validates the signed contents rather than accepting the presence of `.codesign` alone, and it restores executable permission independently of signing.

## Alternatives considered

**Spoof Linux for the whole pnpm or Node process.** Rejected: package resolution and unrelated lifecycle scripts must continue to observe OpenHarmony so platform mappings and OpenHarmony-specific handling remain active.

**Depend on a node-pty OpenHarmony prebuild.** Rejected: the required package is not published, and the available source build already supplies the native implementation.

**Run `npm rebuild node-pty`.** Rejected: npm also runs node-pty's TypeScript `prepare` step, which is unrelated to native compilation and fails under the repository's current TypeScript settings. Calling node-gyp directly preserves the package's native build path without that extra lifecycle step.

## Consequences

`pnpm install` and `pnpm run build` can prepare node-pty without a manually repeated rebuild on OpenHarmony arm64. The first source build requires the local node-gyp, Python, Node headers, compiler, and Homebrew `uname-is-linux` installation. Other hosts keep the package's normal prebuild/install behavior.
