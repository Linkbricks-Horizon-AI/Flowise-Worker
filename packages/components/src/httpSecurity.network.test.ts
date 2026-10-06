import dns from 'dns/promises'
import http from 'http'
import net from 'net'
import { secureAxiosRequest, secureFetch } from './httpSecurity'

describe('validated DNS pinning with real Node HTTP connections', () => {
    let server: http.Server
    let url: string
    let requests = 0
    const originalSecurity = process.env.HTTP_SECURITY_CHECK
    const originalDenyList = process.env.HTTP_DENY_LIST
    const originalAutoSelect = net.getDefaultAutoSelectFamily()

    beforeAll(async () => {
        server = http.createServer((_req, res) => {
            requests++
            res.end('pinned response')
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        url = `http://child.fixture.test:${(server.address() as net.AddressInfo).port}`
    })

    beforeEach(() => {
        requests = 0
        // The test endpoint is loopback. Production defaults are tested separately below.
        process.env.HTTP_SECURITY_CHECK = 'false'
        process.env.HTTP_DENY_LIST = ''
    })

    afterEach(() => {
        jest.restoreAllMocks()
        net.setDefaultAutoSelectFamily(originalAutoSelect)
        if (originalSecurity === undefined) delete process.env.HTTP_SECURITY_CHECK
        else process.env.HTTP_SECURITY_CHECK = originalSecurity
        if (originalDenyList === undefined) delete process.env.HTTP_DENY_LIST
        else process.env.HTTP_DENY_LIST = originalDenyList
    })

    afterAll(async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    })

    it.each([
        ['fetch', true],
        ['fetch', false],
        ['axios', true],
        ['axios', false]
    ])('%s uses the validated address with autoSelectFamily=%s', async (client, autoSelect) => {
        net.setDefaultAutoSelectFamily(autoSelect as boolean)
        const lookup = jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any)
        const text = client === 'fetch' ? await (await secureFetch(url)).text() : (await secureAxiosRequest({ url, proxy: false })).data
        expect(text).toBe('pinned response')
        expect(requests).toBe(1)
        // The socket uses only the pinned result, never a second DNS lookup.
        expect(lookup).toHaveBeenCalledTimes(1)
        expect(lookup).toHaveBeenCalledWith('child.fixture.test', { all: true })
    })

    it.each(['fetch', 'axios'])('%s still rejects a mixed public/denied DNS answer before connecting', async (client) => {
        process.env.HTTP_SECURITY_CHECK = 'true'
        jest.spyOn(dns, 'lookup').mockResolvedValue([
            { address: '8.8.8.8', family: 4 },
            { address: '127.0.0.1', family: 4 }
        ] as any)
        const result = client === 'fetch' ? secureFetch(url) : secureAxiosRequest({ url, proxy: false })
        await expect(result).rejects.toThrow('denied by policy')
        expect(requests).toBe(0)
    })
})
