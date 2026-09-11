import { RedisEventSubscriber } from './RedisEventSubscriber'
import { SSEStreamer } from '../utils/SSEStreamer'

// createRedisClient only constructs a client (no connect on construction), so building a subscriber
// is side-effect free for testing the private routing decision in handleEvent.

function makeSubscriberWithSpy() {
    const tokenCalls: Array<{ slotKey: string; data: any }> = []
    const errorCalls: Array<{ slotKey: string; msg: string }> = []
    const fakeStreamer = {
        streamTokenEvent: (slotKey: string, data: any) => tokenCalls.push({ slotKey, data }),
        streamErrorEvent: (slotKey: string, msg: string) => errorCalls.push({ slotKey, msg })
    } as unknown as SSEStreamer
    const subscriber = new RedisEventSubscriber(fakeStreamer)
    const handle = (msg: string) => (subscriber as any).handleEvent(msg)
    return { handle, tokenCalls, errorCalls }
}

describe('RedisEventSubscriber.handleEvent — transport routing key', () => {
    it('routes by relayExecutionId when present (per-execution SSE slot)', () => {
        const { handle, tokenCalls } = makeSubscriberWithSpy()
        handle(JSON.stringify({ eventType: 'token', chatId: 'conv-1', relayExecutionId: 'relay-abc', data: 'hi' }))
        expect(tokenCalls).toHaveLength(1)
        // Slot key is the relay id, NOT the semantic chatId.
        expect(tokenCalls[0].slotKey).toBe('relay-abc')
        expect(tokenCalls[0].data).toBe('hi')
    })

    it('falls back to chatId when relayExecutionId is absent (legacy worker)', () => {
        const { handle, tokenCalls } = makeSubscriberWithSpy()
        handle(JSON.stringify({ eventType: 'token', chatId: 'conv-1', data: 'hi' }))
        expect(tokenCalls).toHaveLength(1)
        expect(tokenCalls[0].slotKey).toBe('conv-1')
    })

    it('drops events with neither a route key nor an eventType', () => {
        const { handle, tokenCalls, errorCalls } = makeSubscriberWithSpy()
        handle(JSON.stringify({ eventType: 'token', data: 'hi' })) // no chatId, no relayExecutionId
        handle(JSON.stringify({ chatId: 'conv-1', data: 'hi' })) // no eventType
        expect(tokenCalls).toHaveLength(0)
        expect(errorCalls).toHaveLength(0)
    })

    it('two concurrent executions of the same chatId route to distinct slots', () => {
        const { handle, tokenCalls } = makeSubscriberWithSpy()
        handle(JSON.stringify({ eventType: 'token', chatId: 'conv-1', relayExecutionId: 'relay-A', data: 'from A' }))
        handle(JSON.stringify({ eventType: 'token', chatId: 'conv-1', relayExecutionId: 'relay-B', data: 'from B' }))
        expect(tokenCalls.map((c) => c.slotKey)).toEqual(['relay-A', 'relay-B'])
        // No cross-contamination: each token went to its own execution's slot.
        expect(tokenCalls.find((c) => c.data === 'from A')?.slotKey).toBe('relay-A')
        expect(tokenCalls.find((c) => c.data === 'from B')?.slotKey).toBe('relay-B')
    })
})
