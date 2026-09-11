import { streamDirectToolReturn, withDirectToolReturn } from './directToolReturn'
import type { IServerSideEventStreamer, IUsedTool } from './Interface'

function streamer() {
    return { streamStartEvent: jest.fn(), streamTokenEvent: jest.fn() } as unknown as IServerSideEventStreamer
}

describe('direct tool completion internal state and legacy token payloads', () => {
    it.each(['', 'result', { url: 'https://example.test/result' }])(
        'preserves a legacy payload without normalization: %j',
        (toolOutput) => {
            const tools: IUsedTool[] = [{ tool: 'direct_tool', toolInput: {}, toolOutput }]
            const values = withDirectToolReturn({ output: toolOutput, usedTools: tools }, tools)
            const target = streamer()
            streamDirectToolReturn(values, target, 'chat-1')
            expect(target.streamTokenEvent).toHaveBeenCalledTimes(1)
            expect(target.streamTokenEvent).toHaveBeenCalledWith('chat-1', toolOutput)
        }
    )

    it('does not add JSON fields or mutate the response and tool records', () => {
        const tools = [Object.freeze({ tool: 'direct_tool', toolInput: {}, toolOutput: 'result', streamed: false })]
        const original = Object.freeze({ output: 'result', usedTools: tools })
        const values = withDirectToolReturn(original, tools)
        streamDirectToolReturn(values, streamer(), 'chat-1')
        expect(JSON.stringify(values)).toBe(JSON.stringify(original))
        expect(Object.keys(values)).toEqual(Object.keys(original))
        expect(values.usedTools).toBe(tools)
        expect(tools[0].streamed).toBe(false)
    })

    it('shares a single emission across copied chain outputs and the cached callback', () => {
        const tools = [{ tool: 'direct_tool', toolInput: {}, toolOutput: 'result' }]
        const values = withDirectToolReturn({ output: 'result', usedTools: tools }, tools)
        const copiedValues = { ...values }
        const target = streamer()
        streamDirectToolReturn(values, target, 'chat-1', true)
        streamDirectToolReturn(copiedValues, target, 'chat-1')
        expect(target.streamStartEvent).toHaveBeenCalledTimes(1)
        expect(target.streamTokenEvent).toHaveBeenCalledTimes(1)
    })

    it('does not infer direct completion from public usedTools fields or matching answer text', () => {
        const target = streamer()
        const values = { output: 'result', usedTools: [{ tool: 'direct_tool', toolInput: {}, toolOutput: 'result' }] }
        expect(streamDirectToolReturn(values, target, 'chat-1')).toBe(false)
        expect(target.streamTokenEvent).not.toHaveBeenCalled()
    })

    it('does not consume an emission when there is no transport', () => {
        const tools = [{ tool: 'direct_tool', toolInput: {}, toolOutput: 'result' }]
        const values = withDirectToolReturn({ output: 'result' }, tools)
        streamDirectToolReturn(values, undefined, 'chat-1')
        const target = streamer()
        streamDirectToolReturn(values, target, 'chat-1')
        expect(target.streamTokenEvent).toHaveBeenCalledWith('chat-1', 'result')
    })
})
