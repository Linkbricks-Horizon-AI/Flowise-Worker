import { AbortControllerPool } from './AbortControllerPool'

describe('AbortControllerPool — scope index (relay-scoped abort)', () => {
    it('abort(id) aborts and removes a single controller', () => {
        const pool = new AbortControllerPool()
        const c = new AbortController()
        pool.add('relay-1', c)
        expect(pool.get('relay-1')).toBe(c)

        pool.abort('relay-1')

        expect(c.signal.aborted).toBe(true)
        expect(pool.get('relay-1')).toBeUndefined()
    })

    it('abortAllForScope aborts every execution indexed under a chat-scope key, not siblings', () => {
        const pool = new AbortControllerPool()
        const a = new AbortController()
        const b = new AbortController()
        const other = new AbortController()
        pool.add('relay-a', a, 'flow_chatX')
        pool.add('relay-b', b, 'flow_chatX')
        pool.add('relay-c', other, 'flow_chatY') // different conversation

        pool.abortAllForScope('flow_chatX')

        expect(a.signal.aborted).toBe(true)
        expect(b.signal.aborted).toBe(true)
        expect(other.signal.aborted).toBe(false) // untouched
        expect(pool.get('relay-a')).toBeUndefined()
        expect(pool.get('relay-b')).toBeUndefined()
        expect(pool.get('relay-c')).toBe(other)
    })

    it('abortAllForScope falls back to an exact abort for a legacy chat-scope registration', () => {
        const pool = new AbortControllerPool()
        const legacy = new AbortController()
        pool.add('flow_chatLegacy', legacy) // no scopeKey (legacy chat-scope id)

        pool.abortAllForScope('flow_chatLegacy')

        expect(legacy.signal.aborted).toBe(true)
        expect(pool.get('flow_chatLegacy')).toBeUndefined()
    })

    it('remove drops the id from its scope set so a later abortAllForScope does not touch it', () => {
        const pool = new AbortControllerPool()
        const a = new AbortController()
        const b = new AbortController()
        pool.add('relay-a', a, 'flow_chatX')
        pool.add('relay-b', b, 'flow_chatX')

        // relay-a finished normally (finally → remove) before an abort-all arrives.
        pool.remove('relay-a')
        pool.abortAllForScope('flow_chatX')

        expect(a.signal.aborted).toBe(false) // already gone — not re-aborted
        expect(b.signal.aborted).toBe(true)
    })

    it('exact-key abort of one execution leaves siblings of the same scope running', () => {
        const pool = new AbortControllerPool()
        const a = new AbortController()
        const b = new AbortController()
        pool.add('relay-a', a, 'flow_chatX')
        pool.add('relay-b', b, 'flow_chatX')

        // client-disconnect abort of a single execution (per-execution abort)
        pool.abort('relay-a')

        expect(a.signal.aborted).toBe(true)
        expect(b.signal.aborted).toBe(false)
        // the scope still resolves for the surviving sibling
        pool.abortAllForScope('flow_chatX')
        expect(b.signal.aborted).toBe(true)
    })
})
