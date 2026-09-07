import { AIMessageChunk, coerceMessageLikeToMessage } from '@langchain/core/messages'
import { DynamicTool } from '@langchain/core/tools'

const { nodeClass: Agent } = require('./Agent')

const mockToolInit = jest.fn()
const mockModel = { invoke: jest.fn(), bindTools: jest.fn() }

jest.mock(
    './testTool',
    () => ({
        nodeClass: class {
            init = mockToolInit
        }
    }),
    { virtual: true }
)
jest.mock(
    './testModel',
    () => ({
        nodeClass: class {
            init = () => mockModel
        }
    }),
    { virtual: true }
)
jest.mock('../../../src/handler', () => ({}))
jest.mock('../../../src/utils', () => ({
    toolSchemaToJsonSchema: () => ({ type: 'object', properties: {} }),
    convertMultiOptionsToStringArray: (value: string[]) => value ?? [],
    processTemplateVariables: (state: any) => state,
    extractResponseContent: (response: AIMessageChunk) => response.content
}))
jest.mock('../utils', () => ({
    addImageArtifactsToMessages: jest.fn(),
    extractArtifactsFromResponse: async () => ({ artifacts: [], fileAnnotations: [] }),
    normalizeMessagesForStorage: (messages: any[]) => messages,
    revertBase64ImagesToFileRefs: (messages: any[]) => messages
}))
jest.mock('../../../src/modelLoader', () => ({}))

describe('Agentflow optional tool availability', () => {
    const options = {
        componentNodes: {
            testModel: { filePath: './testModel' },
            customTool: { name: 'customTool', label: 'Custom Tool', filePath: './testTool' },
            anotherTool: { name: 'anotherTool', label: 'Another Tool', filePath: './testTool' }
        },
        logger: { warn: jest.fn() },
        prependedChatHistory: [],
        agentflowRuntime: { state: {}, chatHistory: [] },
        chatflowid: 'flow-1'
    }
    const selectedTool = (name = 'customTool', requiresHumanInput = false) => ({
        agentSelectedTool: name,
        agentSelectedToolConfig: {},
        agentSelectedToolRequiresHumanInput: requiresHumanInput
    })
    const nodeData = (tools?: any[], agentMessages: { role: string; content: string }[] = []) => ({
        id: 'agent_1',
        inputs: { agentModel: 'testModel', agentModelConfig: {}, agentTools: tools, agentMessages }
    })
    const availableTool = (name = 'available_tool') =>
        new DynamicTool({ name, description: 'An available tool', func: async () => 'real result' })

    beforeEach(() => {
        jest.clearAllMocks()
        mockToolInit.mockReset()
        mockModel.invoke.mockReset().mockResolvedValue(new AIMessageChunk('Hello!'))
        mockModel.bindTools.mockReset().mockReturnValue(mockModel)
    })

    it('continues normal conversation with missing and disabled tool results', async () => {
        mockToolInit.mockResolvedValueOnce([]).mockResolvedValueOnce(null)
        const result = await new Agent().run(nodeData([selectedTool(), selectedTool()]), 'Hi', options)

        expect(result.output.content).toBe('Hello!')
        expect(mockModel.bindTools).not.toHaveBeenCalled()
        expect(mockModel.invoke.mock.calls[0][0][0].content).toContain('No tools are available in this request')
        expect(mockModel.invoke.mock.calls[0][0][0].content).toContain(
            'Never claim tool execution or results without a successful tool call'
        )
    })

    it('supports an omitted optional tool list', async () => {
        await expect(new Agent().run(nodeData(), 'Hi', options)).resolves.toMatchObject({ output: { content: 'Hello!' } })
        expect(mockModel.bindTools).not.toHaveBeenCalled()
    })

    it('merges availability guidance into the existing system message', async () => {
        const data = nodeData(undefined, [{ role: 'system', content: 'Existing instructions' }])
        await new Agent().run(data, 'Hi', options)
        const messages = mockModel.invoke.mock.calls[0][0].map(coerceMessageLikeToMessage)

        expect(messages.filter((message: any) => message.type === 'system')).toHaveLength(1)
        expect(messages[0].content).toContain('Existing instructions')
        expect(messages[0].content).toContain('No tools are available')
    })

    it('keeps surviving tool metadata and approval requirements aligned after excluding a missing reference', async () => {
        const survivingTool = availableTool()
        mockToolInit.mockResolvedValueOnce([]).mockResolvedValueOnce(survivingTool)
        const result = await new Agent().run(nodeData([selectedTool(), selectedTool('anotherTool', true)]), 'Hi', options)

        expect(mockModel.bindTools).toHaveBeenCalledWith([survivingTool])
        expect(survivingTool).toHaveProperty('requiresHumanInput', true)
        expect(result.output.availableTools).toEqual([
            expect.objectContaining({ name: 'available_tool', toolNode: { label: 'Another Tool', name: 'anotherTool' } })
        ])
    })

    it('keeps toolkit and subsequent single-tool metadata aligned', async () => {
        mockToolInit.mockResolvedValueOnce([availableTool('first'), availableTool('second')]).mockResolvedValueOnce(availableTool('third'))
        const result = await new Agent().run(nodeData([selectedTool(), selectedTool('anotherTool')]), 'Hi', options)

        expect(result.output.availableTools.map((tool: any) => tool.toolNode.name)).toEqual(['customTool', 'customTool', 'anotherTool'])
    })

    it('logs and excludes a tool component that is not installed', async () => {
        const survivingTool = availableTool()
        mockToolInit.mockResolvedValueOnce(survivingTool)
        const result = await new Agent().run(nodeData([selectedTool('missingComponent'), selectedTool()]), 'Hi', options)

        expect(result.output.content).toBe('Hello!')
        expect(mockModel.bindTools).toHaveBeenCalledWith([survivingTool])
        expect(options.logger.warn).toHaveBeenCalledWith(expect.stringContaining('"toolName":"missingComponent"'))
    })

    it.each(['authentication failed', 'permission denied', 'subscription check failed', 'database unavailable', 'invalid schema'])(
        'continues to fail initialization on %s',
        async (message) => {
            mockToolInit.mockRejectedValueOnce(new Error(message))
            await expect(new Agent().run(nodeData([selectedTool()]), 'Hi', options)).rejects.toThrow(message)
            expect(mockModel.invoke).not.toHaveBeenCalled()
            expect(options.logger.warn).not.toHaveBeenCalled()
        }
    )
})
