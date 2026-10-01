import { StreamProgressHandler } from './streamProgress'
import type { IServerSideEventStreamer } from './Interface'

function setup() {
    const streamCustomEvent = jest.fn()
    const handler = new StreamProgressHandler({ streamCustomEvent } as unknown as IServerSideEventStreamer, 'chat')
    return { handler, streamCustomEvent, events: () => streamCustomEvent.mock.calls.map((call) => call[2]) }
}

describe('display-only stream progress', () => {
    it('emits phases without tokens, inputs, outputs or reasoning', () => {
        const { handler, streamCustomEvent, events } = setup()
        handler.handleLLMStart()
        handler.handleChatModelStart()
        handler.handleToolStart({ name: 'vora_tool_search_main' } as any, 'private query', 'tool1')
        handler.handleToolEnd('private result', 'tool1')
        handler.handleLLMStart()
        expect(events().map((event) => event.phase)).toEqual(['analyzing', 'collecting', 'composing'])
        expect(events().map((event) => event.sequence)).toEqual([1, 2, 3])
        expect(new Set(events().map((event) => event.runId)).size).toBe(1)
        expect(streamCustomEvent.mock.calls.every((call) => call[0] === 'chat' && call[1] === 'progress')).toBe(true)
        expect(JSON.stringify(events())).not.toMatch(/private|vora_tool|tool1/)
    })

    it('keeps parallel tools active and handles additional search after composition', () => {
        const { handler, events } = setup()
        handler.handleToolStart({ name: 'search' } as any, '', 'a')
        handler.handleToolStart({ name: 'search' } as any, '', 'b')
        handler.handleToolEnd('', 'a')
        handler.handleLLMStart()
        expect(events().map((event) => event.phase)).toEqual(['collecting'])
        handler.handleToolError(new Error('private error'), 'b')
        handler.handleLLMStart()
        handler.handleToolStart({ name: 'search' } as any, '', 'c')
        expect(events().map((event) => event.phase)).toEqual(['collecting', 'composing', 'collecting'])
    })

    it('tracks retrieval without reading document content and balances failures', () => {
        const { handler, events } = setup()
        handler.handleRetrieverStart({} as any, 'private query', 'retriever')
        handler.handleLLMStart()
        expect(events()).toHaveLength(1)
        expect(events()[0]).toMatchObject({ phase: 'collecting', activity: 'document' })
        handler.handleRetrieverError(new Error('private error'), 'retriever')
        handler.handleLLMStart()
        expect(events()[1].phase).toBe('composing')
        handler.handleRetrieverStart({} as any, 'private query', 'retriever-2')
        handler.handleRetrieverEnd([{ pageContent: 'private document' }], 'retriever-2')
        expect(JSON.stringify(events())).not.toContain('private')
    })

    it('does not claim that media generation is research and tolerates transport failure', () => {
        const { handler, streamCustomEvent, events } = setup()
        handler.handleToolStart({ name: 'generate_image' } as any, '', 'a')
        expect(events()[0]).toMatchObject({ phase: 'working', activity: 'image' })
        streamCustomEvent.mockImplementation(() => {
            throw new Error('disconnected')
        })
        handler.handleToolEnd('', 'a')
        expect(() => handler.handleLLMStart()).not.toThrow()
    })
})
