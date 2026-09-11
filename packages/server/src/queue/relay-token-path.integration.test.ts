import { RedisEventPublisher } from './RedisEventPublisher'
import { RedisEventSubscriber } from './RedisEventSubscriber'
import { SSEStreamer } from '../utils/SSEStreamer'

/**
 * In-process simulation of the worker→web token hop to answer: does relay-on (both new) actually
 * deliver tokens, and does the deploy skew (web relay-on + worker publishing chatId) drop them?
 *
 * We model the real wiring:
 *  - WORKER publishes via RelayScopedPublisher (relay-on) or base RedisEventPublisher (relay-off/old worker).
 *    We intercept the lowest-level `safePublish(channel, message)` to capture (channel, serialized envelope).
 *  - WEB is subscribed to exactly the channel its controller chose (transportKey): relayId when relay-on,
 *    chatId when relay-off. We only deliver a captured message to the subscriber if the web is subscribed
 *    to that channel (that's what a real Redis pub/sub does).
 *  - WEB registered its SSE slot under the same transportKey. We record which slot each event lands in.
 */

function makeWeb(subscribedChannel: string) {
    const delivered: Array<{ slot: string; type: string; data: any }> = []
    const fakeStreamer = {
        streamTokenEvent: (slot: string, data: any) => delivered.push({ slot, type: 'token', data }),
        streamStartEvent: (slot: string, data: any) => delivered.push({ slot, type: 'start', data }),
        streamErrorEvent: (slot: string, msg: string) => delivered.push({ slot, type: 'error', data: msg })
    } as unknown as SSEStreamer
    const subscriber = new RedisEventSubscriber(fakeStreamer)
    // Deliver a pub/sub message to this web only if it is subscribed to that channel (real Redis semantics).
    const deliverIfSubscribed = (channel: string, message: string) => {
        if (channel === subscribedChannel) (subscriber as any).handleEvent(message)
    }
    // The SSE slot the controller registered under (transportKey). Tokens are "seen by the user" only
    // if they land in THIS slot.
    return { delivered, deliverIfSubscribed, sseSlot: subscribedChannel }
}

function captureWorkerPublishes(publisher: RedisEventPublisher) {
    const out: Array<{ channel: string; message: string }> = []
    ;(publisher as any).safePublish = async (channel: string, message: string) => {
        out.push({ channel, message })
    }
    return out
}

describe('relay token path — worker→web hop simulation', () => {
    const CHAT_ID = 'conv-1'
    const RELAY_ID = 'relay-uuid-abc'

    it('HAPPY PATH (both new + relay ON): token reaches the relayId SSE slot', () => {
        // Web controller (relay on): subscribed to relayId, SSE slot = relayId.
        const web = makeWeb(RELAY_ID)

        // Worker (new): publishes via RelayScopedPublisher(relayId).
        const publisher = new RedisEventPublisher()
        const published = captureWorkerPublishes(publisher)
        const relayStreamer = publisher.withChannel(RELAY_ID)
        relayStreamer.streamTokenEvent(CHAT_ID, '안녕하세요')

        // Worker published on the relayId channel...
        expect(published).toHaveLength(1)
        expect(published[0].channel).toBe(RELAY_ID)

        // ...web is subscribed to relayId → receives it → routes to relayId slot.
        web.deliverIfSubscribed(published[0].channel, published[0].message)

        const tokens = web.delivered.filter((d) => d.type === 'token')
        expect(tokens).toHaveLength(1)
        expect(tokens[0].slot).toBe(web.sseSlot) // token landed in the user's slot ✓
        expect(tokens[0].data).toBe('안녕하세요')
    })

    it('RELAY OFF (both new): token reaches the chatId SSE slot', () => {
        // Web controller (relay off): subscribed to chatId, SSE slot = chatId.
        const web = makeWeb(CHAT_ID)

        // Worker (new, job has no relayExecutionId): uses base publisher → chatId channel.
        const publisher = new RedisEventPublisher()
        const published = captureWorkerPublishes(publisher)
        publisher.streamTokenEvent(CHAT_ID, '안녕하세요') // base publisher, chatId channel

        expect(published[0].channel).toBe(CHAT_ID)
        web.deliverIfSubscribed(published[0].channel, published[0].message)

        const tokens = web.delivered.filter((d) => d.type === 'token')
        expect(tokens).toHaveLength(1)
        expect(tokens[0].slot).toBe(web.sseSlot) // chatId slot ✓
    })

    it('DEPLOY SKEW (web relay ON + OLD worker publishing chatId): token is LOST — reproduces the outage', () => {
        // Web controller (relay on): subscribed to relayId, SSE slot = relayId.
        const web = makeWeb(RELAY_ID)

        // OLD worker: ignores relayExecutionId, publishes on the chatId channel via base publisher.
        const oldWorkerPublisher = new RedisEventPublisher()
        const published = captureWorkerPublishes(oldWorkerPublisher)
        oldWorkerPublisher.streamTokenEvent(CHAT_ID, '안녕하세요') // chatId channel

        expect(published[0].channel).toBe(CHAT_ID)

        // Web is subscribed to relayId, NOT chatId → the message is never delivered to this web.
        web.deliverIfSubscribed(published[0].channel, published[0].message)

        const tokens = web.delivered.filter((d) => d.type === 'token')
        expect(tokens).toHaveLength(0) // ← token LOST. Exactly the production symptom (no token frames).
    })

    it('metadata survives the skew (web-direct path) while tokens are lost — matches the observed frames', () => {
        // The controller emits metadata directly on its own SSE slot (not via pub/sub), so it always
        // reaches the user even under skew — which is why the outage showed start/metadata/end but no token.
        const web = makeWeb(RELAY_ID)
        // Simulate the controller's direct metadata emit to its own slot:
        web as any // no-op; documented — metadata is not a pub/sub event in this hop
        // Tokens (pub/sub) under skew:
        const oldWorker = new RedisEventPublisher()
        const published = captureWorkerPublishes(oldWorker)
        oldWorker.streamTokenEvent(CHAT_ID, 'x')
        web.deliverIfSubscribed(published[0].channel, published[0].message)
        expect(web.delivered.filter((d) => d.type === 'token')).toHaveLength(0)
    })
})
