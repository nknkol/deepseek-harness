/**
 * Verifies and writes OpenHarmony ELF self-sign sections, and prepares the
 * native files currently required by this workspace's host workflow.
 */
import { chmod, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PAGE_SIZE = 4096
const DESC_SIZE = 256
const SIGNATURE_SIZE = 32
const ELF64_SHENT_SIZE = 64
const SH_TYPE_PROGBITS = 1
const SH_TYPE_NOBITS = 8
const SHF_ALLOC = 2n
const FLAG_SELF_SIGN = 0x10
const FS_VERITY_DESCRIPTOR_TYPE = 1
const FS_VERITY_DESCRIPTOR_LENGTH = DESC_SIZE + SIGNATURE_SIZE
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46]
const ELF_MACHINE_AARCH64 = 183

type Bytes = Uint8Array

interface SectionHeader {
  index: number
  headerOffset: number
  nameOffset: number
  name: string
  type: number
  flags: bigint
  offset: number
  size: number
  addressAlign: bigint
}

interface ParsedElf {
  eShOff: number
  eShNum: number
  eShStrNdx: number
  shStrOffset: number
  shStrSize: number
  sections: SectionHeader[]
}

/** Result of checking the ELF self-sign descriptor and Merkle root. */
export interface VerifyResult {
  valid: boolean
  reason?: string
  fileSize?: number
  codeSignOffset?: number
}

/** Result of adding or replacing the ELF self-sign section. */
export interface SignResult {
  input: string
  output: string
  resigned: boolean
  fileSize: number
  codeSignOffset: number
}

/** Summary of native ELF preparation for the current OpenHarmony host. */
export interface PrepareResult {
  skipped: boolean
  files: number
  valid: number
  signed: number
  resigned: number
  executable: number
}

function fail(message: string): never {
  throw new Error(message)
}

function assertRange(bytes: Bytes, offset: number, size: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > bytes.length - size) {
    fail(`${label} is outside the file`)
  }
}

function toSafeNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(`${label} is outside the supported range`)
  }
  return Number(value)
}

function alignUp(value: number, alignment: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('value cannot be aligned')
  }
  const aligned = Math.ceil(value / alignment) * alignment
  if (!Number.isSafeInteger(aligned)) {
    fail('aligned value is too large')
  }
  return aligned
}

function viewOf(bytes: Bytes): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function readU16(bytes: Bytes, offset: number): number {
  return viewOf(bytes).getUint16(offset, true)
}

function readU32(bytes: Bytes, offset: number): number {
  return viewOf(bytes).getUint32(offset, true)
}

function readU64(bytes: Bytes, offset: number): bigint {
  return viewOf(bytes).getBigUint64(offset, true)
}

function writeU16(bytes: Bytes, offset: number, value: number): void {
  viewOf(bytes).setUint16(offset, value, true)
}

function writeU32(bytes: Bytes, offset: number, value: number): void {
  viewOf(bytes).setUint32(offset, value, true)
}

function writeU64(bytes: Bytes, offset: number, value: bigint): void {
  viewOf(bytes).setBigUint64(offset, value, true)
}

