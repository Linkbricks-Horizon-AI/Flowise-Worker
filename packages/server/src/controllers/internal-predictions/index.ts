import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import { MODE } from '../../Interface'
import chatflowService from '../../services/chatflows'
import { utilBuildChatflow } from '../../utils/buildChatflow'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import chatMessagesService from '../../services/chat-messages'
import logger from '../../utils/logger'

// Send input message and get prediction result (Internal)
const createInternalPrediction = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const workspaceId = req.user?.activeWorkspaceId

        const chatflow = await chatflowService.getChatflowByIdForWorkspace(req.params.id, workspaceId)
        if (!chatflow) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${req.params.id} not found`)
        }

        if (req.body.streaming || req.body.streaming === 'true') {
            createAndStreamInternalPrediction(req, res, next)
            return
        } else {
            const apiResponse = await utilBuildChatflow(req, true)
            if (apiResponse) return res.json(apiResponse)
        }
    } catch (error) {
        next(error)
    }
}

// Send input message and stream prediction result using SSE (Internal)
const createAndStreamInternalPrediction = async (req: Request, res: Response, next: NextFunction) => {
    const chatId = req.body.chatId
    const sseStreamer = getRunningExpressApp().sseStreamer
    const isQueueMode = process.env.MODE === MODE.QUEUE

    try {
        sseStreamer.addClient(chatId, res)
        // If the client disconnects before the stream finishes, abort the in-flight job so the
        // worker stops instead of running to completion. Same abort path as an explicit user abort;
        // the writableEnded guard means a normal completion never triggers an abort.
        res.on('close', () => {
            if (res.writableEnded || !chatId) return
            chatMessagesService.abortChatMessage(chatId, req.params.id).catch((err) => {
                logger.warn(`[server]: abort on client disconnect failed for ${chatId}: ${getErrorMessage(err)}`)
            })
        })
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no') //nginx config: https://serverfault.com/a/801629
        res.flushHeaders()

        if (isQueueMode) {
            await getRunningExpressApp().redisSubscriber.subscribe(chatId)
        }

        const apiResponse = await utilBuildChatflow(req, true)
        sseStreamer.streamMetadataEvent(apiResponse.chatId, apiResponse)
    } catch (error) {
        if (chatId) {
            sseStreamer.streamErrorEvent(chatId, getErrorMessage(error))
        }
        next(error)
    } finally {
        if (isQueueMode && chatId) {
            await getRunningExpressApp().redisSubscriber.unsubscribe(chatId)
        }
        sseStreamer.removeClient(chatId)
    }
}
export default {
    createInternalPrediction
}
