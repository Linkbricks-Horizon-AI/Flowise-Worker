import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, AIMessageChunk, BaseMessage } from '@langchain/core/messages'
import { ChatGenerationChunk } from '@langchain/core/outputs'
import { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager'
import { awaitAllCallbacks } from '@langchain/core/callbacks/promises'
import { DynamicTool } from '@langchain/core/tools'
import { IServerSideEventStreamer } from '../../../src/Interface'
import { AgentExecutor, ARTIFACTS_PREFIX, SOURCE_DOCUMENTS_PREFIX } from '../../../src/agents'
import { markTransparentTool } from '../../../src/transparentTool'

const { nodeClass: ToolAgent } = require('./ToolAgent')
const { nodeClass: ConversationalAgent } = require('../ConversationalAgent/ConversationalAgent')
const { nodeClass: XMLAgent } = require('../XMLAgent/XMLAgent')

jest.mock('../../../src/utils', () => ({
    getBaseClasses: () => [],
    transformBracesWithColon: (value: string) => value ?? 'You are a helpful assistant.',
    extractOutputFromArray: (value: string) => value,
    removeInvalidImageMarkdown: (value: string) => value,
    getEnvironmentVariable: () => undefined
}))
jest.mock('../../../src/handler', () => {
    const actual = jest.requireActual('../../../src/handler')
    return {
        ...actual,
        additionalCallbacks: async () => [],
        ConsoleCallbackHandler: class {
            name = 'test-logger'
        }
    }
})
jest.mock('../../../src/multiModalUtils', () => ({ llmSupportsVision: () => false }))
jest.mock('../../moderation/Moderation', () => ({}))
jest.mock('../../outputparsers/OutputParserHelpers', () => ({}))

const HWP = 'vora_tool_document_text_to_hwp_basic'
const SEARCH = 'vora_tool_knowledge_base_myfolder'
const CARD = '<div><a href="https://hwp.horizonai.ai/?token=test-token">Your hwp editor is ready!</a></div>'
const FINAL = CARD + '\n<!--TOTAL_CONTRIBUTION:{}-->\n<!--CHAT_TITLE:HWP 에디터 열기-->'

class ScriptedModel extends BaseChatModel {
    responses: AIMessage[] = []
    generated = 0
    bindTools = jest.fn(() => this)

    _llmType() {
        return 'direct-tool-return-regression'
    }

    next() {
        this.generated++
        const message = this.responses.shift()
        if (!message) throw new Error('Unexpected additional model invocation')
        return message
    }

    async _generate(_messages: BaseMessage[]) {
        const message = this.next()
        return { generations: [{ text: String(message.content), message }] }
    }

    async *_streamResponseChunks(_messages: BaseMessage[], _options: this['ParsedCallOptions'], runManager?: CallbackManagerForLLMRun) {
        const message = this.next()
        const text = String(message.content)
        if (text) await runManager?.handleLLMNewToken(text)
        yield new ChatGenerationChunk({ text, message: new AIMessageChunk({ content: message.content, tool_calls: message.tool_calls }) })
    }
}

function toolCall(names: string[]) {
    return new AIMessage({
        content: '',
        tool_calls: names.map((name, i) => ({ name, id: `call-${i}`, args: { input: '@vhwp' }, type: 'tool_call' }))
    })
}

function fixture({
    order = [HWP, SEARCH],
    streaming = true,
    maxIterations,
    nodeType = 'tool'
}: {
    order?: string[]
    streaming?: boolean
    maxIterations?: string
    nodeType?: 'tool' | 'conversational' | 'xml'
} = {}) {
    const model = new ScriptedModel({})
    model.responses = [toolCall(order), new AIMessage(FINAL)]
    const hwpCall = jest.fn(async () => CARD)
    const searchCall = jest.fn(async () => 'No matching documents')
    const hwp = new DynamicTool({ name: HWP, description: 'Open HWP', func: hwpCall, returnDirect: true })
    const search = new DynamicTool({ name: SEARCH, description: 'Search documents', func: searchCall })
    const events: { event: string; chatId: string; data: unknown }[] = []
    const emit = (event: string) => (chatId: string, data?: unknown) => events.push({ event, chatId, data })
    const streamer = {
        streamStartEvent: emit('start'),
        streamTokenEvent: emit('token'),
        streamEndEvent: emit('end'),
        streamUsedToolsEvent: emit('usedTools'),
        streamSourceDocumentsEvent: emit('sourceDocuments'),
        streamArtifactsEvent: emit('artifacts')
    } as unknown as IServerSideEventStreamer
    const memory = { getChatMessages: jest.fn(async () => []), addChatMessages: jest.fn(async () => {}) }
    const data = {
        id: 'toolAgent_0',
        inputs: {
            model,
            tools: [hwp, search],
            memory,
            systemMessage: nodeType === 'xml' ? 'Use {tools} to answer {input}.' : 'Use tools when requested.',
            maxIterations
        }
    }
    const options = { shouldStreamResponse: streaming, sseStreamer: streamer, chatId: 'chat-1', chatflowid: 'flow-1' }
    const Node = { tool: ToolAgent, conversational: ConversationalAgent, xml: XMLAgent }[nodeType]
    const node = new Node({ sessionId: 'session-1' })
    return {
        model,
        hwp,
        search,
        hwpCall,
        searchCall,
        events,
        streamer,
        memory,
        data,
        options,
        run: async () => {
            const result = await node.run(data, '@vhwp', options)
            await awaitAllCallbacks()
            return result
        },
        text: () =>
            events
                .filter((e) => e.event === 'token')
                .map((e) => e.data)
                .join('')
    }
}

describe('ToolAgent direct result streaming and persistence', () => {
    it.each([true, false])('hides a Vora wrapper while keeping direct output and child quota records, streaming=%s', async (streaming) => {
        const f = fixture({ order: [HWP], streaming })
        markTransparentTool(f.hwp)
        const child = { tool: 'child_music', toolInput: { query: 'jazz' }, toolOutput: 'QUOTA_EXHAUSTED:child_music' }
        jest.spyOn(f.hwp, 'call').mockImplementation(async (...args: any[]) => {
            args[3].usedTools = [child]
            return CARD
        })
        const result = await f.run()
        expect(result.text).toBe(CARD)
        expect(f.text()).toBe(streaming ? CARD : '')
        expect(result.usedTools).toEqual([{ ...child, streamed: true }])
        expect(f.memory.addChatMessages).toHaveBeenCalledWith(expect.arrayContaining([{ text: CARD, type: 'apiMessage' }]), 'session-1')
        if (streaming) expect(f.events.find((e) => e.event === 'usedTools')?.data).toEqual(result.usedTools)
    })

    it('keeps the direct-return receipt even when the child uses no tools', async () => {
        const f = fixture({ order: [HWP] })
        markTransparentTool(f.hwp)
        const result = await f.run()
        expect(result).toBe(CARD)
        expect(f.text()).toBe(CARD)
        expect(f.events.find((e) => e.event === 'usedTools')?.data).toEqual([])
    })

    it('uses instance identity, not the user-chosen wrapper name', async () => {
        const f = fixture({ order: [HWP] })
        f.hwp.name = 'arbitrary_hub_label'
        markTransparentTool(f.hwp)
        f.model.responses[0] = toolCall([f.hwp.name])
        expect(await f.run()).toBe(CARD)
        expect(f.text()).toBe(CARD)
        expect(f.events.find((e) => e.event === 'usedTools')?.data).toEqual([])
    })

    it('keeps future parent tools and child tools after the parent tool set changes', async () => {
        const f = fixture({ order: [HWP] })
        markTransparentTool(f.hwp)
        const newTool = new DynamicTool({ name: 'future_parent_tool', description: 'New tool', func: async () => 'new result' })
        // Remove the former parent SEARCH, then add a completely unrelated new tool.
        f.data.inputs.tools = [f.hwp, newTool]
        f.model.responses[0] = toolCall(['future_parent_tool', HWP])
        jest.spyOn(f.hwp, 'call').mockImplementation(async (...args: any[]) => {
            args[3].usedTools = [{ tool: SEARCH, toolInput: {}, toolOutput: 'child search' }]
            return CARD
        })
        const result = await f.run()
        expect(result.usedTools.map((t: any) => t.tool).sort()).toEqual([SEARCH, 'future_parent_tool'].sort())
        expect(f.text()).toBe(CARD)
        expect(f.model.generated).toBe(1)
    })

    it('preserves received child usage on a failed wrapper call, without exposing the wrapper', async () => {
        const f = fixture({ order: [HWP] })
        markTransparentTool(f.hwp)
        jest.spyOn(f.hwp, 'call').mockImplementation(async (...args: any[]) => {
            args[3].usedTools = [{ tool: 'actual_child', toolInput: {}, toolOutput: 'completed before failure' }]
            throw new Error('Child prediction failed')
        })
        const result = await f.run()
        expect(result.text).toBe('Child prediction failed')
        expect(f.text()).toBe('Child prediction failed')
        expect(result.usedTools.map((t: any) => t.tool)).toEqual(['actual_child'])
    })

    it('does not present an interrupted child stream as a completed answer or replay its partial text', async () => {
        const f = fixture({ order: [HWP] })
        markTransparentTool(f.hwp)
        jest.spyOn(f.hwp, 'call').mockImplementation(async (...args: any[]) => {
            const flow = args[3]
            flow.sseStreamer.streamTokenEvent(flow.chatId, 'partial child answer')
            flow.streamed = true
            throw new Error('Child stream ended before completion')
        })
        const result = await f.run()
        expect(result).toBe('Child stream ended before completion')
        expect(f.text()).toBe('partial child answer\n\nChild stream ended before completion')
        expect(f.events.find((e) => e.event === 'usedTools')?.data).toEqual([])
    })

    it('lets the parent compose a final answer when the wrapper is not direct', async () => {
        const f = fixture({ order: [HWP] })
        markTransparentTool(f.hwp)
        f.hwp.returnDirect = false
        const result = await f.run()
        expect(result).toBe(FINAL)
        expect(f.text()).toBe(FINAL)
        expect(f.model.generated).toBe(2)
    })

    it('emits the model-composed HWP card once after HWP + retrieval (production regression)', async () => {
        const f = fixture()
        const result = await f.run()
        expect(f.text()).toBe(FINAL)
        expect(result.text).toBe(FINAL)
        expect(f.hwpCall).toHaveBeenCalledTimes(1)
        expect(f.searchCall).toHaveBeenCalledTimes(1)
        expect(f.model.generated).toBe(2)
        expect(f.memory.addChatMessages).toHaveBeenCalledWith(
            [
                { text: '@vhwp', type: 'userMessage' },
                { text: FINAL, type: 'apiMessage' }
            ],
            'session-1'
        )
        expect(result.usedTools.map((t: any) => t.tool)).toEqual([HWP, SEARCH])
        expect(Object.keys(result).sort()).toEqual(['text', 'usedTools'])
        expect(f.events.every((e) => e.chatId === 'chat-1')).toBe(true)
    })

    it.each([[HWP], [SEARCH, HWP]])('keeps direct tool completion for action order %j', async (...names) => {
        const f = fixture({ order: names as string[] })
        const result = await f.run()
        expect(f.text()).toBe(CARD)
        expect(result.text).toBe(CARD)
        expect(f.hwpCall).toHaveBeenCalledTimes(1)
        expect(f.model.generated).toBe(1)
    })

    it('does not append a raw result when the model supplies a different final answer', async () => {
        const f = fixture()
        f.model.responses[1] = new AIMessage('편집기를 열었습니다.')
        const result = await f.run()
        expect(f.text()).toBe('편집기를 열었습니다.')
        expect(result.text).toBe(f.text())
        expect(result.usedTools[0].toolOutput).toBe(CARD)
    })

    it('does not resurrect an earlier direct output when the iteration limit stops execution', async () => {
        const f = fixture({ maxIterations: '1' })
        const result = await f.run()
        expect(f.text()).not.toContain(CARD)
        expect(result.text).toContain('Agent stopped')
        expect(f.hwpCall).toHaveBeenCalledTimes(1)
        expect(result.usedTools).toHaveLength(2)
    })

    it.each([[HWP], [HWP, SEARCH]])('keeps non-streaming final output and tool accounting for %j', async (...names) => {
        const order = names as string[]
        const f = fixture({ order, streaming: false })
        const result = await f.run()
        expect(f.events).toEqual([])
        expect(result.text).toBe(order.length === 1 ? CARD : FINAL)
        expect(f.hwpCall).toHaveBeenCalledTimes(1)
        expect(result.usedTools).toHaveLength(order.length)
    })

    it('does not bulk-emit a child chatflow that already streamed live, and preserves child tools', async () => {
        const f = fixture({ order: [HWP] })
        const childTool = { tool: SEARCH, toolInput: {}, toolOutput: 'child retrieval' }
        jest.spyOn(f.hwp, 'call').mockImplementation(async (...args: any[]) => {
            const flow = args[3]
            flow.sseStreamer.streamTokenEvent(flow.chatId, CARD)
            flow.streamed = true
            flow.usedTools = [childTool]
            return CARD
        })
        const result = await f.run()
        expect(f.text()).toBe(CARD)
        expect(result.text).toBe(CARD)
        expect(result.usedTools).toEqual([expect.objectContaining({ tool: HWP, streamed: true }), { ...childTool, streamed: true }])
    })

    it('does not suppress identical results in later independent requests', async () => {
        const first = fixture({ order: [HWP] })
        const second = fixture({ order: [HWP] })
        await Promise.all([first.run(), second.run()])
        expect(first.text()).toBe(CARD)
        expect(second.text()).toBe(CARD)
        expect(first.hwpCall).toHaveBeenCalledTimes(1)
        expect(second.hwpCall).toHaveBeenCalledTimes(1)
    })

    it.each([[HWP], [HWP, SEARCH]])('emits once when the planner returns cached values without LLM callbacks: %j', async (...names) => {
        const f = fixture({ order: names as string[] })
        const original = AgentExecutor.fromAgentAndTools
        const spy = jest.spyOn(AgentExecutor, 'fromAgentAndTools').mockImplementation((fields) => {
            const executor = original(fields)
            // Reproduce the documented cache callback contract: chain callbacks
            // still run, but no LLMStart/LLMNewToken callbacks are invoked.
            executor.agent.plan = jest.fn(async (steps) =>
                steps.length
                    ? { returnValues: { output: FINAL }, log: '' }
                    : names.map((name) => ({ tool: name as string, toolInput: { input: '@vhwp' }, log: '' }))
            )
            return executor
        })
        try {
            const result = await f.run()
            expect(f.text()).toBe(names.length === 1 ? CARD : FINAL)
            expect(result.text).toBe(f.text())
            expect(f.events.filter((e) => e.event === 'start')).toHaveLength(1)
            expect(f.hwpCall).toHaveBeenCalledTimes(1)
        } finally {
            spy.mockRestore()
        }
    })

    it('preserves source documents, artifacts, and raw tool usage when removing the redundant emit', async () => {
        const f = fixture()
        const docs = [{ pageContent: '관련 자료', metadata: { source: 'folder/document-1' } }]
        const artifacts = [{ type: 'link', data: 'https://example.test/source' }]
        f.searchCall.mockResolvedValue(
            'retrieval' + ARTIFACTS_PREFIX + JSON.stringify(artifacts) + SOURCE_DOCUMENTS_PREFIX + JSON.stringify(docs)
        )
        const result = await f.run()
        expect(f.text()).toBe(FINAL)
        expect(result.sourceDocuments).toEqual(docs)
        expect(result.artifacts).toEqual(artifacts)
        expect(f.events.find((e) => e.event === 'sourceDocuments')?.data).toEqual(docs)
        expect(f.events.find((e) => e.event === 'artifacts')?.data).toEqual(artifacts)
        expect(f.events.find((e) => e.event === 'usedTools')?.data).toEqual(result.usedTools)
        expect(result.usedTools[1]).toMatchObject({ tool: SEARCH, toolOutput: 'retrieval', streamed: false })
    })

    it('keeps multiple direct invocations, including identical outputs, as separate results', async () => {
        const f = fixture({ order: [HWP, HWP] })
        const result = await f.run()
        expect(f.text()).toBe(CARD + CARD)
        expect(f.hwpCall).toHaveBeenCalledTimes(2)
        expect(result.usedTools).toHaveLength(2)
        expect(result.usedTools.every((t: any) => t.toolOutput === CARD)).toBe(true)
    })

    it('preserves direct quota-exhaustion signals without retrying the tool', async () => {
        const f = fixture({ order: [HWP] })
        f.hwpCall.mockResolvedValue('QUOTA_EXHAUSTED:' + HWP)
        const result = await f.run()
        expect(f.text()).toBe('QUOTA_EXHAUSTED:' + HWP)
        expect(result.text).toBe(f.text())
        expect(f.hwpCall).toHaveBeenCalledTimes(1)
        expect(result.usedTools[0].toolOutput).toBe(f.text())
    })

    it('preserves tool errors and the subsequent model answer without replaying earlier outputs', async () => {
        const f = fixture()
        f.searchCall.mockRejectedValue(new Error('Search unavailable'))
        f.model.responses[1] = new AIMessage('검색을 완료하지 못했습니다.\n' + CARD)
        const result = await f.run()
        expect(f.text()).toBe(result.text)
        expect(f.text().split(CARD)).toHaveLength(2)
        expect(result.usedTools[1]).toMatchObject({ tool: SEARCH, error: 'Search unavailable', toolOutput: '' })
        expect(f.hwpCall).toHaveBeenCalledTimes(1)
        expect(f.searchCall).toHaveBeenCalledTimes(1)
    })

    it.each([
        ['conversational', true],
        ['conversational', false],
        ['xml', true],
        ['xml', false]
    ] as const)('keeps the %s agent direct result in streaming=%s', async (nodeType, streaming) => {
        const f = fixture({ nodeType, streaming, order: [HWP] })
        f.model.responses = [
            new AIMessage(
                nodeType === 'xml'
                    ? `<tool>${HWP}</tool><tool_input>@vhwp</tool_input>`
                    : JSON.stringify({ action: HWP, action_input: '@vhwp' })
            )
        ]
        const result = await f.run()
        expect(result.text).toBe(CARD)
        expect(f.text().split(CARD)).toHaveLength(streaming ? 2 : 1)
        expect(f.hwpCall).toHaveBeenCalledTimes(1)
        expect(result.usedTools[0]).toMatchObject({ tool: HWP, toolOutput: CARD })
        expect(Object.keys(result).sort()).toEqual(['text', 'usedTools'])
    })
})
