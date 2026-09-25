// Builds dist/: ESM (index.mjs), CJS (index.cjs) and types (index.d.ts, index.d.cts).
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

rmSync('dist', { recursive: true, force: true })

const common = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'neutral',
  target: 'es2022',
  legalComments: 'none',
  logLevel: 'warning',
}
await build({ ...common, format: 'esm', outfile: 'dist/index.mjs' })
await build({ ...common, format: 'cjs', outfile: 'dist/index.cjs' })

// Types: tsc emits the .d.ts tree for ESM. CommonJS consumers get a parallel .d.cts tree whose
// relative specifiers point at .cjs, so TypeScript never treats them as ESM-only.
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--emitDeclarationOnly'], {
  stdio: 'inherit',
})
for (const file of readdirSync('dist').filter((name) => name.endsWith('.d.ts'))) {
  const source = readFileSync(`dist/${file}`, 'utf8')
  const cjs = source.replace(/(['"])(\.\/[^'"]+)\.js\1/g, '$1$2.cjs$1')
  writeFileSync(`dist/${file.replace(/\.d\.ts$/, '.d.cts')}`, cjs)
}

// Size report: the spec budget is about 6 KB minified.
const minified = await build({ ...common, format: 'esm', minify: true, write: false })
const bytes = minified.outputFiles[0].contents.length
const { gzipSync } = await import('node:zlib')
const gz = gzipSync(minified.outputFiles[0].contents).length
console.log(`dist built. minified ${bytes} B, gzipped ${gz} B`)
if (!readFileSync('dist/index.mjs', 'utf8').includes('clickclacks-node/')) throw new Error('VERSION missing from build')
