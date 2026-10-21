import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'

jest.mock('../../services/export-import', () => ({
    __esModule: true,
    default: { convertExportInput: jest.fn((body) => body), exportData: jest.fn() }
}))
jest.mock('../../services/export-import/download', () => ({
    createExportDownload: jest.fn(),
    ExportDownloadError: class extends Error {
        constructor(public section: string, public phase: string, public cause: unknown) {
            super(`Workspace export failed in ${section} (${phase})`)
        }
    }
}))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { error: jest.fn() } }))

import controller from './index'
import exportImportService from '../../services/export-import'
import { createExportDownload, ExportDownloadError } from '../../services/export-import/download'
import logger from '../../utils/logger'

const app = (workspaceId: string | undefined = 'workspace-1') => {
    const server = express()
    server.use(express.json())
    server.use((req, _res, next) => {
        req.user = { activeWorkspaceId: workspaceId } as Request['user']
        next()
    })
    server.post('/export', controller.exportData)
    server.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
        res.status(error.statusCode || 500).json({ message: error.message })
    })
    return server
}

describe('workspace export controller', () => {
    beforeEach(() => jest.clearAllMocks())

    it('streams a JSON attachment without calling the legacy aggregate export', async () => {
        ;(createExportDownload as jest.Mock).mockReturnValue(
            (async function* () {
                yield '{"ChatMessage":['
                yield '{"content":"안녕하세요"}'
                yield ']}'
            })()
        )
        const response = await request(app()).post('/export?download=true').send({ chat_message: true }).expect(200)
        expect(response.headers['content-disposition']).toBe('attachment; filename="ExportData.json"')
        expect(response.headers['cache-control']).toBe('no-store')
        expect(response.body).toEqual({ ChatMessage: [{ content: '안녕하세요' }] })
        expect(createExportDownload).toHaveBeenCalledWith({ chat_message: true }, 'workspace-1')
        expect(exportImportService.exportData).not.toHaveBeenCalled()
    })

    it('preserves the legacy JSON API response', async () => {
        ;(exportImportService.exportData as jest.Mock).mockResolvedValue({ FileDefaultName: 'ExportData.json', ChatFlow: [] })
        const response = await request(app()).post('/export').send({ chatflow: true }).expect(200)
        expect(response.body).toEqual({ FileDefaultName: 'ExportData.json', ChatFlow: [] })
        expect(createExportDownload).not.toHaveBeenCalled()
    })

    it.each(['gzip', 'identity'])('preserves the JSON backup with %s transfer encoding', async (encoding) => {
        const backup = { ChatMessage: [{ content: '대용량 백업 😀'.repeat(10000) }] }
        ;(createExportDownload as jest.Mock).mockReturnValue(
            (async function* () {
                yield JSON.stringify(backup)
            })()
        )
        const response = await request(app()).post('/export?download=true').set('Accept-Encoding', encoding).send({ chat_message: true })
        expect(response.status).toBe(200)
        expect(response.headers['content-encoding']).toBe(encoding === 'gzip' ? 'gzip' : undefined)
        expect(response.headers.vary).toContain('Accept-Encoding')
        expect(response.body).toEqual(backup)
    })

    it('rejects a missing workspace before starting a download', async () => {
        await request(app('')).post('/export?download=true').send({ chatflow: true }).expect(404)
        expect(createExportDownload).not.toHaveBeenCalled()
    })

    it('aborts a failed stream instead of returning a successful truncated backup', async () => {
        ;(createExportDownload as jest.Mock).mockReturnValue(
            (async function* () {
                yield '{"ChatMessage":['
                throw new Error('database unavailable')
            })()
        )
        await expect(request(app()).post('/export?download=true').send({ chat_message: true })).rejects.toThrow()
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('database unavailable'))
    })

    it('logs the failing section and driver code without SQL parameters or stored JSON', async () => {
        const cause = Object.assign(new Error('connection terminated'), { code: 'ECONNRESET', parameters: ['private content'] })
        ;(createExportDownload as jest.Mock).mockReturnValue(
            (async function* () {
                yield '{"ChatMessage":['
                throw new ExportDownloadError('ChatMessage', 'read', cause)
            })()
        )
        await expect(request(app()).post('/export?download=true').send({ chat_message: true })).rejects.toThrow()
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('section=ChatMessage phase=read code=ECONNRESET'))
        expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('private content')
    })

    it('does not include malformed stored data in a serialization error log', async () => {
        ;(createExportDownload as jest.Mock).mockReturnValue(
            (async function* () {
                yield '{"ChatFlow":['
                throw new ExportDownloadError('ChatFlow', 'serialize', new SyntaxError('Unexpected token in private content'))
            })()
        )
        await expect(request(app()).post('/export?download=true').send({ chatflow: true })).rejects.toThrow()
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid stored JSON'))
        expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('private content')
    })
})
