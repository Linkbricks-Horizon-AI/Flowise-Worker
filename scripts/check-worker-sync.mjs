#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [webArg, workerArg] = process.argv.slice(2)
if (!webArg || !workerArg) {
    console.error('Usage: node scripts/check-worker-sync.mjs <Flowise directory> <Flowise-Worker directory>')
    process.exit(2)
}

const web = resolve(webArg)
const worker = resolve(workerArg)
const sharedRoots = ['packages/', 'docker/', '.github/workflows/', 'scripts/']
const sharedFiles = new Set([
    '.upstream-sync.json',
    'Dockerfile',
    '.dockerignore',
    '.nvmrc',
    '.npmrc',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'turbo.json'
])
const tracked = (cwd) => execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean)
const files = [...new Set([...tracked(web), ...tracked(worker)])]
    .filter((file) => sharedFiles.has(file) || sharedRoots.some((prefix) => file.startsWith(prefix)))
    .sort()
const failures = []

const read = (directory, file, expectedCommand) => {
    const content = readFileSync(resolve(directory, file))
    if (file !== 'Dockerfile') return content
    const lines = content.toString('utf8').split('\n')
    const commands = lines.filter((line) => /^CMD\s/.test(line))
    if (commands.length !== 1 || JSON.stringify(JSON.parse(commands[0].replace(/^CMD\s+/, ''))) !== JSON.stringify(expectedCommand)) {
        throw new Error(`unexpected Docker CMD in ${directory}`)
    }
    return Buffer.from(lines.map((line) => (/^CMD\s/.test(line) ? 'CMD <service entrypoint>' : line)).join('\n'))
}

for (const file of files) {
    try {
        if (!read(web, file, ['pnpm', 'start']).equals(read(worker, file, ['pnpm', 'run', 'start-worker']))) failures.push(file)
    } catch (error) {
        failures.push(`${file}: ${error.message}`)
    }
}

if (failures.length) {
    console.error(`Flowise/Worker differ in ${failures.length} shared files:\n${failures.join('\n')}`)
    process.exit(1)
}
console.log(`Verified ${files.length} shared files. Only the Web/Worker Docker entrypoint differs.`)
