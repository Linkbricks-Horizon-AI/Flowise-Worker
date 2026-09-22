import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'

jest.mock('../../services/export-import', () => ({
    __esModule: true,
    default: { convertExportInput: jest.fn((body) => body), exportData: jest.fn() }
}))
jest.mock('../../services/export-import/download', () => ({ createExportDownload: jest.fn() }))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { error: jest.fn() } }))

import controller from './index'
import exportImportService from '../../services/export-import'
import { createExportDownload } from '../../services/export-import/download'

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
    })
})
