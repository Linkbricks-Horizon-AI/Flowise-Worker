jest.mock('axios', () => ({
    create: jest.fn(() => ({ interceptors: { response: { use: jest.fn() } }, request: jest.fn(), post: jest.fn() })),
    post: jest.fn()
}))
jest.mock('@/store/constant', () => ({ baseURL: 'http://localhost', ErrorMessage: { TOKEN_EXPIRED: 'Token Expired' } }))
jest.mock('@/utils/authUtils', () => ({ removeCurrentUser: jest.fn() }))

import axios from 'axios'
import client from './client'
import exportImportApi from './exportimport'

const handleError = client.interceptors.response.use.mock.calls[0][1]

describe('export download API', () => {
    it('receives the export as a Blob instead of parsing the whole JSON string', () => {
        exportImportApi.downloadData({ chatflow: true })
        expect(client.post).toHaveBeenCalledWith('/export-import/export?download=true', { chatflow: true }, { responseType: 'blob' })
    })

    it('decodes JSON Blob errors for display', async () => {
        const error = { response: { status: 500, data: new Blob(['{"message":"Export failed"}']) } }
        await expect(handleError(error)).rejects.toBe(error)
        expect(error.response.data).toEqual({ message: 'Export failed' })
    })

    it('refreshes expired tokens for Blob downloads and retries with the original options', async () => {
        const config = { responseType: 'blob', url: '/export-import/export?download=true' }
        const error = { config, response: { status: 401, data: new Blob(['{"message":"Token Expired","retry":true}']) } }
        axios.post.mockResolvedValue({ data: { id: 'user-1' } })
        client.request.mockResolvedValue({ data: new Blob(['{}']) })
        await handleError(error)
        expect(client.request).toHaveBeenCalledWith(config)
    })

    it('preserves network errors when a stream disconnects', async () => {
        const error = new Error('Network Error')
        await expect(handleError(error)).rejects.toBe(error)
    })

    it('preserves non-JSON error responses', async () => {
        const data = new Blob(['<html>Proxy error</html>'])
        const error = { response: { status: 502, data } }
        await expect(handleError(error)).rejects.toBe(error)
        expect(error.response.data).toBe(data)
    })
})
