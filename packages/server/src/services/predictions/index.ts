import { Request } from 'express'
import { StatusCodes } from 'http-status-codes'
import { utilBuildChatflow } from '../../utils/buildChatflow'
import { ChatType } from '../../Interface'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import type { ChatFlow } from '../../database/entities/ChatFlow'

const buildChatflow = async (req: Request, chatType?: ChatType, relayExecutionId?: string, preloadedChatflow?: ChatFlow) => {
    try {
        const dbResponse = await utilBuildChatflow(req, false, chatType, relayExecutionId, preloadedChatflow)
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: predictionsServices.buildChatflow - ${getErrorMessage(error)}`
        )
    }
}

export default {
    buildChatflow
}
