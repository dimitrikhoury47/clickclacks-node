// Copies the API's contract fixtures from the ClickClacks app repo into test/fixtures/server/.
// Usage: npm run fixtures:sync [-- /path/to/clickclacks]   (default: ../clickclacks-prod)
// The source is docs/api/v1/fixtures/*.json in that repo. test/contract.test.ts replays them.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? process.env.CLICKCLACKS_REPO ?? '../clickclacks-prod')
const source = join(repo, 'docs/api/v1/fixtures')
const target = resolve('test/fixtures/server')

if (!existsSync(source)) {
  console.error(`No fixtures at ${source}. Pass the ClickClacks repo path, or set CLICKCLACKS_REPO.`)
  process.exit(1)
}
const files = readdirSync(source).filter((f) => f.endsWith('.json'))
if (files.length === 0) {
  console.error(`${source} has no .json fixtures`)
  process.exit(1)
}
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
for (const file of files) copyFileSync(join(source, file), join(target, file))
console.log(`Copied ${files.length} fixtures from ${source} to ${target}`)
