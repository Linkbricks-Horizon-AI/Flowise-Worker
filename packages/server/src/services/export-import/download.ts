import { EntityTarget, ObjectLiteral, SelectQueryBuilder } from 'typeorm'
import { Platform } from '../../Interface'
import { Assistant } from '../../database/entities/Assistant'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { ChatMessageFeedback } from '../../database/entities/ChatMessageFeedback'
import { DocumentStore } from '../../database/entities/DocumentStore'
import { DocumentStoreFileChunk } from '../../database/entities/DocumentStoreFileChunk'
import { Execution } from '../../database/entities/Execution'
import { Tool } from '../../database/entities/Tool'
import { Variable } from '../../database/entities/Variable'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import marketplacesService from '../marketplaces'
import type { ExportInput } from './index'
import { sanitizeExportRecord } from './sanitizeExport'

const EXPORT_PAGE_SIZE = 100

export type ExportSection = {
    name: string
    records: () => AsyncIterable<ObjectLiteral> | Promise<ObjectLiteral[]>
}

// A stable ID cursor avoids loading the entire history or counting all rows on every page.
export async function* readExportRows(query: SelectQueryBuilder<ObjectLiteral>): AsyncGenerator<ObjectLiteral> {
    let cursor: string | undefined
    while (true) {
        const page = query.clone().orderBy('record.id', 'ASC').take(EXPORT_PAGE_SIZE)
        if (cursor) page.andWhere('record.id > :exportCursor', { exportCursor: cursor })
        const rows = await page.getMany()
        for (const row of rows) yield row
        if (rows.length < EXPORT_PAGE_SIZE) return
        cursor = rows[rows.length - 1].id
    }
}

export async function* generateExportJson(sections: ExportSection[]): AsyncGenerator<string> {
    yield '{'
    for (let index = 0; index < sections.length; index++) {
        const section = sections[index]
        yield `${index ? ',' : ''}\n${JSON.stringify(section.name)}:[`
        let first = true
        for await (const record of await section.records()) {
            const serialized = JSON.stringify(sanitizeExportRecord(section.name, record))
            yield `${first ? '' : ','}\n${serialized}`
            first = false
        }
        yield '\n]'
    }
    yield '\n}\n'
}

export const createExportDownload = (input: ExportInput, workspaceId: string): AsyncGenerator<string> => {
    if (!workspaceId) throw new Error('Workspace ID is required')
    const app = getRunningExpressApp()
    const query = (entity: EntityTarget<ObjectLiteral>) => app.AppDataSource.getRepository(entity).createQueryBuilder('record')
    const scoped = (entity: EntityTarget<ObjectLiteral>) => query(entity).where('record.workspaceId = :workspaceId', { workspaceId })
    const flow = (type: string) => readExportRows(scoped(ChatFlow).andWhere('record.type = :type', { type }))
    const assistant = (type: string) => readExportRows(scoped(Assistant).andWhere('record.type = :type', { type }))
    const messages = (entity: typeof ChatMessage | typeof ChatMessageFeedback) =>
        readExportRows(
            query(entity)
                .innerJoin(ChatFlow, 'parent', 'parent.id = record.chatflowid')
                .where('parent.workspaceId = :workspaceId', { workspaceId })
        )
    const definitions: (ExportSection & { option: keyof ExportInput })[] = [
        { name: 'AgentFlow', option: 'agentflow', records: () => flow('MULTIAGENT') },
        { name: 'AgentFlowV2', option: 'agentflowv2', records: () => flow('AGENTFLOW') },
        { name: 'AssistantFlow', option: 'assistantCustom', records: () => flow('ASSISTANT') },
        { name: 'AssistantCustom', option: 'assistantCustom', records: () => assistant('CUSTOM') },
        { name: 'AssistantOpenAI', option: 'assistantOpenAI', records: () => assistant('OPENAI') },
        { name: 'AssistantAzure', option: 'assistantAzure', records: () => assistant('AZURE') },
        { name: 'ChatFlow', option: 'chatflow', records: () => flow('CHATFLOW') },
        { name: 'ChatMessage', option: 'chat_message', records: () => messages(ChatMessage) },
        { name: 'ChatMessageFeedback', option: 'chat_feedback', records: () => messages(ChatMessageFeedback) },
        // Preserve the existing shared-template visibility and template transformations.
        {
            name: 'CustomTemplate',
            option: 'custom_template',
            records: () => marketplacesService.getAllCustomTemplates(workspaceId)
        },
        { name: 'DocumentStore', option: 'document_store', records: () => readExportRows(scoped(DocumentStore)) },
        {
            name: 'DocumentStoreFileChunk',
            option: 'document_store',
            records: () =>
                readExportRows(
                    query(DocumentStoreFileChunk)
                        .innerJoin(DocumentStore, 'parent', 'parent.id = record.storeId')
                        .where('parent.workspaceId = :workspaceId', { workspaceId })
                )
        },
        {
            name: 'Execution',
            option: 'execution',
            records: () => readExportRows(scoped(Execution).leftJoinAndSelect('record.agentflow', 'agentflow'))
        },
        { name: 'Tool', option: 'tool', records: () => readExportRows(scoped(Tool)) },
        {
            name: 'Variable',
            option: 'variable',
            records: () => {
                const variables = scoped(Variable)
                if (app.identityManager.getPlatformType() === Platform.CLOUD) {
                    variables.andWhere('record.type != :type', { type: 'runtime' })
                }
                return readExportRows(variables)
            }
        }
    ]
    return generateExportJson(
        definitions.map((section) => ({ ...section, records: input[section.option] === true ? section.records : async () => [] }))
    )
}
