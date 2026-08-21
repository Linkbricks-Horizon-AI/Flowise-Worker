import { RedisEventPublisher } from './RedisEventPublisher'

// The publisher's redis client is constructed but never connected in these tests. We spy on the
// internal publishOnRelayChannel to assert the relay wrapper's channel/payload contract without Redis.

describe('RedisEventPublisher.withChannel — relay-scoped transport', () => {
    it('publishes on the relay channel and preserves the semantic chatId in the payload', () => {
        const publisher = new RedisEventPublisher()
        const calls: Array<{ relayId: string; envelope: Record<string, any> }> = []
        ;(publisher as any).publishOnRelayChannel = (relayId: string, envelope: Record<string, any>) =>
            calls.push({ relayId, envelope })

        const relay = publisher.withChannel('relay-xyz') as any
        relay.streamTokenEvent('conv-semantic', 'hello')

        expect(calls).toHaveLength(1)
        // Channel is the relay id (transport isolation)...
        expect(calls[0].relayId).toBe('relay-xyz')
        // ...but the envelope keeps the semantic chatId untouched.
        expect(calls[0].envelope.chatId).toBe('conv-semantic')
        expect(calls[0].envelope.eventType).toBe('token')
        expect(calls[0].envelope.data).toBe('hello')
    })

    it('metadata event keeps semantic chatId/sessionId inside the payload, not the relay id', () => {
        const publisher = new RedisEventPublisher()
        const calls: Array<{ relayId: string; envelope: Record<string, any> }> = []
        ;(publisher as any).publishOnRelayChannel = (relayId: string, envelope: Record<string, any>) =>
            calls.push({ relayId, envelope })

        const relay = publisher.withChannel('relay-xyz') as any
        relay.streamMetadataEvent('conv-semantic', {
            chatId: 'conv-semantic',
            chatMessageId: 'msg-1',
            sessionId: 'sess-1'
        })

        expect(calls).toHaveLength(1)
        expect(calls[0].relayId).toBe('relay-xyz')
        expect(calls[0].envelope.eventType).toBe('metadata')
        // The metadata data carries the semantic ids the client depends on.
        expect(calls[0].envelope.data.chatId).toBe('conv-semantic')
        expect(calls[0].envelope.data.chatMessageId).toBe('msg-1')
        expect(calls[0].envelope.data.sessionId).toBe('sess-1')
    })

    it('publishOnRelayChannel stamps relayExecutionId as the top-level routing field', async () => {
        const publisher = new RedisEventPublisher()
        const published: Array<{ channel: string; message: string }> = []
        // Intercept the lowest-level publish to assert channel + serialized routing field.
        ;(publisher as any).safePublish = async (channel: string, message: string) => {
            published.push({ channel, message })
        }

        ;(publisher as any).publishOnRelayChannel('relay-xyz', { chatId: 'conv-semantic', eventType: 'token', data: 'x' })

        expect(published).toHaveLength(1)
        expect(published[0].channel).toBe('relay-xyz')
        const parsed = JSON.parse(published[0].message)
        expect(parsed.relayExecutionId).toBe('relay-xyz') // subscriber routes by this
        expect(parsed.chatId).toBe('conv-semantic') // semantic id preserved
    })
})
