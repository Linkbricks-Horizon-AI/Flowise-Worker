import type { Request } from 'express'

const mockUtilBuildChatflow = jest.fn()

jest.mock('../../utils/buildChatflow', () => ({
    utilBuildChatflow: mockUtilBuildChatflow
}))

import predictionsService from './index'

describe('buildChatflow', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('forwards a request-scoped ChatFlow without changing the request or queue transport arguments', async () => {
        const request = { params: { id: 'flow-1' }, body: { overrideConfig: { sessionId: 'session-1' } } } as unknown as Request
        const preloadedChatflow = { id: 'flow-1', workspaceId: 'workspace-1' }
        const result = { text: 'ok' }
        mockUtilBuildChatflow.mockResolvedValue(result)

        await expect(predictionsService.buildChatflow(request, undefined, 'relay-1', preloadedChatflow as any)).resolves.toBe(result)
        expect(mockUtilBuildChatflow).toHaveBeenCalledWith(request, false, undefined, 'relay-1', preloadedChatflow)
    })
})
