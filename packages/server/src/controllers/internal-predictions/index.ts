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
import { resolveTransportKey } from '../../utils/relayConfig'
import { finalizeSseResponse } from '../../queue/finalizeSseResponse'

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
    // Transport key (channel/SSE-slot/abort): relayExecutionId when the feature is on (per-execution
    // isolation), else the semantic chatId (legacy). chatId still flows to metadata/persistence unchanged.
    const { transportKey, relayExecutionId } = resolveTransportKey(chatId)

    try {
        sseStreamer.addClient(transportKey, res)
        // If the client disconnects before the stream finishes, abort the in-flight job so the
        // worker stops instead of running to completion. When relay-scoped, abort ONLY this execution
        // so a new message closing the previous stream doesn't kill a concurrent execution of the same
        // chat; else fall back to chat-scope abort. writableEnded guard: a normal completion never aborts.
        res.on('close', () => {
            if (res.writableEnded || !chatId) return
            const abortPromise = relayExecutionId
                ? chatMessagesService.abortExecution(relayExecutionId)
                : chatMessagesService.abortChatMessage(chatId, req.params.id)
            abortPromise.catch((err) => {
                logger.warn(`[server]: abort on client disconnect failed for ${transportKey}: ${getErrorMessage(err)}`)
            })
        })
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no') //nginx config: https://serverfault.com/a/801629
        res.flushHeaders()

        if (isQueueMode) {
            await getRunningExpressApp().redisSubscriber.subscribe(transportKey)
        }

        const apiResponse = await utilBuildChatflow(req, true, undefined, relayExecutionId)
        // Metadata slot key MUST be the transport key or the final metadata frame is dropped.
        sseStreamer.streamMetadataEvent(transportKey, apiResponse)
    } catch (error) {
        if (transportKey) {
            sseStreamer.streamErrorEvent(transportKey, getErrorMessage(error))
        }
        next(error)
    } finally {
        finalizeSseResponse({
            transportKey,
            sseStreamer,
            redisSubscriber: isQueueMode ? getRunningExpressApp().redisSubscriber : undefined
        })
    }
}
export default {
    createInternalPrediction
}
