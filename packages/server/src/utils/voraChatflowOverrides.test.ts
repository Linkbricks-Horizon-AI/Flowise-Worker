import { getAPIOverrideConfig, replaceInputsWithConfig } from './index'

jest.mock('flowise-components', () => ({}))
jest.mock('./logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }))

const node = (id: string, label = 'Vora Chatflow Tool') =>
    ({
        id,
        label,
        name: label === 'Custom Tool' ? 'customTool' : 'VoraChatflowTool',
        inputs: { toolEnabled: true }
    } as any)

describe('Vora uses existing API override permissions and workflow-local IDs', () => {
    it('applies only allowed request variables to the Vora node', () => {
        const request = { vars: { user_id: 'user-A', tool_usage: '{"stable_tool_code":0}', other: 'private' } }
        const result = replaceInputsWithConfig(node('VoraChatflowTool_0'), request, {}, [
            { id: 'user_id', name: 'user_id', type: 'static', enabled: true },
            { id: 'tool_usage', name: 'tool_usage', type: 'static', enabled: true }
        ])
        expect(result.inputs!.vars).toEqual({ user_id: 'user-A', tool_usage: '{"stable_tool_code":0}' })
    })

    it('does not supply an identity when user_id override permission is missing', () => {
        const result = replaceInputsWithConfig(node('VoraChatflowTool_0'), { vars: { user_id: 'user-A', tool_usage: '{}' } }, {}, [
            { id: 'tool_usage', name: 'tool_usage', type: 'static', enabled: true }
        ])
        expect(result.inputs!.vars).toEqual({ tool_usage: '{}' })
    })

    it('defaults API Override to off and reads explicit variable grants', () => {
        expect(getAPIOverrideConfig({} as any).apiOverrideStatus).toBe(false)
        expect(
            getAPIOverrideConfig({
                apiConfig: JSON.stringify({
                    overrideConfig: {
                        status: true,
                        variables: [
                            { id: 'user_id', name: 'user_id', type: 'static', enabled: true },
                            { id: 'tool_usage', name: 'tool_usage', type: 'static', enabled: true }
                        ]
                    }
                })
            } as any)
        ).toMatchObject({
            apiOverrideStatus: true,
            variableOverrides: [
                { id: 'user_id', name: 'user_id', type: 'static', enabled: true },
                { id: 'tool_usage', name: 'tool_usage', type: 'static', enabled: true }
            ]
        })
    })

    it('supports parent tool removal and new IDs without matching a removed ID by name', () => {
        const config = { toolEnabled: { customTool_11: false, customTool_future: true } }
        const grants = { 'Custom Tool': [{ name: 'toolEnabled', enabled: true }] } as any
        expect(replaceInputsWithConfig(node('customTool_future', 'Custom Tool'), config, grants, []).inputs!.toolEnabled).toBe(true)
        expect(replaceInputsWithConfig(node('customTool_other', 'Custom Tool'), config, grants, []).inputs!.toolEnabled).toBe(true)
        expect(() => replaceInputsWithConfig(node('VoraChatflowTool_99'), config, {}, [])).not.toThrow()
    })

    it('uses the same stable quota map for a tool with different canvas IDs in two workflows', () => {
        for (const id of ['customTool_11', 'customTool_804']) {
            const result = replaceInputsWithConfig(node(id, 'Custom Tool'), { vars: { tool_usage: '{"same_code":0}' } }, {}, [
                { id: 'tool_usage', name: 'tool_usage', type: 'static', enabled: true }
            ])
            expect(result.inputs!.vars.tool_usage).toBe('{"same_code":0}')
        }
    })
})
