import { Readable } from 'stream'
import { Response } from 'node-fetch'
import { secureFetch } from '../../../src/httpSecurity'
import type { IToolFlowConfig } from '../../../src/Interface'

jest.mock('../../../src/httpSecurity', () => ({ secureFetch: jest.fn() }))
jest.mock('../../../src/utils', () => ({
    getCredentialData: async () => ({ chatflowApiKey: 'fixture-key' }),
    getCredentialParam: (_: string, data: any) => data.chatflowApiKey,
    parseWithTypeConversion: (schema: any, value: any) => schema.parseAsync(value)
}))

const { nodeClass: VoraNode } = require('./VoraChatflowTool')
const CHILD = '612ebad4-4a1d-4adf-aafc-64f8937ecb2c'
const fetchMock = jest.mocked(secureFetch)
const sse = (name: string, data: unknown) => `message:\ndata:${JSON.stringify({ event: name, data })}\n\n`
const streamResponse = (frames: string) =>
    new Response(Readable.from([Buffer.from(frames)]), { headers: { 'content-type': 'text/event-stream' } })
const jsonResponse = (text = 'answer') =>
    new Response(JSON.stringify({ text, usedTools: [{ tool: 'actual_child', toolInput: {}, toolOutput: 'data' }] }))
const inputs = (extra: any = {}) => ({
    selectedChatflow: CHILD,
    name: 'any_user_chosen_name',
    description: 'Search',
    returnDirect: true,
    vars: { user_id: 'user-A', tool_usage: '{"child_code":0}', private_value: 'must-not-inherit' },
    ...extra
})
const nodeOptions = { baseURL: 'https://flowise.example/', chatflowid: 'parent' }
const create = (extra: any = {}) => new VoraNode().init({ inputs: inputs(extra) }, 'parent question', nodeOptions)
const flow = (): IToolFlowConfig => ({
    sessionId: 'parent-session',
    chatId: 'parent-chat',
    sseStreamer: {
        streamStartEvent: jest.fn(),
        streamTokenEvent: jest.fn(),
        streamEndEvent: jest.fn(),
        streamUsedToolsEvent: jest.fn(),
        streamMetadataEvent: jest.fn()
    } as any
})
const bodyAt = (index = 0) => JSON.parse(fetchMock.mock.calls[index][1]!.body as string)

beforeEach(() => {
    fetchMock.mockReset()
})

