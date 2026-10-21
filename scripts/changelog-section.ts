/**
 * Print the CHANGELOG.md section of a release, for its GitHub Release notes.
 *
 *   bun scripts/changelog-section.ts v1.2.3
 */

const tag = Bun.argv[2]
if (!tag) {
  console.error('Usage: bun scripts/changelog-section.ts <tag>')
  process.exit(1)
}

const version = tag.replace(/^v/, '')
const changelog = await Bun.file('CHANGELOG.md').text()
const lines = changelog.split('\n')
const start = lines.findIndex((line) => line.startsWith(`## [${version}] - `))

if (start === -1) {
  console.error(`CHANGELOG.md has no section for ${version}`)
  process.exit(1)
}

const rest = lines.slice(start + 1)
const end = rest.findIndex((line) => /^## |^\[.+\]: /.test(line))
const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()

if (!body) {
  console.error(`The CHANGELOG.md section for ${version} is empty`)
  process.exit(1)
}

console.log(body)
