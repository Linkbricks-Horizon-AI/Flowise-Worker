import { getAPIOverrideConfig, replaceInputsWithConfig, resolveVariables } from './index'

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

describe('request variables in explicit child workflow mappings', () => {
    const grants = [
        { id: 'context', name: 'vora_works_word_context_ref', type: 'static', enabled: true },
        { id: 'locale', name: 'vora_tool_ui_language', type: 'static', enabled: true }
    ]
    const defaults = () =>
        [
            { name: 'vora_works_word_context_ref', type: 'static', value: 'workspace-default' },
            { name: 'vora_tool_ui_language', type: 'static', value: 'en' },
            { name: 'denied', type: 'static', value: 'workspace-policy' }
        ] as any
    const mappedNode = (vars: Record<string, string>) =>
        ({
            id: 'VoraChatflowTool_2',
            name: 'VoraChatflowTool',
            inputParams: [{ name: 'overrideConfig', acceptVariable: true }],
            inputs: {
                overrideConfig: JSON.stringify({
                    vars: {
                        vora_works_word_context_ref: '{{$vars.vora_works_word_context_ref}}',
                        vora_tool_ui_language: '{{$vars.vora_tool_ui_language}}',
                        denied: '{{$vars.denied}}',
                        flowise_source_chatflow_id: '{{$flow.chatflowId}}'
                    }
                }),
                vars
            }
        } as any)
    const resolve = async (vars: Record<string, string>, available = defaults()) => {
        const result = await resolveVariables(mappedNode(vars), [], 'request', [], { chatflowId: 'main' }, undefined, available, grants)
        return JSON.parse(result.inputs!.overrideConfig).vars
    }
    it('uses permission-filtered request context and locale in the explicit child mapping', async () => {
        const result = await resolve({ vora_works_word_context_ref: 'current-context', vora_tool_ui_language: 'ko' })
        expect(result).toMatchObject({
            vora_works_word_context_ref: 'current-context',
            vora_tool_ui_language: 'ko',
            flowise_source_chatflow_id: 'main'
        })
    })
    it('does not override a variable without the current API grant', async () => {
        expect((await resolve({ denied: 'attacker-value' })).denied).toBe('workspace-policy')
    })
    it('does not mutate reusable workspace defaults or carry context between requests', async () => {
        const available = defaults()
        await resolve({ vora_works_word_context_ref: 'first-context' }, available)
        expect(available).toEqual(defaults())
        const next = await resolve({ vora_works_word_context_ref: 'second-context' }, available)
        expect(next.vora_works_word_context_ref).toBe('second-context')
        expect((await resolve({}, available)).vora_works_word_context_ref).toBe('workspace-default')
    })
    it('preserves an allowed request variable without a workspace default', async () => {
        expect((await resolve({ vora_works_word_context_ref: 'fresh-context' }, [])).vora_works_word_context_ref).toBe('fresh-context')
    })
})
