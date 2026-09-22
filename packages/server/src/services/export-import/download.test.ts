import { ObjectLiteral, SelectQueryBuilder } from 'typeorm'
import { Platform } from '../../Interface'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { ChatMessageFeedback } from '../../database/entities/ChatMessageFeedback'
import { DocumentStore } from '../../database/entities/DocumentStore'
import { DocumentStoreFileChunk } from '../../database/entities/DocumentStoreFileChunk'
import { Execution } from '../../database/entities/Execution'
import { Variable } from '../../database/entities/Variable'
import type { ExportInput } from './index'

const mockQueries = new Map()
const mockGetRepository = jest.fn((entity) => ({ createQueryBuilder: () => mockQueries.get(entity) }))
const mockPlatform = jest.fn()
jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: { getRepository: mockGetRepository },
        identityManager: { getPlatformType: mockPlatform }
    })
}))
jest.mock('../marketplaces', () => ({ __esModule: true, default: { getAllCustomTemplates: jest.fn().mockResolvedValue([]) } }))

import marketplacesService from '../marketplaces'
import { createExportDownload, generateExportJson, readExportRows } from './download'

const collect = async (chunks: AsyncIterable<string>) => {
    let result = ''
    for await (const chunk of chunks) result += chunk
    return JSON.parse(result)
}

const makeQuery = (rows: ObjectLiteral[] = []) => {
    const query: any = {}
    for (const method of ['clone', 'where', 'andWhere', 'innerJoin', 'leftJoinAndSelect', 'orderBy', 'take'])
        query[method] = jest.fn(() => query)
    query.getMany = jest.fn().mockResolvedValue(rows)
    return query
}

describe('workspace export download', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockQueries.clear()
        mockPlatform.mockReturnValue(Platform.OPEN_SOURCE)
    })

    it('writes valid JSON one record at a time, including empty sections and Unicode', async () => {
        const records = [
            { id: '1', content: '한국어 😀 "quoted"\nnext' },
            { id: '2', content: '\\' }
        ]
        const result = await collect(
            generateExportJson([
                { name: 'ChatMessage', records: async () => records },
                { name: 'ChatFlow', records: async () => [] }
            ])
        )
        expect(result).toEqual({ ChatMessage: records, ChatFlow: [] })
    })

    it('does not request more rows after a consumer stops reading', async () => {
        const query = makeQuery(Array.from({ length: 100 }, (_, index) => ({ id: `${index}` })))
        const chunks = generateExportJson([{ name: 'ChatMessage', records: () => readExportRows(query) }])
        for await (const chunk of chunks) {
            if (chunk.includes('"id"')) break
        }
        expect(query.getMany).toHaveBeenCalledTimes(1)
    })

    it('exports all pages, including execution records beyond the old 12-row default', async () => {
        const first = Array.from({ length: 100 }, (_, index) => ({ id: String(index).padStart(3, '0') }))
        const query = makeQuery()
        query.getMany.mockResolvedValueOnce(first).mockResolvedValueOnce([{ id: '100' }, { id: '101' }])
        mockQueries.set(Execution, query)
        const result = await collect(createExportDownload({ execution: true } as ExportInput, 'workspace-1'))
        expect(result.Execution).toHaveLength(102)
        expect(new Set(result.Execution.map((row: any) => row.id)).size).toBe(102)
        expect(query.andWhere).toHaveBeenCalledWith('record.id > :exportCursor', { exportCursor: '099' })
        expect(query.where).toHaveBeenCalledWith('record.workspaceId = :workspaceId', { workspaceId: 'workspace-1' })
        expect(query.leftJoinAndSelect).toHaveBeenCalledWith('record.agentflow', 'agentflow')
        expect(query.take).toHaveBeenCalledWith(100)
    })

    it.each([
        ['chat_message', ChatMessage, ChatFlow, 'parent.id = record.chatflowid'],
        ['chat_feedback', ChatMessageFeedback, ChatFlow, 'parent.id = record.chatflowid'],
        ['document_store', DocumentStoreFileChunk, DocumentStore, 'parent.id = record.storeId']
    ])('scopes %s child rows to the active workspace, even when flows are not selected', async (option, entity, parent, join) => {
        const query = makeQuery()
        mockQueries.set(entity, query)
        mockQueries.set(DocumentStore, makeQuery())
        await collect(createExportDownload({ [option as string]: true } as ExportInput, 'workspace-1'))
        expect(query.innerJoin).toHaveBeenCalledWith(parent, 'parent', join)
        expect(query.where).toHaveBeenCalledWith('parent.workspaceId = :workspaceId', { workspaceId: 'workspace-1' })
    })

    it('does not query unselected categories and still emits every import key', async () => {
        const result = await collect(createExportDownload({} as ExportInput, 'workspace-1'))
        expect(Object.keys(result)).toHaveLength(15)
        expect(Object.values(result).every((value) => Array.isArray(value) && value.length === 0)).toBe(true)
        expect(mockGetRepository).not.toHaveBeenCalled()
        expect(marketplacesService.getAllCustomTemplates).not.toHaveBeenCalled()
    })

    it('keeps cloud runtime-variable filtering and blanks static variable values', async () => {
        mockPlatform.mockReturnValue(Platform.CLOUD)
        const query = makeQuery([{ id: 'v', name: 'key', type: 'static', value: 'secret' }])
        mockQueries.set(Variable, query)
        const result = await collect(createExportDownload({ variable: true } as ExportInput, 'workspace-1'))
        expect(query.andWhere).toHaveBeenCalledWith('record.type != :type', { type: 'runtime' })
        expect(result.Variable[0].value).toBe('')
    })

    it('preserves shared templates through the existing service', async () => {
        await collect(createExportDownload({ custom_template: true } as ExportInput, 'workspace-1'))
        expect(marketplacesService.getAllCustomTemplates).toHaveBeenCalledWith('workspace-1')
    })

    it('requires a workspace and propagates database failures', async () => {
        expect(() => createExportDownload({} as ExportInput, '')).toThrow('Workspace ID is required')
        const query = makeQuery()
        query.getMany.mockRejectedValue(new Error('database unavailable'))
        const stream = readExportRows(query as SelectQueryBuilder<ObjectLiteral>)
        await expect(stream.next()).rejects.toThrow('database unavailable')
    })
})
