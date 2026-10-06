import http from 'http'
import type { AddressInfo } from 'net'
import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, AIMessageChunk, BaseMessage } from '@langchain/core/messages'
import { ChatGenerationChunk } from '@langchain/core/outputs'
import { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager'
import { awaitAllCallbacks } from '@langchain/core/callbacks/promises'
import { DynamicTool } from '@langchain/core/tools'
import type { IServerSideEventStreamer } from '../../../src/Interface'

// Keep the real HTTP client, callback machinery, agents and Vora tool. Only provider,
// credential storage and unrelated integrations are fixtures; no paid APIs are called.
jest.mock('../../../src/utils', () => ({
    getBaseClasses: () => [],
    transformBracesWithColon: (value: string) => value,
    extractOutputFromArray: (value: string) => value,
    removeInvalidImageMarkdown: (value: string) => value,
    getEnvironmentVariable: () => undefined,
    getCredentialData: async () => ({ chatflowApiKey: 'fixture-key' }),
    getCredentialParam: (_: string, data: any) => data.chatflowApiKey,
    parseWithTypeConversion: (schema: any, value: any) => schema.parseAsync(value)
}))
jest.mock('../../../src/handler', () => ({
    ...jest.requireActual('../../../src/handler'),
    additionalCallbacks: async () => [],
    ConsoleCallbackHandler: class {
        name = 'fixture-logger'
    }
}))
jest.mock('../../../src/multiModalUtils', () => ({ llmSupportsVision: () => false }))
jest.mock('../../moderation/Moderation', () => ({}))
jest.mock('../../outputparsers/OutputParserHelpers', () => ({}))

const { nodeClass: VoraNode } = require('./VoraChatflowTool')
const { nodeClass: ToolAgent } = require('../../agents/ToolAgent/ToolAgent')
const CHILD = '612ebad4-4a1d-4adf-aafc-64f8937ecb2c'
const SECOND_CHILD = 'c2cb97d7-9b09-4fd0-b972-5c918b9a42b9'
const CODE = 'vora_tool_search_music'
const RAW = '{"track":"재즈","source":"fixture"}'
const CHILD_ANSWER = '검색 결과를 정리한 자식 답변입니다.'
const PARENT_ANSWER = '부모가 추가로 정리한 답변입니다.'
const call = (name: string) =>
    new AIMessage({ content: '', tool_calls: [{ name, args: { input: '재즈 검색' }, id: 'fixture-call', type: 'tool_call' }] })

class FixtureModel extends BaseChatModel {
    responses: AIMessage[] = []
    generated = 0
    bindTools = jest.fn(() => this)
    _llmType() {
        return 'vora-child-fixture'
    }
    next() {
        this.generated++
        const message = this.responses.shift()
        if (!message) throw new Error('Unexpected model call')
        return message
    }
    async _generate(_messages: BaseMessage[]) {
        const message = this.next()
        return { generations: [{ text: String(message.content), message }] }
    }
    async *_streamResponseChunks(_messages: BaseMessage[], _options: this['ParsedCallOptions'], manager?: CallbackManagerForLLMRun) {
        const message = this.next()
        const text = String(message.content)
        if (text) await manager?.handleLLMNewToken(text)
        yield new ChatGenerationChunk({ text, message: new AIMessageChunk({ content: message.content, tool_calls: message.tool_calls }) })
    }
}

function streamer(emit: (event: string, chatId: string, data?: any) => void): IServerSideEventStreamer {
    return {
        streamStartEvent: (id: string, data: any) => emit('start', id, data),
        streamTokenEvent: (id: string, data: any) => emit('token', id, data),
        streamUsedToolsEvent: (id: string, data: any) => emit('usedTools', id, data),
        streamSourceDocumentsEvent: (id: string, data: any) => emit('sourceDocuments', id, data),
        streamArtifactsEvent: (id: string, data: any) => emit('artifacts', id, data),
        streamEndEvent: () => {} // Only the HTTP execution, not an LLM callback, owns terminal end.
    } as unknown as IServerSideEventStreamer
}
const memory = () => ({ getChatMessages: async () => [], addChatMessages: jest.fn(async (..._args: any[]) => {}) })

describe('parent ToolAgent → real prediction HTTP → child ToolAgent', () => {
    let server: http.Server
    let baseURL: string
    let childDirect = false
    let toolExecutions = 0
    let childModels: FixtureModel[] = []
    let requests: any[] = []
    const previousSecurity = process.env.HTTP_SECURITY_CHECK
    const previousDeny = process.env.HTTP_DENY_LIST

    beforeAll(async () => {
        // Local fixture only. Restore the process environment when the test ends.
        process.env.HTTP_SECURITY_CHECK = 'false'
        process.env.HTTP_DENY_LIST = ''
        server = http.createServer((req, res) => {
            void (async () => {
                let raw = ''
                for await (const chunk of req) raw += chunk.toString()
                const body = JSON.parse(raw)
                requests.push({ body, url: req.url, headers: req.headers })
                const vars = body.overrideConfig.vars
                const tool = new DynamicTool({
                    name: CODE,
                    description: 'Free music search',
                    returnDirect: childDirect,
                    func: async () => {
                        // The existing free-tool header reads TOOL_CODE, never a canvas node ID.
                        const remaining = Number(JSON.parse(vars.tool_usage || '{}')[CODE])
                        if (!Number.isNaN(remaining) && remaining !== -1 && remaining <= 0) return 'QUOTA_EXHAUSTED:' + CODE
                        toolExecutions++
                        return RAW
                    }
                })
                const model = new FixtureModel({})
                model.responses = [call(CODE), new AIMessage(CHILD_ANSWER)]
                childModels.push(model)
                if (body.streaming) res.setHeader('content-type', 'text/event-stream')
                const childStreamer = streamer((event, _id, data) => {
                    res.write(`message:\ndata:${JSON.stringify({ event, data })}\n\n`)
                })
                const node = new ToolAgent({ sessionId: body.overrideConfig.sessionId })
                const result = await node.run(
                    {
                        id: 'toolAgent_child_99',
                        inputs: { model, tools: [tool], memory: memory(), systemMessage: 'Summarize search results.' }
                    },
                    body.question,
                    {
                        shouldStreamResponse: body.streaming,
                        sseStreamer: body.streaming ? childStreamer : undefined,
                        chatId: body.chatId,
                        chatflowid: CHILD
                    }
                )
                if (body.streaming) {
                    res.end('message:\ndata:{"event":"end","data":"[DONE]"}\n\n')
                } else {
                    res.setHeader('content-type', 'application/json')
                    res.end(JSON.stringify(typeof result === 'string' ? { text: result } : result))
                }
            })().catch((error) => {
                res.statusCode = 500
                res.end(JSON.stringify({ error: error.message }))
            })
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })

    afterAll(async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
        if (previousSecurity === undefined) delete process.env.HTTP_SECURITY_CHECK
        else process.env.HTTP_SECURITY_CHECK = previousSecurity
        if (previousDeny === undefined) delete process.env.HTTP_DENY_LIST
        else process.env.HTTP_DENY_LIST = previousDeny
    })

    beforeEach(() => {
        toolExecutions = 0
        childModels = []
        requests = []
    })

    async function run(
        parentDirect: boolean,
        streaming: boolean,
        remaining = 1,
        user = 'user-A',
        selectedChatflow = CHILD,
        nodeOverrides: Record<string, unknown> = {}
    ) {
        const hub = await new VoraNode().init(
            {
                id: 'VoraChatflowTool_7',
                inputs: {
                    selectedChatflow,
                    name: 'free_search_hub',
                    description: 'Search public information',
                    returnDirect: parentDirect,
                    useQuestionFromChat: true,
                    vars: { user_id: user, tool_usage: JSON.stringify({ [CODE]: remaining, future_tool: 9 }) },
                    toolEnabled: { customTool_11: false }, // Unrelated parent ID left by generic overrides.
                    ...nodeOverrides
                }
            },
            '사용자 질문',
            { baseURL, chatflowid: 'parent' }
        )
        const model = new FixtureModel({})
        model.responses = [call(hub.name), new AIMessage(PARENT_ANSWER)]
        const events: any[] = []
        const parentMemory = memory()
        const node = new ToolAgent({ sessionId: `session-${user}` })
        const result = await node.run(
            {
                id: 'toolAgent_parent_0',
                inputs: {
                    model,
                    tools: [hub],
                    memory: parentMemory,
                    systemMessage: 'Use the search hub.'
                }
            },
            '사용자 질문',
            {
                shouldStreamResponse: streaming,
                sseStreamer: streaming ? streamer((event, chatId, data) => events.push({ event, chatId, data })) : undefined,
                chatId: `parent-${user}`,
                chatflowid: 'parent'
            }
        )
        await awaitAllCallbacks()
        return {
            result,
            model,
            events,
            parentMemory,
            text: events
                .filter((e) => e.event === 'token')
                .map((e) => e.data)
                .join('')
        }
    }

    it.each([
        [false, true, true],
        [true, true, true],
        [false, false, true],
        [true, false, true],
        [false, true, false],
        [true, true, false],
        [false, false, false],
        [true, false, false]
    ])('child direct=%s, parent direct=%s, parent streaming=%s', async (inner, outer, streaming) => {
        childDirect = inner
        const f = await run(outer, streaming)
        const expected = outer ? (inner ? RAW : CHILD_ANSWER) : PARENT_ANSWER
        expect(f.result.text).toBe(expected)
        expect(f.text).toBe(streaming ? expected : '')
        expect(toolExecutions).toBe(1)
        expect(requests).toHaveLength(1)
        expect(childModels[0].generated).toBe(inner ? 1 : 2)
        expect(f.model.generated).toBe(outer ? 1 : 2)
        expect(f.result.usedTools.map((tool: any) => tool.tool)).toEqual([CODE])
        expect(f.result.usedTools[0]).toMatchObject({
            tool: CODE,
            toolInput: { input: '재즈 검색' },
            toolOutput: RAW
        })
        // In particular, child direct ON + parent direct OFF takes the child JSON
        // path. Usage must survive into both the public parent SSE event and JSON.
        const publicTools = JSON.parse(JSON.stringify(f.result)).usedTools
        expect(publicTools).toHaveLength(1)
        expect(publicTools[0].tool).toBe(CODE)
        const usageEvents = f.events.filter((event) => event.event === 'usedTools')
        if (streaming) {
            expect(usageEvents.length).toBeGreaterThan(0)
            expect(usageEvents[usageEvents.length - 1].data).toEqual(publicTools)
        } else {
            expect(usageEvents).toEqual([])
        }
        expect(requests[0].body.streaming).toBe(outer && streaming)
        expect(requests[0].body.overrideConfig).toEqual({
            sessionId: 'session-user-A',
            vars: {
                user_id: 'user-A',
                tool_usage: JSON.stringify({ [CODE]: 1, future_tool: 9 })
            }
        })
        expect(requests[0].body.chatId).not.toBe('parent-user-A')
        expect(requests[0].headers.authorization).toBe('Bearer fixture-key')
        expect(requests[0].url).toBe(`/api/v1/prediction/${CHILD}`)
        expect(f.events.every((event) => event.chatId === 'parent-user-A')).toBe(true)
    })

    it('preserves the child quota signal and performs no search when the map contains zero', async () => {
        childDirect = true
        const f = await run(true, true, 0)
        expect(toolExecutions).toBe(0)
        expect(f.text).toBe('QUOTA_EXHAUSTED:' + CODE)
        expect(f.result.usedTools[0].toolOutput).toBe(f.text)
        expect(f.result.usedTools).toHaveLength(1)
    })

    it.each([
        [false, false],
        [false, true],
        [true, false],
        [true, true]
    ])('supports a canvas request without vars: parent direct=%s, streaming=%s', async (direct, streaming) => {
        childDirect = true
        const f = await run(direct, streaming, 1, 'canvas', CHILD, { vars: undefined, requireUserId: false })
        const expected = direct ? RAW : PARENT_ANSWER
        expect(f.result.text).toBe(expected)
        expect(f.text).toBe(streaming ? expected : '')
        expect(requests).toHaveLength(1)
        expect(requests[0].body.question).toBe('사용자 질문')
        expect(requests[0].body.overrideConfig.vars).toEqual({ user_id: '', tool_usage: '' })
        expect(toolExecutions).toBe(1)
        expect(f.result.usedTools.map((tool: any) => tool.tool)).toEqual([CODE])
        if (streaming) expect(f.events.filter((event) => event.event === 'usedTools').at(-1).data).toEqual(f.result.usedTools)
    })

    it('supports distinct child selections and concurrent users without ID mapping', async () => {
        childDirect = false
        const [a, b] = await Promise.all([run(true, true, 1, 'A'), run(true, true, -1, 'B', SECOND_CHILD)])
        expect(a.text).toBe(CHILD_ANSWER)
        expect(b.text).toBe(CHILD_ANSWER)
        expect(requests.map((req) => req.url).sort()).toEqual([CHILD, SECOND_CHILD].map((id) => `/api/v1/prediction/${id}`).sort())
        expect(new Set(requests.map((req) => req.body.chatId)).size).toBe(2)
        for (const { body } of requests) expect(body.overrideConfig.sessionId).toBe(`session-${body.overrideConfig.vars.user_id}`)
        expect(toolExecutions).toBe(2)
    })
})