function bytesEqual(left: Bytes, right: Bytes): boolean {
  if (left.length !== right.length) {
    return false
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function sha256(bytes: Bytes): Bytes {
  return new Uint8Array(createHash('sha256').update(bytes).digest())
}

function utf8(bytes: Bytes): string {
  return new TextDecoder().decode(bytes)
}

function sectionName(bytes: Bytes, shStrOffset: number, shStrSize: number, nameOffset: number): string {
  if (nameOffset >= shStrSize) {
    fail('section name offset is outside .shstrtab')
  }
  const start = shStrOffset + nameOffset
  const end = shStrOffset + shStrSize
  const nul = bytes.indexOf(0, start)
  if (nul < 0 || nul >= end) {
    fail('section name is not NUL-terminated')
  }
  return utf8(bytes.subarray(start, nul))
}

function parseElf(bytes: Bytes): ParsedElf {
  if (bytes.length < 64 || !ELF_MAGIC.every((value, index) => bytes[index] === value)) {
    fail('not an ELF file')
  }
  if (bytes[4] !== 2 || bytes[5] !== 1) {
    fail('only ELF64 little-endian files are supported')
  }

  const eShOff = toSafeNumber(readU64(bytes, 0x28), 'section header offset')
  const eShEntSize = readU16(bytes, 0x3a)
  const eShNum = readU16(bytes, 0x3c)
  const eShStrNdx = readU16(bytes, 0x3e)
  if (eShOff === 0 || eShNum === 0) {
    fail('stripped ELF files are not supported')
  }
  if (eShEntSize !== ELF64_SHENT_SIZE) {
    fail(`unsupported ELF64 section header size: ${eShEntSize}`)
  }
  if (eShStrNdx >= eShNum) {
    fail('invalid section string table index')
  }
  const sectionTableSize = eShNum * ELF64_SHENT_SIZE
  assertRange(bytes, eShOff, sectionTableSize, 'section header table')

  const shStrHeader = eShOff + eShStrNdx * ELF64_SHENT_SIZE
  const shStrOffset = toSafeNumber(readU64(bytes, shStrHeader + 0x18), '.shstrtab offset')
  const shStrSize = toSafeNumber(readU64(bytes, shStrHeader + 0x20), '.shstrtab size')
  assertRange(bytes, shStrOffset, shStrSize, '.shstrtab')

  const sections: SectionHeader[] = []
  for (let index = 0; index < eShNum; index++) {
    const headerOffset = eShOff + index * ELF64_SHENT_SIZE
    const nameOffset = readU32(bytes, headerOffset)
    const type = readU32(bytes, headerOffset + 4)
    const flags = readU64(bytes, headerOffset + 8)
    const offset = toSafeNumber(readU64(bytes, headerOffset + 0x18), `section ${index} offset`)
    const size = toSafeNumber(readU64(bytes, headerOffset + 0x20), `section ${index} size`)
    if (type !== SH_TYPE_NOBITS) {
      assertRange(bytes, offset, size, `section ${index}`)
    }
    sections.push({
      index,
      headerOffset,
      nameOffset,
      name: sectionName(bytes, shStrOffset, shStrSize, nameOffset),
      type,
      flags,
      offset,
      size,
      addressAlign: readU64(bytes, headerOffset + 0x30),
    })
  }

  return { eShOff, eShNum, eShStrNdx, shStrOffset, shStrSize, sections }
}

function getCodeSignSection(parsed: ParsedElf): SectionHeader | undefined {
  const matches = parsed.sections.filter(section => section.name === '.codesign')
  if (matches.length > 1) {
    fail('multiple .codesign sections are not supported')
  }
  return matches[0]
}

function validateCodeSignSection(bytes: Bytes, section: SectionHeader): void {
  if (section.type !== SH_TYPE_PROGBITS || section.offset % PAGE_SIZE !== 0 || section.size !== PAGE_SIZE) {
    fail('.codesign must be one 4 KiB-aligned PROGBITS section')
  }
  if (section.addressAlign !== BigInt(PAGE_SIZE)) {
    fail('.codesign alignment is not 4 KiB')
  }
  assertRange(bytes, section.offset, section.size, '.codesign')
}

function merkleRoot(bytes: Bytes, codeSignOffset: number): Bytes {
  const pageCount = Math.ceil(bytes.length / PAGE_SIZE)
  const leaves = new Uint8Array(pageCount * SIGNATURE_SIZE)
  const codeSignPage = Math.floor(codeSignOffset / PAGE_SIZE)

  for (let page = 0; page < pageCount; page++) {
    if (page === codeSignPage) {
      // The official builder replaces this leaf hash with 32 zero bytes; it
      // does not hash a zero-filled code-sign page.
      leaves.fill(0, page * SIGNATURE_SIZE, (page + 1) * SIGNATURE_SIZE)
      continue
    }
    const pageBytes = new Uint8Array(PAGE_SIZE)
    pageBytes.set(bytes.subarray(page * PAGE_SIZE, Math.min(bytes.length, (page + 1) * PAGE_SIZE)))
    leaves.set(sha256(pageBytes), page * SIGNATURE_SIZE)
  }

  if (pageCount === 1) {
    return leaves.subarray(0, SIGNATURE_SIZE)
  }

  let current = leaves
  while (current.length > PAGE_SIZE) {
    const nextPageCount = Math.ceil(current.length / PAGE_SIZE)
    const next = new Uint8Array(nextPageCount * SIGNATURE_SIZE)
    for (let page = 0; page < nextPageCount; page++) {
      const pageBytes = new Uint8Array(PAGE_SIZE)
      pageBytes.set(current.subarray(page * PAGE_SIZE, Math.min(current.length, (page + 1) * PAGE_SIZE)))
      next.set(sha256(pageBytes), page * SIGNATURE_SIZE)
    }
    current = next
  }

  const rootPage = new Uint8Array(PAGE_SIZE)
  rootPage.set(current)
  return sha256(rootPage)
}

function buildDescriptor(signSize: number, fileSize: number, root: Bytes): Bytes {
  const descriptor = new Uint8Array(DESC_SIZE)
  descriptor[0] = 1
  descriptor[1] = 1
  descriptor[2] = 12
  descriptor[3] = 0
  writeU32(descriptor, 4, signSize)
  writeU64(descriptor, 8, BigInt(fileSize))
  descriptor.set(root, 16)
  writeU32(descriptor, 112, FLAG_SELF_SIGN)
  descriptor[255] = 3
  return descriptor
}

function readAndValidateDescriptor(bytes: Bytes, section: SectionHeader): { descriptor: Bytes; signature: Bytes } {
  validateCodeSignSection(bytes, section)
  const payloadOffset = section.offset
  if (readU32(bytes, payloadOffset) !== FS_VERITY_DESCRIPTOR_TYPE) {
    fail('unsupported ELF code-sign descriptor type')
  }
  if (readU32(bytes, payloadOffset + 4) !== FS_VERITY_DESCRIPTOR_LENGTH) {
    fail('invalid ELF code-sign descriptor length')
  }
  const descriptorOffset = payloadOffset + 8
  const signatureOffset = descriptorOffset + DESC_SIZE
  assertRange(bytes, descriptorOffset, DESC_SIZE + SIGNATURE_SIZE, 'ELF code-sign payload')
  for (let index = signatureOffset + SIGNATURE_SIZE; index < section.offset + section.size; index++) {
    if (bytes[index] !== 0) {
      fail('non-zero padding in .codesign')
    }
  }

  const descriptor = bytes.slice(descriptorOffset, descriptorOffset + DESC_SIZE)
  const signature = bytes.slice(signatureOffset, signatureOffset + SIGNATURE_SIZE)
  if (descriptor[0] !== 1 || descriptor[1] !== 1 || descriptor[2] !== 12 || descriptor[3] !== 0) {
    fail('unsupported fs-verity descriptor parameters')
  }
  if (readU32(descriptor, 4) !== SIGNATURE_SIZE || readU32(descriptor, 112) !== FLAG_SELF_SIGN || descriptor[255] !== 3) {
    fail('invalid ELF self-sign descriptor')
  }
  const reservedRanges: Array<[number, number]> = [[48, 80], [80, 112], [116, 120], [120, 128], [128, 255]]
  for (const [start, end] of reservedRanges) {
    for (let index = start; index < end; index++) {
      if (descriptor[index] !== 0) {
        fail('non-zero reserved descriptor data')
      }
    }
  }
  return { descriptor, signature }
}

function verifyBytes(bytes: Bytes): VerifyResult {
  try {
    const parsed = parseElf(bytes)
    const section = getCodeSignSection(parsed)
    if (!section) {
      return { valid: false, reason: '.codesign section is missing', fileSize: bytes.length }
    }
    const { descriptor, signature } = readAndValidateDescriptor(bytes, section)
    if (toSafeNumber(readU64(descriptor, 8), 'descriptor file size') !== bytes.length) {
      return { valid: false, reason: 'descriptor fileSize does not match the file', fileSize: bytes.length, codeSignOffset: section.offset }
    }

    const expectedRoot = merkleRoot(bytes, section.offset)
    if (!bytesEqual(expectedRoot, descriptor.subarray(16, 48))) {
      return { valid: false, reason: 'Merkle root does not match the ELF contents', fileSize: bytes.length, codeSignOffset: section.offset }
    }

    const descriptorForDigest = descriptor.slice()
    writeU32(descriptorForDigest, 4, 0)
    if (!bytesEqual(sha256(descriptorForDigest), signature)) {
      return { valid: false, reason: 'self-sign digest does not match the descriptor', fileSize: bytes.length, codeSignOffset: section.offset }
    }
    return { valid: true, fileSize: bytes.length, codeSignOffset: section.offset }
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error), fileSize: bytes.length }
  }
}

