import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import exportImportService from '../../services/export-import'
import { createExportDownload } from '../../services/export-import/download'
import logger from '../../utils/logger'

const exportData = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: exportImportController.exportData - workspace ${workspaceId} not found!`
            )
        }
        const input = exportImportService.convertExportInput(req.body)
        if (req.query.download === 'true') {
            const download = createExportDownload(input, workspaceId)
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.setHeader('Content-Disposition', 'attachment; filename="ExportData.json"')
            res.setHeader('Cache-Control', 'no-store')
            await pipeline(Readable.from(download), res)
            return
        }
        const apiResponse = await exportImportService.exportData(input, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        if (res.headersSent || res.destroyed) {
            logger.error('Workspace export download failed', { error })
            res.destroy(error instanceof Error ? error : new Error('Export failed'))
            return
        }
        next(error)
    }
}

const importData = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: exportImportController.importData - organization ${orgId} not found!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: exportImportController.importData - workspace ${workspaceId} not found!`
            )
        }
        const subscriptionId = req.user?.activeOrganizationSubscriptionId || ''

        const importData = req.body
        if (!importData) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Error: exportImportController.importData - importData is required!')
        }

        await exportImportService.importData(importData, orgId, workspaceId, subscriptionId)
        return res.status(StatusCodes.OK).json({ message: 'success' })
    } catch (error) {
        next(error)
    }
}

const exportChatflowMessages = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: exportImportController.exportChatflowMessages - workspace ${workspaceId} not found!`
            )
        }

        const { chatflowId, chatType, feedbackType, startDate, endDate } = req.body
        if (!chatflowId) {
            throw new InternalFlowiseError(
                StatusCodes.BAD_REQUEST,
                'Error: exportImportController.exportChatflowMessages - chatflowId is required!'
            )
        }

        const apiResponse = await exportImportService.exportChatflowMessages(
            chatflowId,
            chatType,
            feedbackType,
            startDate,
            endDate,
            workspaceId
        )

        // Set headers for file download
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Content-Disposition', `attachment; filename="${chatflowId}-Message.json"`)

        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

export default {
    exportData,
    importData,
    exportChatflowMessages
}
