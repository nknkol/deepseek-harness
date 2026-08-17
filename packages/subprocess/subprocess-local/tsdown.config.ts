import { defineConfig } from 'tsdown'

/** Bundle the OpenHarmony ELF signer into the published native preparation hook. */
export default defineConfig({
  entry: ['../../../scripts/elf-self-sign.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
