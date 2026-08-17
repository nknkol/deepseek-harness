/** Read the foreground process group directly from a node-pty descriptor. */

import type { IPty } from 'node-pty'

interface NodePtyInternals {
  readonly _fd?: unknown
}

type Tcgetpgrp = (fd: number) => number

/** A synchronous foreground process-group lookup for one PTY. */
export type ForegroundPgidReader = () => number | undefined

/**
 * Create an OpenHarmony foreground-group reader using the PTY's controlling
 * terminal instead of the incomplete `/proc/<pid>/stat` tpgid field.
 * @param terminal - allocated node-pty terminal.
 * @returns A reader, or undefined when node-pty does not expose a valid fd.
 */
export async function createPtyForegroundPgidReader(
  terminal: IPty,
): Promise<ForegroundPgidReader | undefined> {
  const fdValue = (terminal as IPty & NodePtyInternals)._fd
  if (typeof fdValue !== 'number' || !Number.isSafeInteger(fdValue) || fdValue < 0) return undefined
  const fd = fdValue

  const { default: koffi } = await import('koffi')
  const tcgetpgrp = koffi.load('libc.so').func('int tcgetpgrp(int fd)') as unknown as Tcgetpgrp
  return () => {
    try {
      const pgid = tcgetpgrp(fd)
      return Number.isSafeInteger(pgid) && pgid > 0 ? pgid : undefined
    } catch (_terminalForegroundGroupUnavailable) {
      return undefined
    }
  }
}
