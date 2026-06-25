import { Request } from 'express'
import { getRateLimiterKey } from './rateLimit'

const makeReq = (body: any, ip: string | undefined = '1.2.3.4'): Request =>
    ({ body, ip, socket: { remoteAddress: ip } } as unknown as Request)

describe('getRateLimiterKey', () => {
    it('returns overrideConfig.sessionId when present', () => {
        expect(getRateLimiterKey(makeReq({ overrideConfig: { sessionId: 'sess-1' }, chatId: 'chat-1' }))).toBe('sess-1')
    })

    it('falls back to chatId when sessionId absent', () => {
        expect(getRateLimiterKey(makeReq({ chatId: 'chat-1' }))).toBe('chat-1')
    })

    it('falls back to ip when no session identifiers', () => {
        expect(getRateLimiterKey(makeReq({}))).toBe('1.2.3.4')
    })

    it('falls back to ip when body is undefined', () => {
        expect(getRateLimiterKey(makeReq(undefined))).toBe('1.2.3.4')
    })

    it('ignores empty-string sessionId and falls back to chatId', () => {
        expect(getRateLimiterKey(makeReq({ overrideConfig: { sessionId: '' }, chatId: 'chat-2' }))).toBe('chat-2')
    })

    // NOTE: construct the Request directly here — makeReq's default `ip` param
    // would swallow an explicit `undefined`, so it cannot exercise the IP-absent path.
    it('falls back to socket.remoteAddress when ip is undefined', () => {
        expect(
            getRateLimiterKey({ body: {}, ip: undefined, socket: { remoteAddress: '5.6.7.8' } } as unknown as Request)
        ).toBe('5.6.7.8')
    })

    it('falls back to "unknown" when neither ip nor remoteAddress is set', () => {
        expect(getRateLimiterKey({ body: {}, ip: undefined, socket: {} } as unknown as Request)).toBe('unknown')
    })
})
