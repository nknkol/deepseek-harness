/**
 * Atomic file replacement, no-replace publication, and writer coordination.
 * `writeFileAtomic` writes a random-suffix sibling with exclusive create and
 * the caller's permission bits, then renames it over the target, so readers
 * observe either the old or the new complete content and a replaced file ends
 * up with exactly the stated mode. `withFileLock` serializes cross-process
 * writers of one file through a `wx`-created `<file>.lock` sibling, so a
 * read-modify-write cycle can never resurrect a state another writer just
 * replaced; readers stay lock-free because the rename commit is atomic.
 * @module @deepseek-ai/dsh-atomic-write
 */

import { randomBytes } from 'node:crypto'
import { link, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Filesystem options for {@link writeFileAtomic}; `mode` is required so the
 * permission decision stays visible at every call site.
 */
export interface WriteFileAtomicOptions {
  /**
   * Permission bits stamped on the fresh temp inode and carried through the
   * rename (subject to the process umask, like every fresh inode).
   */
  mode: number
  /**
   * Permission bits for parent directories this call creates (subject to the
   * umask; existing directories keep their mode). Omission uses the mkdir
   * default — pass `0o700` when the tree holds user-private data.
   */
  dirMode?: number
}

/**
 * Replace `filename` with `content` in one atomic step, creating parent
 * directories. The content is first written to a random-suffix sibling opened
 * with exclusive create (`wx`): the open refuses to follow a symlink planted
 * at the temp path, and the fresh inode carries `options.mode` through the
 * rename, so replacing a wider-permission file narrows it without a chmod
 * race. The rename also replaces a symlinked target itself instead of writing
 * through to its referent, and the same-directory sibling keeps the rename on
 * one filesystem. On any failure the temp file is removed and the failure
 * rethrown. Crash durability (fsync) is out of scope.
 * @param filename - final path receiving the content.
 * @param content - complete next file content.
 * @param options - permission bits for the replacement inode.
 */
export async function writeFileAtomic(filename: string, content: string, options: WriteFileAtomicOptions): Promise<void> {
  await mkdir(dirname(filename), {
    recursive: true,
    ...options.dirMode === undefined ? {} : { mode: options.dirMode },
  })
  // TODO(settings-atomic-durability): Use a replacement that fsyncs the file
  // and parent directory and preserves owner-only permissions on Windows.
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { mode: options.mode, flag: 'wx' })
    await rename(temp, filename)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

type PublishFile = (source: string, target: string) => Promise<void>

/** Injectable native publication operations for deterministic filesystem tests. */
export interface PublishNoReplaceOptions {
  /** First publication attempt; defaults to the POSIX hard-link primitive. */
  linkFile?: PublishFile
  /** No-replace rename fallback; defaults to OpenHarmony/Linux `renameat2`. */
  renameNoReplace?: PublishFile
}

function isHardLinkUnsupported(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP'
}

type RenameAt2 = (
  oldDirectory: number,
  oldPath: string,
  newDirectory: number,
  newPath: string,
  flags: number,
) => number

const AT_FDCWD = -100
const RENAME_NOREPLACE = 1

async function renameAtNoReplace(source: string, target: string): Promise<void> {
  const platform = process.platform as NodeJS.Platform | 'openharmony'
  if (platform !== 'linux' && platform !== 'openharmony') {
    const error = new Error(`atomic-write: no-replace rename is unsupported on ${platform}`) as NodeJS.ErrnoException
    error.code = 'ENOTSUP'
    throw error
  }
  const { default: koffi } = await import('koffi')
  const renameat2 = koffi.load('libc.so').func(
    'int renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags)',
  ) as unknown as RenameAt2
  const result = renameat2(AT_FDCWD, source, AT_FDCWD, target, RENAME_NOREPLACE)
  if (result === 0) return
  const errno = koffi.errno()
  const error = new Error(`atomic-write: renameat2 failed for ${source}`) as NodeJS.ErrnoException & { dest?: string }
  error.code = errno === 17 ? 'EEXIST' : `ERRNO_${errno}`
  error.errno = errno
  error.syscall = 'renameat2'
  error.path = source
  error.dest = target
  throw error
}

/**
 * Publish one staged file without replacing an existing target.
 * Hard links provide the first no-replace primitive; OpenHarmony/Linux use
 * `renameat2(RENAME_NOREPLACE)` when the filesystem rejects hard links.
 * @param source - staged file path.
 * @param target - final path.
 * @param options - injectable publication operations.
 */
export async function publishNoReplace(
  source: string,
  target: string,
  options: PublishNoReplaceOptions = {},
): Promise<void> {
  const publishLink = options.linkFile ?? link
  try {
    await publishLink(source, target)
  } catch (error) {
    if (!isHardLinkUnsupported(error)) throw error
    await (options.renameNoReplace ?? renameAtNoReplace)(source, target)
  }
}

/** Whether an exclusive create failed because the path already exists. */
function isEEXIST(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

/**
 * Writer-lock protocol constants. These are robustness invariants of the
 * cross-process write protocol, not deployment tunables: contention normally
 * resolves within the retry deadline, while expiry fails the contender without
 * guessing whether the existing lock still has an owner.
 */
const LOCK_RETRY_INITIAL_MS = 20
const LOCK_RETRY_MAX_MS = 200
const LOCK_TIMEOUT_MS = 2_000

/**
 * Hold the cross-process writer lock for `filename` around one operation. The
 * lock is a `wx`-created sibling (`<filename>.lock`); paired with the
 * rename-based commit of {@link writeFileAtomic}, readers stay lock-free and
 * only writers contend. Contention backs off exponentially and fails with a
 * timed-out error after the deadline. The contender never removes an existing
 * lock because file age cannot prove that its owner stopped; orphan recovery
 * is an operator action. The parent directory must exist.
 * @param filename - the file whose writers this lock serializes.
 * @param operation - the read-render-commit cycle to run while holding the lock.
 * @returns the operation's result; the lock releases on both outcomes.
 */
export async function withFileLock<T>(
  filename: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${filename}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let delay = LOCK_RETRY_INITIAL_MS
  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
      break
    } catch (error) {
      if (!isEEXIST(error)) throw error
    }
    if (Date.now() >= deadline) {
      throw new Error(`atomic-write: timed out waiting for the writer lock at ${lockPath}`)
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }
  try {
    return await operation()
  } finally {
    await rm(lockPath, { force: true })
  }
}
