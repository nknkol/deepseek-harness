# Agent Note: OpenHarmony tsgolint package mapping

Status: implemented

English | [中文](2026-08-16-openharmony-tsgolint-package-mapping.zh.md)

## Problem

The repository enables Oxlint's type-aware mode, but `oxlint-tsgolint@7.0.2001` publishes Linux, macOS, and Windows platform packages without an OpenHarmony arm64 package. Its launcher resolves the platform package from `process.platform` and has no source-compilation or cross-platform fallback, so OpenHarmony installation leaves the required `tsgolint` executable unresolved.

## Decision

On OpenHarmony arm64, pnpm adds the package alias `@oxlint-tsgolint/openharmony-arm64` to `oxlint-tsgolint@7.0.2001`, targeting the published `@oxlint-tsgolint/linux-arm64@7.0.2001` package. The `.pnpmfile.cjs` platform hook permits that Linux package to be installed on OpenHarmony. The runtime platform remains unchanged; only the package name requested by the existing launcher is mapped.

The mapped Linux arm64 `tsgolint` executable is included in `scripts/elf-self-sign.ts prepare`, which verifies its self-sign digest and restores execute permission before lint or other host tools invoke it. The mapping is version-specific so an upstream package layout change does not silently select an unrelated binary.

## Alternatives considered

**Use `uname-is-linux` for the lint process.** Rejected: changing the process platform would affect every platform-sensitive dependency in the Oxlint process, while the missing capability is one package lookup.

**Disable type-aware linting on OpenHarmony.** Rejected: the repository's configured TypeScript rules include type-aware checks such as floating-promise and thenable diagnostics; disabling the mode would make the local lint result weaker than the supported-host result.

**Compile `tsgolint` from source during installation.** Rejected: the published package contains only prebuilt platform executables and exposes no installation-time compiler fallback. Mapping the tested static Linux arm64 executable keeps the normal `pnpm install` and lint workflow intact.

## Consequences

OpenHarmony arm64 can run the same type-aware Oxlint command as the other supported hosts after `pnpm install`. The Linux executable must remain compatible with the OpenHarmony runtime and must be signed before execution; the preparation step validates both conditions that the package manager does not provide. Other platforms keep the upstream package selection unchanged.

## Testing

On OpenHarmony arm64, `pnpm install --force --ignore-scripts --no-frozen-lockfile` created the package alias, `tsgolint --help` executed through that alias, and `scripts/elf-self-sign.ts prepare` verified and made the mapped executable runnable.
