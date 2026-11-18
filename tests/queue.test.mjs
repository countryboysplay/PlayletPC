// The queue store's rules: queue before recommendations, and Previous walks back.
// The store is a .svelte.ts module, so strip the types and compile its runes first.
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { transformSync } from 'esbuild'
import { compileModule } from 'svelte/compiler'

const ts = fs.readFileSync(new URL('../src/lib/stores/queue.svelte.ts', import.meta.url), 'utf8')
const js = compileModule(transformSync(ts, { loader: 'ts' }).code, { generate: 'server' }).js.code
const out = new URL('../node_modules/.cache/queue.mjs', import.meta.url)
fs.mkdirSync(new URL('.', out), { recursive: true })
fs.writeFileSync(out, js)
const { queue } = await import(out.href)

const v = id => ({ videoId: id, title: id })
const rec = v('rec')

assert.equal(queue.next('a', rec)?.videoId, 'rec', 'empty queue falls back to the recommendation')
queue.add(v('q1'))
queue.add(v('q2'))
queue.addNext(v('first'))
assert.deepEqual(queue.items.map(i => i.videoId), ['first', 'q1', 'q2'], 'addNext goes to the front')
assert.equal(queue.next('b', rec)?.videoId, 'first', 'the queue wins over the recommendation')
queue.remove(1)
assert.deepEqual(queue.items.map(i => i.videoId), ['q1'], 'remove by index')
assert.equal(queue.next('c')?.videoId, 'q1')
assert.equal(queue.next('d'), undefined, 'nothing queued and no fallback: no next')
assert.equal(queue.previous(), 'c', 'Previous returns the last video left by Next')
assert.equal(queue.previous(), 'b')
assert.equal(queue.previous(), 'a')
assert.equal(queue.hasPrevious, false)
queue.add(v('now'))
queue.add(v('after'))
assert.equal(queue.next('now')?.videoId, 'after', 'a queued copy of the playing video is skipped, not replayed')
assert.equal(queue.items.length, 0)
queue.previous()
queue.add(v('x'))
queue.clear()
assert.equal(queue.items.length, 0, 'clear empties the queue')
console.log('queue: all checks passed')
