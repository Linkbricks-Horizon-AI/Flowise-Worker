import { RedisEventPublisher } from './RedisEventPublisher'
import { RedisEventSubscriber } from './RedisEventSubscriber'
import { SSEStreamer } from '../utils/SSEStreamer'
import { finalizeSseResponse } from './finalizeSseResponse'
import { resolveFollowUpPrompts } from '../utils/followUpPrompts'
import { generateFollowUpPrompts } from 'flowise-components'

// Exercise the component source through Jest without pulling that package's
// source tree into the server's separate TypeScript build configuration.
const { withDirectToolReturn, streamDirectToolReturn } = jest.requireActual('../../../components/src/directToolReturn')

jest.mock('flowise-components', () => ({ generateFollowUpPrompts: jest.fn() }))
jest.mock('../utils/redis', () => ({ createRedisClient: () => ({ on: jest.fn() }) }))
jest.mock('../utils/logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() }
}))

const CHAT_ID = 'subscriber-conversation'
const CARD = '<div><a href="https://hwp.horizonai.ai/?token=test">Open workspace</a></div>'
const FINAL = CARD + '\n<!--TOTAL_CONTRIBUTION:{}-->\n<!--CHAT_TITLE:HWP 에디터 열기-->'

describe('direct tool fix — existing external subscriber wire contract', () => {
    it.each([
        ['web', 'model'],
        ['web', 'direct'],
        ['worker', 'model'],
        ['worker', 'direct']
    ])('%s execution with %s completion preserves all metadata and terminal frames', async (mode, completion) => {
        const frames: { event: string; data: any }[] = []
        let closed = false
        const response = {
            write: (frame: string) => {
                frames.push(JSON.parse(frame.split('data:')[1]))
                return true
            },
            end: () => {
                closed = true
            }
        }
        const web = new SSEStreamer()
        const transportKey = mode === 'worker' ? 'per-request-relay-id' : CHAT_ID
        web.addExternalClient(transportKey, response as any)
        const subscriber = new RedisEventSubscriber(web)
        const publisher = new RedisEventPublisher()
        const envelopes: { channel: string; message: string }[] = []
        ;(publisher as any).safePublish = async (channel: string, message: string) => {
            envelopes.push({ channel, message })
            if (channel === transportKey) (subscriber as any).handleEvent(message)
        }
        const streamer = mode === 'worker' ? publisher.withChannel(transportKey) : web
        const usedTools = [
            { tool: 'vora_tool_document_text_to_hwp_basic', toolInput: { question: '@vhwp' }, toolOutput: CARD, streamed: false },
            { tool: 'vora_tool_knowledge_base_myfolder', toolInput: { query: 'documents' }, toolOutput: 'retrieval', streamed: false }
        ]
        const sourceDocuments = [{ pageContent: '자료', metadata: { source: 'folder-1' } }]
        const artifacts = [{ type: 'link', data: 'https://example.test/document' }]
        const text = completion === 'model' ? FINAL : CARD
        const result =
            completion === 'model'
                ? { text, usedTools, sourceDocuments, artifacts }
                : withDirectToolReturn({ text, usedTools, sourceDocuments, artifacts }, [usedTools[0]])

        streamer.streamStartEvent(CHAT_ID, '')
        if (completion === 'model') streamer.streamTokenEvent(CHAT_ID, text)
        streamer.streamUsedToolsEvent(CHAT_ID, usedTools)
        streamer.streamSourceDocumentsEvent(CHAT_ID, sourceDocuments)
        streamer.streamArtifactsEvent(CHAT_ID, artifacts)
        streamDirectToolReturn(result, streamer, CHAT_ID)
        streamDirectToolReturn(result, streamer, CHAT_ID) // cached callback + node share one receipt
        streamer.streamEndEvent(CHAT_ID) // node/LLM completion is not HTTP stream completion
        expect(closed).toBe(false)
        expect(frames.some((frame) => frame.event === 'end')).toBe(false)

        const questions = ['어떤 기능이 있나요?', 'How do I save?', '保存方法は？']
        ;(generateFollowUpPrompts as jest.Mock).mockResolvedValue({ questions })
        const followUpPrompts = await resolveFollowUpPrompts('{"status":true}', result.text, { chatId: CHAT_ID, chatflowid: 'flow-1' })
        expect(generateFollowUpPrompts).toHaveBeenLastCalledWith({ status: true }, text, { chatId: CHAT_ID, chatflowid: 'flow-1' })

        // The normal prediction completion path returns through JSON/BullMQ,
        // then the Web controller emits metadata before closing the SSE slot.
        const apiResponse = JSON.parse(
            JSON.stringify({
                ...result,
                chatId: CHAT_ID,
                chatMessageId: 'message-1',
                question: '@vhwp',
                sessionId: 'session-1',
                memoryType: 'redis',
                followUpPrompts: JSON.stringify(followUpPrompts),
                flowVariables: { selected: 'value' },
                action: JSON.stringify({ id: 'action-1' }),
                isStreamValid: true
            })
        )
        expect(Object.keys(apiResponse).sort()).toEqual(
            [
                'text',
                'usedTools',
                'sourceDocuments',
                'artifacts',
                'chatId',
                'chatMessageId',
                'question',
                'sessionId',
                'memoryType',
                'followUpPrompts',
                'flowVariables',
                'action',
                'isStreamValid'
            ].sort()
        )
        expect(apiResponse.usedTools).toEqual(usedTools)
        expect(apiResponse.sourceDocuments).toEqual(sourceDocuments)
        expect(apiResponse.artifacts).toEqual(artifacts)
        web.streamMetadataEvent(transportKey, apiResponse)
        finalizeSseResponse({ transportKey, sseStreamer: web })

        expect(
            frames
                .filter((frame) => frame.event === 'token')
                .map((frame) => frame.data)
                .join('')
        ).toBe(text)
        expect(frames.filter((frame) => frame.event === 'usedTools')).toEqual([{ event: 'usedTools', data: usedTools }])
        expect(frames.find((frame) => frame.event === 'sourceDocuments')?.data).toEqual(sourceDocuments)
        expect(frames.find((frame) => frame.event === 'artifacts')?.data).toEqual(artifacts)
        expect(frames.slice(-2)).toEqual([
            {
                event: 'metadata',
                data: {
                    chatId: CHAT_ID,
                    chatMessageId: 'message-1',
                    question: '@vhwp',
                    sessionId: 'session-1',
                    memoryType: 'redis',
                    followUpPrompts,
                    flowVariables: { selected: 'value' },
                    action: { id: 'action-1' }
                }
            },
            { event: 'end', data: '[DONE]' }
        ])
        expect(frames.filter((frame) => frame.event === 'start')).toHaveLength(1)
        expect(frames.filter((frame) => frame.event === 'end')).toHaveLength(1)
        expect(closed).toBe(true)
        if (mode === 'worker') expect(envelopes.every((envelope) => envelope.channel === transportKey)).toBe(true)
    })
})
