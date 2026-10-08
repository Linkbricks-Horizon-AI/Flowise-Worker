import express from 'express'
import { rateLimit } from 'express-rate-limit'
import request from 'supertest'
import { getTrustProxy } from './trustProxy'

const createApp = (env: NodeJS.ProcessEnv) => {
    const app = express()
    app.set('trust proxy', getTrustProxy(env))
    app.use(rateLimit({ windowMs: 60000, max: 2 }))
    app.get('/', (req, res) => res.json({ ip: req.ip, secure: req.secure }))
    return app
}

describe('proxy trust with the real Express rate limiter', () => {
    afterEach(() => jest.restoreAllMocks())

    it.each([{}, { TRUST_PROXY: '' }, { TRUST_PROXY: '  ' }, { TRUST_PROXY: 'true' }, { TRUST_PROXY: ' true ' }, { TRUST_PROXY: '1' }])(
        'ignores forged leading addresses, enforces limits and preserves HTTPS with %j',
        async (env) => {
            const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
            const app = createApp(env)

            for (const forgedIp of ['198.51.100.1', '198.51.100.2']) {
                const response = await request(app)
                    .get('/')
                    .set('X-Forwarded-For', `${forgedIp}, 203.0.113.10`)
                    .set('X-Forwarded-Proto', 'https')
                    .expect(200)
                expect(response.body).toEqual({ ip: '203.0.113.10', secure: true })
            }

            await request(app).get('/').set('X-Forwarded-For', '198.51.100.3, 203.0.113.10').expect(429)
            await request(app).get('/').set('X-Forwarded-For', '198.51.100.3, 203.0.113.11').expect(200)
            expect(errors).not.toHaveBeenCalled()
        }
    )

    it.each([{ TRUST_PROXY: '2' }, { NUMBER_OF_PROXIES: '2' }, { TRUST_PROXY: ' ', NUMBER_OF_PROXIES: '2' }])(
        'supports a configured two-proxy path with %j',
        async (env) => {
            const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
            const app = createApp(env)
            const response = await request(app).get('/').set('X-Forwarded-For', '198.51.100.1, 203.0.113.10, 10.0.0.1').expect(200)
            expect(response.body.ip).toBe('203.0.113.10')
            expect(errors).not.toHaveBeenCalled()
        }
    )

    it('gives TRUST_PROXY precedence over the legacy proxy count', async () => {
        const app = createApp({ TRUST_PROXY: '1', NUMBER_OF_PROXIES: '2' })
        const response = await request(app).get('/').set('X-Forwarded-For', '198.51.100.1, 203.0.113.10').expect(200)
        expect(response.body.ip).toBe('203.0.113.10')
    })

    it('retains trusted IP and subnet lists', async () => {
        const app = createApp({ TRUST_PROXY: 'loopback, 10.0.0.0/8' })
        const response = await request(app).get('/').set('X-Forwarded-For', '198.51.100.1, 203.0.113.10, 10.0.0.1').expect(200)
        expect(response.body.ip).toBe('203.0.113.10')
    })

    it.each(['false', '0'])('supports direct connections with TRUST_PROXY=%s', async (value) => {
        const app = createApp({ TRUST_PROXY: value })
        const response = await request(app).get('/').set('X-Forwarded-Proto', 'https').expect(200)
        expect(response.body.ip).toMatch(/127\.0\.0\.1|::1/)
        expect(response.body.secure).toBe(false)
        await request(app).get('/').expect(200)
        await request(app).get('/').expect(429)
    })
})

describe('invalid proxy counts', () => {
    it.each(['-1', '1.5', 'Infinity', '-Infinity', '9007199254740992'])(
        'rejects %s instead of installing an unbounded or ambiguous policy',
        (value) => {
            expect(() => getTrustProxy({ TRUST_PROXY: value })).toThrow('non-negative integer')
            expect(() => getTrustProxy({ NUMBER_OF_PROXIES: value })).toThrow('non-negative integer')
        }
    )
})