describe('Vora node calls', () => {
    it('uses only the permission-applied vars, protects them from LLM arguments, and captures the init request', async () => {
        const data = { inputs: inputs({ overrideConfig: { vars: { user_id: 'manual', tool_usage: 'manual', locale: 'ko' } } }) }
        const tool = await new VoraNode().init(data, 'parent question', nodeOptions)
        data.inputs.vars.user_id = 'later-user'
        data.inputs.overrideConfig.vars.locale = 'changed'
        fetchMock.mockResolvedValue(jsonResponse())
        const context = flow()
        expect(
            await tool.call(
                { input: 'query', user_id: 'forged', overrideConfig: { vars: { user_id: 'forged' } } },
                undefined,
                undefined,
                context
            )
        ).toBe('answer')
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(fetchMock.mock.calls[0][0]).toBe(`https://flowise.example/api/v1/prediction/${CHILD}`)
        expect(bodyAt().overrideConfig).toEqual({
            sessionId: 'parent-session',
            vars: { user_id: 'user-A', tool_usage: '{"child_code":0}', locale: 'ko' }
        })
        expect(bodyAt().chatId).not.toBe('parent-chat')
        expect(bodyAt().streaming).toBe(true)
        expect(fetchMock.mock.calls[0][1]!.headers).toMatchObject({
            'flowise-tool': 'true',
            'flowise-tool-stream': 'true',
            Authorization: 'Bearer fixture-key'
        })
        expect(context.usedTools?.[0].tool).toBe('actual_child')
        expect(Object.keys(tool.schema.shape)).toEqual(['input'])
    })

    it.each([undefined, '', ' ', null, 99])('initializes without an identity but refuses to execute without one: %j', async (user_id) => {
        const tool = await create({ vars: { user_id } })
        await expect(tool.call({ input: 'query' })).rejects.toThrow('parent request user_id')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it.each([false, 'false'])('excludes a disabled node before credential or selection validation: %j', async (toolEnabled) => {
        expect(await new VoraNode().init({ inputs: { toolEnabled } }, '', {})).toBeNull()
    })

    it('ignores an unrelated parent node-ID map left by generic toolEnabled overrides', async () => {
        expect(await create({ toolEnabled: { customTool_11: false } })).toBeDefined()
    })

    it.each([
        [{ useQuestionFromChat: true, customInput: 'custom' }, 'parent question'],
        [{ useQuestionFromChat: false, customInput: 'custom' }, 'custom'],
        [{}, 'model question']
    ])('preserves input selection priority: %j', async (settings, question) => {
        fetchMock.mockResolvedValue(jsonResponse())
        await (await create(settings)).call({ input: 'model question' })
        expect(bodyAt().question).toBe(question)
    })

    it('uses new chat IDs in JSON mode and honors explicit sessions over new-session defaults', async () => {
        fetchMock.mockImplementation(async () => jsonResponse())
        const tool = await create({ returnDirect: false, startNewSession: true, overrideConfig: { sessionId: 'explicit' } })
        const contexts = [flow(), flow()]
        await Promise.all(contexts.map((context) => tool.call({ input: 'query' }, undefined, undefined, context)))
        expect(bodyAt(0).chatId).not.toBe(bodyAt(1).chatId)
        for (let i = 0; i < 2; i++) {
            expect(bodyAt(i).overrideConfig.sessionId).toBe('explicit')
            expect(bodyAt(i).streaming).toBe(false)
            expect(contexts[i].sseStreamer!.streamTokenEvent).not.toHaveBeenCalled()
        }
    })

    it('isolates new sessions per call while preserving the same request user', async () => {
        fetchMock.mockImplementation(async () => jsonResponse())
        const tool = await create({ startNewSession: true })
        await tool.call({ input: 'one' }, undefined, undefined, flow())
        await tool.call({ input: 'two' }, undefined, undefined, flow())
        expect(bodyAt(0).overrideConfig.sessionId).not.toBe(bodyAt(1).overrideConfig.sessionId)
        expect(bodyAt(0).overrideConfig.vars.user_id).toBe(bodyAt(1).overrideConfig.vars.user_id)
    })

    it('forwards only answer tokens, keeps final usage snapshots, and never ends the parent stream', async () => {
        const tools = [{ tool: 'child_code', toolInput: {}, toolOutput: 'QUOTA_EXHAUSTED:child_code' }]
        fetchMock.mockResolvedValue(
            streamResponse(
                sse('start', '') +
                    sse('token', '안녕') +
                    sse('token', '하세요') +
                    sse('usedTools', tools) +
                    sse('usedTools', tools) +
                    sse('metadata', { chatId: 'child', chatMessageId: 'child-message' }) +
                    sse('end', '[DONE]')
            )
        )
        const context = flow()
        expect(await (await create()).call({ input: 'query' }, undefined, undefined, context)).toBe('안녕하세요')
        expect(context.sseStreamer!.streamTokenEvent).toHaveBeenNthCalledWith(1, 'parent-chat', '안녕')
        expect(context.sseStreamer!.streamTokenEvent).toHaveBeenNthCalledWith(2, 'parent-chat', '하세요')
        expect(context.sseStreamer!.streamEndEvent).not.toHaveBeenCalled()
        expect((context.sseStreamer as any).streamMetadataEvent).not.toHaveBeenCalled()
        expect(context.streamed).toBe(true)
        expect(context.usedTools).toEqual(tools)
    })

    it.each(['no tokens', 'initial failure', 'partial failure', 'incomplete EOF'])('makes one prediction even for %s', async (kind) => {
        const frames =
            kind === 'no tokens'
                ? sse('end', '[DONE]')
                : kind === 'initial failure'
                ? sse('error', 'failure')
                : kind === 'partial failure'
                ? sse('token', 'partial') + sse('error', 'failure')
                : sse('token', 'partial')
        fetchMock.mockResolvedValue(streamResponse(frames))
        const result = (await create()).call({ input: 'query' }, undefined, undefined, flow())
        if (kind === 'no tokens') await expect(result).resolves.toBe('')
        else await expect(result).rejects.toThrow('Vora Chatflow Tool')
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('does not reissue a failed HTTP request', async () => {
        fetchMock.mockRejectedValue(new Error('connection failed'))
        await expect((await create()).call({ input: 'query' }, undefined, undefined, flow())).rejects.toThrow('connection failed')
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('keeps concurrent users and call-local tool usage separate', async () => {
        fetchMock.mockImplementation(async (_url, init) => {
            const body = JSON.parse(init!.body as string)
            const user = body.overrideConfig.vars.user_id
            return new Response(JSON.stringify({ text: user, usedTools: [{ tool: user, toolInput: {}, toolOutput: body.question }] }))
        })
        const a = await create({ vars: { user_id: 'A', tool_usage: '{"a":0}' } })
        const b = await create({ vars: { user_id: 'B', tool_usage: '{"b":9}' } })
        const first = flow(),
            second = flow()
        expect(
            await Promise.all([
                a.call({ input: 'one' }, undefined, undefined, first),
                b.call({ input: 'two' }, undefined, undefined, second)
            ])
        ).toEqual(['A', 'B'])
        expect(first.usedTools![0]).toMatchObject({ tool: 'A', toolOutput: 'one' })
        expect(second.usedTools![0]).toMatchObject({ tool: 'B', toolOutput: 'two' })
    })

    it('passes cancellation to fetch and does not send an already cancelled request', async () => {
        const controller = new AbortController()
        fetchMock.mockResolvedValue(jsonResponse())
        const tool = await create()
        await tool.call({ input: 'query' }, { signal: controller.signal })
        expect(fetchMock.mock.calls[0][1]!.signal).toBe(controller.signal)
        controller.abort()
        await expect(tool.call({ input: 'query' }, { signal: controller.signal })).rejects.toThrow('aborted')
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('rejects invalid URLs, child IDs and direct self calls', async () => {
        await expect(create({ baseURL: 'file:///etc/passwd' })).rejects.toThrow('base URL')
        await expect(create({ selectedChatflow: 'invalid' })).rejects.toThrow('chatflow ID')
        await expect(new VoraNode().init({ inputs: inputs() }, '', { ...nodeOptions, chatflowid: CHILD })).rejects.toThrow('same chatflow')
    })
})
