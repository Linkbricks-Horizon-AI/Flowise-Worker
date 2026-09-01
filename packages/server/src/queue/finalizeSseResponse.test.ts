import { finalizeSseResponse } from './finalizeSseResponse'

jest.mock('../utils/logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() }
}))

describe('finalizeSseResponse', () => {
    test('sends the existing terminal frame before starting Redis cleanup', () => {
        const order: string[] = []
        const sseStreamer = { removeClient: jest.fn(() => order.push('end')) }
        const redisSubscriber = {
            unsubscribe: jest.fn(() => {
                order.push('unsubscribe')
                return new Promise<void>(() => undefined)
            })
        }

        finalizeSseResponse({ transportKey: 'chat-1', sseStreamer, redisSubscriber })

        expect(order).toEqual(['end', 'unsubscribe'])
        expect(sseStreamer.removeClient).toHaveBeenCalledWith('chat-1')
    })

    test('does not require Redis cleanup outside queue mode', () => {
        const sseStreamer = { removeClient: jest.fn() }

        finalizeSseResponse({ transportKey: 'chat-1', sseStreamer })

        expect(sseStreamer.removeClient).toHaveBeenCalledWith('chat-1')
    })

    test('does not turn an asynchronous cleanup failure into an unhandled rejection', async () => {
        const sseStreamer = { removeClient: jest.fn() }
        const redisSubscriber = { unsubscribe: jest.fn().mockRejectedValue(new Error('Redis unavailable')) }

        finalizeSseResponse({ transportKey: 'chat-2', sseStreamer, redisSubscriber })
        await new Promise((resolve) => setImmediate(resolve))

        expect(sseStreamer.removeClient).toHaveBeenCalledWith('chat-2')
    })
})
