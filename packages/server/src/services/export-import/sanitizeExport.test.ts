import { sanitizeExportRecord } from './sanitizeExport'

describe('download export sanitization', () => {
    it.each(['ChatFlow', 'AgentFlow', 'AgentFlowV2', 'AssistantFlow'])('preserves the existing %s backup contract', (section) => {
        const record = {
            id: 'flow-1',
            name: '한글 flow',
            type: 'CHATFLOW',
            workspaceId: 'private-workspace',
            apikeyid: 'api-key',
            flowData: JSON.stringify({
                nodes: [
                    {
                        id: 'node-1',
                        position: { x: 10, y: 20 },
                        selected: true,
                        data: {
                            id: 'node-1',
                            label: 'Node',
                            version: 2,
                            credential: 'credential-id',
                            instance: 'runtime-only',
                            inputParams: [
                                { name: 'secret', type: 'password' },
                                { name: 'file', type: 'file' },
                                { name: 'folder', type: 'folder' }
                            ],
                            inputs: {
                                secret: 'secret',
                                file: 'file-content',
                                folder: '/private',
                                prompt: 'hello',
                                nested: [{ FLOWISE_CREDENTIAL_ID: 'nested-secret', keep: true }]
                            },
                            outputAnchors: [],
                            outputs: { output: 'result' }
                        }
                    }
                ],
                edges: [{ source: 'node-1', target: 'node-2' }],
                viewport: { zoom: 1 }
            })
        }
        const before = JSON.stringify(record)
        const exported = sanitizeExportRecord(section, record)
        expect(Object.keys(exported).sort()).toEqual(['flowData', 'id', 'name', 'type'])
        const flow = JSON.parse(exported.flowData)
        expect(flow.nodes[0]).toMatchObject({ position: { x: 10, y: 20 }, selected: false })
        expect(flow.nodes[0].data.inputs).toEqual({ prompt: 'hello', nested: [{ keep: true }] })
        expect(flow.nodes[0].data).not.toHaveProperty('credential')
        expect(flow.nodes[0].data).not.toHaveProperty('instance')
        expect(flow.edges).toEqual([{ source: 'node-1', target: 'node-2' }])
        expect(flow).not.toHaveProperty('viewport')
        expect(JSON.stringify(record)).toBe(before)
    })

    it('keeps assistant references and tool code while excluding workspace metadata', () => {
        const assistant = sanitizeExportRecord('AssistantCustom', { id: 'a', details: '{}', credential: 'ref', workspaceId: 'ws' })
        expect(assistant.credential).toBe('ref')
        expect(assistant).not.toHaveProperty('workspaceId')
        const tool = sanitizeExportRecord('Tool', { id: 't', name: 'Tool', func: 'return "안녕"', schema: '[]', workspaceId: 'ws' })
        expect(tool.func).toBe('return "안녕"')
        expect(tool.schema).toBe('[]')
        expect(tool).not.toHaveProperty('workspaceId')
    })

    it('blanks variable values and preserves shared template import fields', () => {
        expect(sanitizeExportRecord('Variable', { id: 'v', name: 'secret', type: 'static', value: 'secret', workspaceId: 'ws' })).toEqual({
            id: 'v',
            name: 'secret',
            type: 'static',
            value: ''
        })
        expect(
            sanitizeExportRecord('CustomTemplate', {
                id: 't',
                type: 'Tool',
                func: 'return 1',
                usecases: ['Chat'],
                shared: true,
                workspaceId: 'ws'
            })
        ).toEqual({ id: 't', type: 'Tool', func: 'return 1', usecases: '["Chat"]', shared: true, workspaceId: undefined })
    })

    it('removes execution workspace fields without mutating the database record', () => {
        const record = { id: 'e', workspaceId: 'ws', executionData: '[]', agentflow: { id: 'f', workspaceId: 'ws', flowData: '{}' } }
        const exported = sanitizeExportRecord('Execution', record)
        expect(JSON.parse(JSON.stringify(exported))).toEqual({ id: 'e', executionData: '[]', agentflow: { id: 'f', flowData: '{}' } })
        expect(record.agentflow.workspaceId).toBe('ws')
    })

    it.each(['ChatMessage', 'ChatMessageFeedback', 'DocumentStoreFileChunk'])('keeps all %s content and references', (section) => {
        const row = { id: '1', content: '안녕 "quoted"\nnext', chatflowid: 'f', executionId: 'e', metadata: '{"x":1}' }
        expect(sanitizeExportRecord(section, row)).toEqual(row)
    })

    it('fails on malformed flow data instead of silently exporting an empty workflow', () => {
        expect(() => sanitizeExportRecord('ChatFlow', { id: 'bad', flowData: '{' })).toThrow()
    })
})
