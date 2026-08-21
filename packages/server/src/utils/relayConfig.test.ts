import { isRelayExecutionChannelEnabled, resolveTransportKey } from './relayConfig'

describe('relayConfig — QUEUE-only relay gate', () => {
    const prev = { flag: process.env.RELAY_EXECUTION_CHANNEL, mode: process.env.MODE }
    afterEach(() => {
        process.env.RELAY_EXECUTION_CHANNEL = prev.flag
        process.env.MODE = prev.mode
    })

    it('is off when the flag is not "on", regardless of mode', () => {
        process.env.MODE = 'queue'
        process.env.RELAY_EXECUTION_CHANNEL = undefined
        expect(isRelayExecutionChannelEnabled()).toBe(false)
        process.env.RELAY_EXECUTION_CHANNEL = 'true'
        expect(isRelayExecutionChannelEnabled()).toBe(false) // only exact 'on'
    })

    it('is off in non-QUEUE mode even when the flag is on (prevents MAIN-mode stream loss)', () => {
        process.env.RELAY_EXECUTION_CHANNEL = 'on'
        process.env.MODE = 'main'
        expect(isRelayExecutionChannelEnabled()).toBe(false)
        // transport key falls back to the semantic chatId → identical to legacy behavior
        const { transportKey, relayExecutionId } = resolveTransportKey('conv-1')
        expect(transportKey).toBe('conv-1')
        expect(relayExecutionId).toBeUndefined()
    })

    it('is on only when flag=on AND mode=queue, yielding a fresh relay id', () => {
        process.env.RELAY_EXECUTION_CHANNEL = 'on'
        process.env.MODE = 'queue'
        expect(isRelayExecutionChannelEnabled()).toBe(true)
        const a = resolveTransportKey('conv-1')
        const b = resolveTransportKey('conv-1')
        expect(a.relayExecutionId).toBeDefined()
        expect(a.transportKey).toBe(a.relayExecutionId) // transport = relay id, not chatId
        expect(a.relayExecutionId).not.toBe(b.relayExecutionId) // fresh per request
    })
})
