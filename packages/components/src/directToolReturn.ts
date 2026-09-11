import type { ChainValues } from '@langchain/core/utils/types'
import type { IServerSideEventStreamer, IUsedTool } from './Interface'

// Invocation-local metadata, not part of the prediction/usedTools JSON contract.
// BaseChain copies output values with object spreads, which preserve this symbol.
const DIRECT_TOOL_RETURN = Symbol('flowise.directToolReturn')

type DirectToolReturnValues = ChainValues & {
    [DIRECT_TOOL_RETURN]?: { tools: IUsedTool[]; emitted: boolean }
}

export function withDirectToolReturn(values: ChainValues, tools: IUsedTool[]): ChainValues {
    return { ...values, [DIRECT_TOOL_RETURN]: { tools, emitted: false } }
}

/**
 * Only an executor that actually ended with returnDirect owns a raw tool emit.
 * A model-completed answer must not be followed by its earlier tool results.
 * The cached-chain callback and the agent node share this per-result receipt,
 * so either path can deliver direct results without delivering them twice.
 */
export function streamDirectToolReturn(
    values: ChainValues,
    streamer: IServerSideEventStreamer | undefined,
    chatId: string,
    start = false
): boolean {
    const directReturn = (values as DirectToolReturnValues)[DIRECT_TOOL_RETURN]
    if (!directReturn) return false
    if (!streamer || directReturn.emitted) return true

    directReturn.emitted = true
    for (const tool of directReturn.tools) {
        // Child chatflows may have already forwarded their tokens live. Their
        // usedTools must remain available for accounting, but are not new text.
        if (!tool.streamed) {
            // Preserve the existing token payload, including empty strings and
            // legacy object results. This fix must not normalize the wire format.
            const output = tool.toolOutput as string
            if (start) {
                streamer.streamStartEvent(chatId, output)
                start = false
            }
            streamer.streamTokenEvent(chatId, output)
        }
    }
    return true
}
