#!/usr/bin/env node
// Run in the built deployment image: native modules can install but fail at load time.
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const { EventEmitter } = require('node:events')
const componentRequire = createRequire(resolve(__dirname, '../packages/components/package.json'))

async function main() {
    const sqlite = componentRequire('sqlite3')
    const db = new sqlite.Database(':memory:')
    await new Promise((resolve, reject) => {
        db.get('SELECT 24 AS version', (error, row) => {
            if (error) return reject(error)
            try {
                assert.equal(row.version, 24)
                resolve()
            } catch (error) {
                reject(error)
            }
        })
    })
    await new Promise((resolve, reject) => db.close((error) => (error ? reject(error) : resolve())))
    console.log('SQLite query: OK')

    const { IndexFlatL2 } = componentRequire('faiss-node')
    const index = new IndexFlatL2(2)
    index.add([1, 0, 0, 1])
    assert.equal(index.search([1, 0], 1).labels[0], 0)
    console.log('FAISS search: OK')

    const { createCanvas } = componentRequire('canvas')
    const canvas = createCanvas(2, 2)
    canvas.getContext('2d').fillRect(0, 0, 2, 2)
    const png = canvas.toBuffer('image/png')
    assert.equal(png.subarray(1, 4).toString(), 'PNG')
    const metadata = await componentRequire('sharp')(png).metadata()
    assert.equal(metadata.width, 2)
    const transformerRequire = createRequire(componentRequire.resolve('@xenova/transformers'))
    assert.equal(transformerRequire('sharp'), componentRequire('sharp'), 'Sharp must resolve to one shared native version')
    assert.equal((await transformerRequire('sharp')(png).metadata()).width, 2)
    console.log('Canvas PNG and shared Sharp decode: OK')

    const { Tensor } = componentRequire('onnxruntime-node')
    assert.deepEqual(new Tensor('float32', [1, 2], [2]).dims, [2])
    console.log('ONNX native load and tensor: OK')

    const { RawImage } = await import(pathToFileURL(componentRequire.resolve('@xenova/transformers')).href)
    const resized = await new RawImage(new Uint8Array(12).fill(255), 2, 2, 3).resize(1, 1)
    assert.equal(resized.width, 1)
    console.log('Transformers image resize: OK')

    const onceModule = componentRequire('@tootallnate/once')
    const once = onceModule.default || onceModule
    const emitter = new EventEmitter()
    const pending = once(emitter, 'complete')
    emitter.emit('complete', 'ok')
    assert.deepEqual(await pending, ['ok'])
    console.log('Proxy event dependency: OK')
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
