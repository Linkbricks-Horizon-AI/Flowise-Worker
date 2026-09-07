import { z } from 'zod/v3'
import { getVars } from '../../../src/utils'
import { SecureZodSchemaParser } from '../../../src/secureZodParser'

const { nodeClass: CustomTool } = require('./CustomTool')

jest.mock('../../../src/utils', () => ({
    getBaseClasses: () => [],
    convertSchemaToZod: () => ({}),
    getVars: jest.fn().mockResolvedValue([])
}))

describe('CustomTool availability', () => {
    const findOneBy = jest.fn()
    const warn = jest.fn()
    const options = {
        appDataSource: { getRepository: () => ({ findOneBy }) },
        databaseEntities: { Tool: 'Tool' },
        logger: { warn },
        chatflowid: 'flow-1'
    }
    const nodeData = { id: 'customTool_1', inputs: { selectedTool: 'deleted-tool-id' } }
    const storedTool = { name: 'available_tool', description: 'An available tool', schema: '[]', func: 'return "done"' }

    beforeEach(() => {
        jest.clearAllMocks()
        findOneBy.mockReset().mockResolvedValue(null)
        jest.mocked(getVars).mockResolvedValue([])
    })

    it('excludes a deleted reference and logs identifiers without initializing it', async () => {
        const result = await new CustomTool().init(nodeData, '', options)

        expect(result).toEqual([])
        expect(findOneBy).toHaveBeenCalledWith({ id: 'deleted-tool-id' })
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"toolId":"deleted-tool-id"'))
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"nodeId":"customTool_1"'))
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"chatflowId":"flow-1"'))
        expect(getVars).not.toHaveBeenCalled()
    })

    it('does not recreate a deleted tool from API overrides', async () => {
        const result = await new CustomTool().init(
            { ...nodeData, inputs: { ...nodeData.inputs, customToolFunc: 'return "fake success"', customToolName: 'overridden_tool' } },
            '',
            options
        )
        expect(result).toEqual([])
    })

    it('uses the console when no operational logger is supplied', async () => {
        const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            await expect(new CustomTool().init(nodeData, '', { ...options, logger: undefined })).resolves.toEqual([])
            expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('Referenced tool not found'))
        } finally {
            consoleWarn.mockRestore()
        }
    })

    it.each([false, 'false'])('preserves the explicit disabled gate (%s)', async (toolEnabled) => {
        await expect(new CustomTool().init({ ...nodeData, inputs: { toolEnabled } }, '', options)).resolves.toBeNull()
        expect(findOneBy).not.toHaveBeenCalled()
        expect(warn).not.toHaveBeenCalled()
    })

    it.each([undefined, null, '', '   '])('rejects an invalid selection before querying (%s)', async (selectedTool) => {
        await expect(new CustomTool().init({ ...nodeData, inputs: { selectedTool } }, '', options)).rejects.toThrow('selected tool ID')
        expect(findOneBy).not.toHaveBeenCalled()
        expect(warn).not.toHaveBeenCalled()
    })

    it.each(['authentication failed', 'permission denied', 'subscription check failed', 'database unavailable', 'Tool lookup not found'])(
        'propagates lookup failures: %s',
        async (message) => {
            findOneBy.mockRejectedValue(new Error(message))
            await expect(new CustomTool().init(nodeData, '', options)).rejects.toThrow(message)
            expect(warn).not.toHaveBeenCalled()
        }
    )

    it('preserves valid tool configuration and schema overrides', async () => {
        findOneBy.mockResolvedValue(storedTool)
        const schema = z.object({ query: z.string() })
        const parseSchema = jest.spyOn(SecureZodSchemaParser, 'parseZodSchema').mockReturnValue(schema)
        try {
            const tool = await new CustomTool().init(
                {
                    ...nodeData,
                    inputs: {
                        ...nodeData.inputs,
                        customToolName: 'renamed_tool',
                        customToolDesc: 'Overridden description',
                        customToolFunc: 'return "override"',
                        customToolSchema: 'z.object({ query: z.string() })',
                        returnDirect: true
                    }
                },
                '',
                options
            )
            expect(tool).toMatchObject({
                name: 'renamed_tool',
                description: 'Overridden description',
                code: 'return "override"',
                schema,
                returnDirect: true
            })
            expect(warn).not.toHaveBeenCalled()
        } finally {
            parseSchema.mockRestore()
        }
    })

    it('still rejects invalid schemas on existing tools', async () => {
        findOneBy.mockResolvedValue(storedTool)
        await expect(
            new CustomTool().init({ ...nodeData, inputs: { ...nodeData.inputs, customToolSchema: 'not a zod schema' } }, '', options)
        ).rejects.toThrow()
        expect(warn).not.toHaveBeenCalled()
    })

    it('still rejects variable lookup failures on existing tools', async () => {
        findOneBy.mockResolvedValue(storedTool)
        jest.mocked(getVars).mockRejectedValue(new Error('permission denied'))
        await expect(new CustomTool().init(nodeData, '', options)).rejects.toThrow('permission denied')
        expect(warn).not.toHaveBeenCalled()
    })
})
