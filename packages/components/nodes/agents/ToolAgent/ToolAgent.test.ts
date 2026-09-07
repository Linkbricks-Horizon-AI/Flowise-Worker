import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, BaseMessage, SystemMessage, coerceMessageLikeToMessage } from '@langchain/core/messages'
import { ChatPromptTemplate } from '@langchain/core/prompts'
import { DynamicTool } from '@langchain/core/tools'
import { withToolAvailabilityMessage } from '../../../src/agents'

const { nodeClass: ToolAgent } = require('./ToolAgent')
const { nodeClass: CustomTool } = require('../../tools/CustomTool/CustomTool')

jest.mock('../../../src/utils', () => ({
    getBaseClasses: () => [],
    transformBracesWithColon: (value: string) => value ?? 'You are a helpful assistant.',
    getVars: jest.fn().mockResolvedValue([])
}))
jest.mock('../../../src/handler', () => ({}))
jest.mock('../../../src/multiModalUtils', () => ({ llmSupportsVision: () => false }))
jest.mock('../../moderation/Moderation', () => ({}))
jest.mock('../../outputparsers/OutputParserHelpers', () => ({}))

class RecordingModel extends BaseChatModel {
    messages: BaseMessage[][] = []
    responses: AIMessage[] = []
    bindTools = jest.fn(() => this)

    _llmType() {
        return 'test-recording-model'
    }

    async _generate(messages: BaseMessage[]) {
        this.messages.push(messages)
        const message = this.responses.shift() ?? new AIMessage('Hello!')
        return { generations: [{ text: String(message.content), message }] }
    }
}

describe('ToolAgent with unavailable optional tools', () => {
    const options = {
        appDataSource: { getRepository: () => ({ findOneBy: jest.fn().mockResolvedValue(null) }) },
        databaseEntities: { Tool: 'Tool' },
        logger: { warn: jest.fn() },
        chatflowid: 'flow-1'
    }
    const createMissingTool = () => new CustomTool().init({ id: 'customTool_1', inputs: { selectedTool: 'deleted-tool' } }, '', options)
    const createNodeData = (model: RecordingModel, tools: any[], chatPromptTemplate?: ChatPromptTemplate) => ({
        id: 'toolAgent_1',
        inputs: {
            model,
            tools,
            systemMessage: 'You are a helpful assistant.',
            chatPromptTemplate,
            memory: { getChatMessages: jest.fn().mockResolvedValue([]) }
        }
    })

    it('keeps ordinary conversation working when every referenced tool is missing', async () => {
        const model = new RecordingModel({})
        const executor = await new ToolAgent().init(createNodeData(model, [await createMissingTool()]), 'Hi', options)

        await expect(executor.invoke({ input: 'Hi' })).resolves.toMatchObject({ output: 'Hello!' })
        expect(model.bindTools).not.toHaveBeenCalled()
        expect(model.messages[0][0].content).toContain('No tools are available in this request')
        expect(model.messages[0][0].content).toContain('explain that the feature is currently unavailable')
        expect(model.messages[0][0].content).toContain('Never claim tool execution or results without a successful tool call')
    })

    it('executes a remaining tool after excluding a missing reference', async () => {
        const model = new RecordingModel({})
        const call = jest.fn().mockResolvedValue('real tool result')
        const availableTool = new DynamicTool({ name: 'available_tool', description: 'An available tool', func: call })
        model.responses = [
            new AIMessage({
                content: '',
                tool_calls: [{ id: 'call-1', name: 'available_tool', args: { input: 'hello' }, type: 'tool_call' }]
            }),
            new AIMessage('The available tool completed.')
        ]
        const executor = await new ToolAgent().init(
            createNodeData(model, [await createMissingTool(), availableTool]),
            'Use the tool',
            options
        )

        await expect(executor.invoke({ input: 'Use the tool' })).resolves.toMatchObject({ output: 'The available tool completed.' })
        expect(model.bindTools).toHaveBeenCalledWith([availableTool])
        expect(call).toHaveBeenCalledTimes(1)
        expect(model.messages[1].some((message) => message.content === 'real tool result')).toBe(true)
        expect(model.messages[0][0].content).toContain('Only the tools provided in this request are available')
    })

    it('includes availability guidance with a custom prompt and disabled tools', async () => {
        const model = new RecordingModel({})
        const customPrompt = ChatPromptTemplate.fromMessages([
            ['system', 'Use the former avatar tool when requested.'],
            ['human', '{input}']
        ])
        const executor = await new ToolAgent().init(createNodeData(model, [null, await createMissingTool()], customPrompt), 'Hi', options)

        await expect(executor.invoke({ input: 'Hi' })).resolves.toMatchObject({ output: 'Hello!' })
        expect(model.bindTools).not.toHaveBeenCalled()
        expect(model.messages[0][0].content).toContain('No tools are available')
        expect(model.messages[0][0].content).toContain('Use the former avatar tool when requested.')
        expect(model.messages[0].filter((message) => message.type === 'system')).toHaveLength(1)
    })

    it('does not suppress model tool binding errors', async () => {
        const model = new RecordingModel({})
        model.bindTools.mockImplementation(() => {
            throw new Error('permission denied')
        })
        const availableTool = new DynamicTool({ name: 'available_tool', description: 'An available tool', func: async () => 'done' })
        await expect(new ToolAgent().init(createNodeData(model, [availableTool]), 'Hi', options)).rejects.toThrow('permission denied')
    })

    it('allows a model without tool binding only when no tools remain', async () => {
        const model = new RecordingModel({})
        Object.defineProperty(model, 'bindTools', { value: undefined })
        const executor = await new ToolAgent().init(createNodeData(model, [await createMissingTool()]), 'Hi', options)
        await expect(executor.invoke({ input: 'Hi' })).resolves.toMatchObject({ output: 'Hello!' })

        const availableTool = new DynamicTool({ name: 'available_tool', description: 'An available tool', func: async () => 'done' })
        await expect(new ToolAgent().init(createNodeData(model, [availableTool]), 'Hi', options)).rejects.toThrow('bindTools()')
    })

    it('preserves structured system content and leaves reusable messages untouched', () => {
        const content = [{ type: 'text', text: 'Custom instructions', cache_control: { type: 'ephemeral' } }]
        const original = new SystemMessage({ content, name: 'custom-system' })
        const result = withToolAvailabilityMessage([original, ['human', 'Hi']], false).map(coerceMessageLikeToMessage)

        expect(result.filter((message) => message.type === 'system')).toHaveLength(1)
        expect(result[0].content).toEqual([
            content[0],
            expect.objectContaining({ type: 'text', text: expect.stringContaining('No tools are available') })
        ])
        expect(result[0].name).toBe('custom-system')
        expect(original.content).toEqual(content)
        expect(content).toHaveLength(1)
    })
})