function makeSigningBase(bytes: Bytes, parsed: ParsedElf): { base: Bytes; codeSignOffset: number; resigned: boolean } {
  const existing = getCodeSignSection(parsed)
  if (existing) {
    validateCodeSignSection(bytes, existing)
    const base = bytes.slice()
    base.fill(0, existing.offset, existing.offset + existing.size)
    return { base, codeSignOffset: existing.offset, resigned: true }
  }

  const codeSignOffset = alignUp(bytes.length, PAGE_SIZE)
  const newShStr = new Uint8Array(parsed.shStrSize + 10)
  newShStr.set(bytes.subarray(parsed.shStrOffset, parsed.shStrOffset + parsed.shStrSize))
  newShStr.set(new TextEncoder().encode('.codesign\0'), parsed.shStrSize)

  const newShStrOffset = codeSignOffset + PAGE_SIZE
  const newShtOffset = newShStrOffset + newShStr.length
  const newShNum = parsed.eShNum + 1
  if (newShNum > 0xffff) {
    fail('too many ELF sections')
  }
  const newTotal = newShtOffset + newShNum * ELF64_SHENT_SIZE
  if (!Number.isSafeInteger(newTotal)) {
    fail('signed ELF would be too large')
  }

  const base = new Uint8Array(newTotal)
  base.set(bytes)
  base.set(newShStr, newShStrOffset)
  base.set(bytes.subarray(parsed.eShOff, parsed.eShOff + parsed.eShNum * ELF64_SHENT_SIZE), newShtOffset)

  const newShStrHeader = newShtOffset + parsed.eShStrNdx * ELF64_SHENT_SIZE
  writeU64(base, newShStrHeader + 0x18, BigInt(newShStrOffset))
  writeU64(base, newShStrHeader + 0x20, BigInt(newShStr.length))

  const codeSignHeader = newShtOffset + parsed.eShNum * ELF64_SHENT_SIZE
  writeU32(base, codeSignHeader, parsed.shStrSize)
  writeU32(base, codeSignHeader + 4, SH_TYPE_PROGBITS)
  writeU64(base, codeSignHeader + 8, SHF_ALLOC)
  writeU64(base, codeSignHeader + 0x18, BigInt(codeSignOffset))
  writeU64(base, codeSignHeader + 0x20, BigInt(PAGE_SIZE))
  writeU64(base, codeSignHeader + 0x30, BigInt(PAGE_SIZE))

  writeU64(base, 0x28, BigInt(newShtOffset))
  writeU16(base, 0x3c, newShNum)
  return { base, codeSignOffset, resigned: false }
}

