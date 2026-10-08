import type { NextFunction, Request, Response } from 'express'

const mockGetChatflowById = jest.fn()
const mockCheckIfChatflowIsValidForStreaming = jest.fn()
const mockBuildChatflow = jest.fn()
const mockFinalizeSseResponse = jest.fn()
const mockAbortExecution = jest.fn()
const mockAbortChatMessage = jest.fn()
const mockSseStreamer = {
    addExternalClient: jest.fn(),
    streamMetadataEvent: jest.fn(),
    streamErrorEvent: jest.fn()
}
const mockRedisSubscriber = {
    subscribe: jest.fn().mockResolvedValue(undefined)
}

jest.mock('../../services/chatflows', () => ({
    __esModule: true,
    default: {
        getChatflowById: mockGetChatflowById,
        checkIfChatflowIsValidForStreaming: mockCheckIfChatflowIsValidForStreaming
    }
}))
jest.mock('../../services/predictions', () => ({
    __esModule: true,
    default: { buildChatflow: mockBuildChatflow }
}))
jest.mock('../../services/chat-messages', () => ({
    __esModule: true,
    default: {
        abortExecution: mockAbortExecution,
        abortChatMessage: mockAbortChatMessage
    }
}))
jest.mock('../../utils/rateLimit', () => ({
    RateLimiterManager: {
        getInstance: () => ({
            getRateLimiter: () => (_req: Request, _res: Response, next: NextFunction) => next()
        })
    }
}))
jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        sseStreamer: mockSseStreamer,
        redisSubscriber: mockRedisSubscriber
    })
}))
jest.mock('../../utils/relayConfig', () => ({
    resolveTransportKey: (chatId: string) => ({ transportKey: `transport:${chatId}`, relayExecutionId: 'relay-1' })
}))
jest.mock('../../queue/finalizeSseResponse', () => ({
    finalizeSseResponse: mockFinalizeSseResponse
}))
jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }
}))
jest.mock('uuid', () => ({ v4: () => 'generated-chat-id' }))

import predictionsController from './index'

const makeRequest = (body: Record<string, any>): Request =>
    ({
        params: { id: 'flow-1' },
        body,
        headers: {},
        user: undefined
    } as unknown as Request)

const makeResponse = (): Response => {
    const json = jest.fn()
    const status = jest.fn()
    const send = jest.fn()
    const on = jest.fn()
    const response = {
        writableEnded: false,
        json,
        status,
        send,
        on,
        setHeader: jest.fn(),
        flushHeaders: jest.fn()
    } as unknown as Response
    json.mockReturnValue(response)
    status.mockReturnValue(response)
    send.mockReturnValue(response)
    on.mockReturnValue(response)
    return response
}

describe('createPrediction ChatFlow reuse', () => {
    const chatflow = {
        id: 'flow-1',
        workspaceId: 'workspace-1',
        flowData: JSON.stringify({ nodes: [], edges: [] })
    }

    beforeEach(() => {
        jest.clearAllMocks()
        delete process.env.MODE
        mockGetChatflowById.mockResolvedValue(chatflow)
    })

    it('reuses the origin-validated ChatFlow for streaming checks and execution without changing overrides', async () => {
        const overrideConfig = {
            sessionId: 'session-1',
            systemMessage: 'subscriber system message',
            vars: { user_id: 'user-1' }
        }
        const request = makeRequest({ question: 'hello', streaming: true, overrideConfig })
        const response = makeResponse()
        const next = jest.fn()
        mockCheckIfChatflowIsValidForStreaming.mockResolvedValue({ isStreaming: true })
        mockBuildChatflow.mockResolvedValue({ chatId: 'session-1', text: 'ok' })

        await predictionsController.createPrediction(request, response, next)

        expect(mockGetChatflowById).toHaveBeenCalledTimes(1)
        expect(mockCheckIfChatflowIsValidForStreaming).toHaveBeenCalledWith('flow-1', chatflow)
        expect(mockBuildChatflow).toHaveBeenCalledWith(request, undefined, 'relay-1', chatflow)
        expect(request.body.overrideConfig).toBe(overrideConfig)
        expect(request.body.chatId).toBe('session-1')
        expect(mockSseStreamer.streamMetadataEvent).toHaveBeenCalledWith(
            'transport:session-1',
            expect.objectContaining({ chatId: 'session-1' })
        )
        expect(next).not.toHaveBeenCalled()
    })

    it('reuses the same ChatFlow for non-streaming execution', async () => {
        const overrideConfig = { sessionId: 'json-session', maxTokens: 512 }
        const request = makeRequest({ question: 'hello', streaming: false, overrideConfig })
        const response = makeResponse()
        const next = jest.fn()
        const result = { text: 'ok' }
        mockCheckIfChatflowIsValidForStreaming.mockResolvedValue({ isStreaming: true })
        mockBuildChatflow.mockResolvedValue(result)

        await predictionsController.createPrediction(request, response, next)

        expect(mockGetChatflowById).toHaveBeenCalledTimes(1)
        expect(mockCheckIfChatflowIsValidForStreaming).toHaveBeenCalledWith('flow-1', chatflow)
        expect(mockBuildChatflow).toHaveBeenCalledWith(request, undefined, undefined, chatflow)
        expect(request.body.overrideConfig).toBe(overrideConfig)
        expect(response.json).toHaveBeenCalledWith(result)
        expect(mockSseStreamer.addExternalClient).not.toHaveBeenCalled()
        expect(next).not.toHaveBeenCalled()
    })
})
