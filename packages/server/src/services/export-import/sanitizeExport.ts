// Keep the downloadable backup compatible with the UI's exportImport sanitizers.
// Sanitize one record at a time so the complete backup is never a single JS string.
type ExportRecord = Record<string, any>

const pick = (record: ExportRecord, keys: string[]): ExportRecord => Object.fromEntries(keys.map((key) => [key, record[key]]))

const removeCredentialIds = (value: any): any => {
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(removeCredentialIds)
    return Object.fromEntries(
        Object.entries(value)
            .filter(([key]) => key !== 'FLOWISE_CREDENTIAL_ID')
            .map(([key, entry]) => [key, removeCredentialIds(entry)])
    )
}

const sanitizeFlow = (record: ExportRecord): ExportRecord => {
    const flow = JSON.parse(record.flowData)
    const nodes = flow.nodes.map((node: ExportRecord) => {
        const data = pick(node.data, [
            'id',
            'label',
            'version',
            'name',
            'type',
            'color',
            'hideOutput',
            'hideInput',
            'baseClasses',
            'tags',
            'category',
            'description',
            'inputParams',
            'inputAnchors',
            'outputAnchors',
            'outputs'
        ])
        data.inputs = Object.fromEntries(
            Object.entries(node.data.inputs || {}).filter(([name]) => {
                const param = node.data.inputParams?.find((input: ExportRecord) => input.name === name)
                return !param || !['password', 'file', 'folder'].includes(param.type)
            })
        )
        data.selected = false
        return { ...node, selected: false, data: removeCredentialIds(data) }
    })
    return { ...pick(record, ['id', 'name', 'type']), flowData: JSON.stringify({ nodes, edges: flow.edges }) }
}

export const sanitizeExportRecord = (section: string, record: ExportRecord): ExportRecord => {
    switch (section) {
        case 'AgentFlow':
        case 'AgentFlowV2':
        case 'AssistantFlow':
        case 'ChatFlow':
            return sanitizeFlow(record)
        case 'AssistantCustom':
        case 'AssistantOpenAI':
        case 'AssistantAzure':
            return pick(record, ['id', 'details', 'credential', 'iconSrc', 'type'])
        case 'Tool':
            return pick(record, ['id', 'name', 'description', 'color', 'iconSrc', 'schema', 'func'])
        case 'Variable':
            return { ...pick(record, ['id', 'name', 'type']), value: '' }
        case 'CustomTemplate':
            return { ...record, usecases: JSON.stringify(record.usecases), workspaceId: undefined }
        case 'DocumentStore':
            return { ...record, workspaceId: undefined }
        case 'Execution':
            return {
                ...record,
                workspaceId: undefined,
                agentflow: record.agentflow ? { ...record.agentflow, workspaceId: undefined } : record.agentflow
            }
        default:
            return record
    }
}