async function writeAtomic(output: string, bytes: Bytes, mode: number): Promise<void> {
  const target = resolve(output)
  const temporary = resolve(dirname(target), `.${basename(target)}.self-sign-${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: mode & 0o7777 })
    await chmod(temporary, mode & 0o7777)
    const handle = await open(temporary, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

function executableMode(mode: number): number {
  const permissions = mode & 0o7777
  const ownerExecute = permissions & 0o400 ? 0o100 : 0
  const groupExecute = permissions & 0o040 ? 0o010 : 0
  const otherExecute = permissions & 0o004 ? 0o001 : 0
  return permissions | ownerExecute | groupExecute | otherExecute
}

function isOpenHarmonyNativePath(file: string): boolean {
  const normalized = file.replaceAll('\\', '/').toLowerCase()
  return normalized.includes('openharmony')
    || normalized.includes('ohos')
    || normalized.includes('lightningcss-linux-arm64-musl')
}

function isAarch64Elf(bytes: Bytes): boolean {
  return bytes.length >= 20
    && ELF_MAGIC.every((value, index) => bytes[index] === value)
    && bytes[4] === 2
    && bytes[5] === 1
    && readU16(bytes, 18) === ELF_MACHINE_AARCH64
}

async function findNativeFiles(directory: string, files: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return
    }
    throw error
  }

  for (const entry of entries) {
    const file = resolve(directory, entry.name)
    const normalized = file.replaceAll('\\', '/').toLowerCase()
    const isLefthookExecutable = entry.isFile()
      && entry.name === 'lefthook'
      && normalized.includes('lefthook-linux-arm64')
    const isTsgolintExecutable = entry.isFile()
      && entry.name === 'tsgolint'
      && normalized.includes('oxlint-tsgolint')
      && normalized.includes('linux-arm64')
    const isNodePtyNative = entry.isFile()
      && normalized.includes('/node_modules/node-pty/')
      && normalized.includes('/build/release/')
      && (entry.name === 'pty.node' || entry.name === 'spawn-helper')
    if (entry.isDirectory()) {
      await findNativeFiles(file, files)
    } else if (
      entry.isFile()
      && ((entry.name.endsWith('.node') && isOpenHarmonyNativePath(file))
        || isLefthookExecutable
        || isTsgolintExecutable
        || isNodePtyNative)
    ) {
      files.push(file)
    }
  }
}

/**
 * Signs the selected OpenHarmony AArch64 native files below a project node_modules directory.
 *
 * @param root Project directory whose node_modules directory should be prepared.
 * @returns Preparation counts; non-OpenHarmony hosts are reported as skipped.
 */
export async function prepareNativeElfs(root = process.cwd()): Promise<PrepareResult> {
  if ((process.platform as string) !== 'openharmony' || process.arch !== 'arm64') {
    return { skipped: true, files: 0, valid: 0, signed: 0, resigned: 0, executable: 0 }
  }

  const candidates: string[] = []
  await findNativeFiles(resolve(root, 'node_modules'), candidates)
  const result: PrepareResult = {
    skipped: false,
    files: 0,
    valid: 0,
    signed: 0,
    resigned: 0,
    executable: 0,
  }

  for (const file of candidates.sort()) {
    const header = new Uint8Array(await readFile(file))
    if (!isAarch64Elf(header)) continue
    result.files += 1

    const verification = await verifyElf(file)
    if (verification.valid) {
      result.valid += 1
    } else {
      const signed = await signElf(file)
      if (signed.resigned) result.resigned += 1
      else result.signed += 1
    }

    const fileStat = await stat(file)
    const mode = executableMode(fileStat.mode)
    if ((fileStat.mode & 0o111) !== (mode & 0o111)) {
      await chmod(file, mode)
      result.executable += 1
    }
  }

  const summary = [
    `prepared ${result.files} OpenHarmony native ELF${result.files === 1 ? '' : 's'}`,
    `${result.valid} already valid`,
    `${result.signed} signed`,
    `${result.resigned} resigned`,
    `${result.executable} made executable`,
  ].join('; ')
  console.log(`[elf-self-sign] ${summary}`)
  return result
}

/**
 * Verifies an ELF self-sign descriptor and its content Merkle root.
 *
 * @param input ELF file to verify.
 * @returns Validation result; invalid files are reported without throwing.
 */
export async function verifyElf(input: string): Promise<VerifyResult> {
  const bytes = new Uint8Array(await readFile(input))
  return verifyBytes(bytes)
}

/**
 * Adds a self-sign section or replaces the existing one without changing other ELF bytes.
 *
 * @param input ELF file to sign.
 * @param output Destination file; defaults to replacing the input atomically.
 * @returns Signing result including whether an existing section was replaced.
 */
export async function signElf(input: string, output = input): Promise<SignResult> {
  const inputPath = resolve(input)
  const outputPath = resolve(output)
  const inputBytes = new Uint8Array(await readFile(inputPath))
  const inputStat = await stat(inputPath)
  const parsed = parseElf(inputBytes)
  const { base, codeSignOffset, resigned } = makeSigningBase(inputBytes, parsed)
  const root = merkleRoot(base, codeSignOffset)
  const descriptorForDigest = buildDescriptor(0, base.length, root)
  const signature = sha256(descriptorForDigest)
  const descriptor = buildDescriptor(SIGNATURE_SIZE, base.length, root)
  const payload = new Uint8Array(8 + DESC_SIZE + SIGNATURE_SIZE)
  writeU32(payload, 0, FS_VERITY_DESCRIPTOR_TYPE)
  writeU32(payload, 4, FS_VERITY_DESCRIPTOR_LENGTH)
  payload.set(descriptor, 8)
  payload.set(signature, 8 + DESC_SIZE)
  base.set(payload, codeSignOffset)
  await writeAtomic(outputPath, base, inputStat.mode)
  return { input: inputPath, output: outputPath, resigned, fileSize: base.length, codeSignOffset }
}

function usage(): string {
  return [
    'usage:',
    '  elf-self-sign.ts verify <elf>',
    '  elf-self-sign.ts sign <input-elf> [output-elf]',
    '  elf-self-sign.ts prepare [project-root]',
  ].join('\n')
}

async function main(argv: string[]): Promise<number> {
  const [command, input, output] = argv
  if (!command || command === '--help' || command === '-h') {
    console.log(usage())
    return command ? 0 : 2
  }
  if (command === 'prepare') {
    if (output) {
      console.error(usage())
      return 2
    }
    await prepareNativeElfs(input ?? process.cwd())
    return 0
  }
  if (!input || (command !== 'verify' && command !== 'sign') || (command === 'verify' && output)) {
    console.error(usage())
    return 2
  }
  if (command === 'verify') {
    const result = await verifyElf(input)
    if (result.valid) {
      console.log(`valid self-sign: ${input}`)
      return 0
    }
    console.error(`invalid self-sign: ${result.reason}`)
    return 1
  }
  const result = await signElf(input, output ?? input)
  console.log(`${result.resigned ? 'resigned' : 'signed'}: ${result.output} (codesign=0x${result.codeSignOffset.toString(16)})`)
  return 0
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  })
}
