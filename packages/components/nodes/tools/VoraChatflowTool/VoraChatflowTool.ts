import { cloneDeep } from 'lodash'
import type { RequestInit } from 'node-fetch'
import { DataSource } from 'typeorm'
import { z } from 'zod/v3'
import { RunnableConfig } from '@langchain/core/runnables'
import { CallbackManagerForToolRun, Callbacks, CallbackManager, parseCallbackConfigArg } from '@langchain/core/callbacks/manager'
import { StructuredTool } from '@langchain/core/tools'
import { ICommonObject, IDatabaseEntity, INode, INodeData, INodeOptionsValue, INodeParams, IToolFlowConfig } from '../../../src/Interface'
import { getCredentialData, getCredentialParam, parseWithTypeConversion } from '../../../src/utils'
import { secureFetch } from '../../../src/httpSecurity'
import { markTransparentTool } from '../../../src/transparentTool'
import { childOverrideConfig, ParentToolVariables, readChildPrediction } from './childPrediction'
import { isValidUUID, isValidURL } from '../../../src/validator'
import { v4 as uuidv4 } from 'uuid'

class VoraChatflowTool_Tools implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]
    credential: INodeParams
    inputs: INodeParams[]
    skipCredentialIconRegistration = true

    constructor() {
        this.label = 'Vora Chatflow Tool'
        this.name = 'VoraChatflowTool'
        this.version = 1.1
        this.type = 'VoraChatflowTool'
        this.icon = 'voraRouter.png'
        this.category = 'Tools'
        this.description =
            'Execute a child chatflow with the parent user and tool quota. Allow user_id and tool_usage overrides in both chatflows.'
        this.baseClasses = [this.type, 'Tool']
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['chatflowApi'],
            optional: true
        }
        this.inputs = [
            {
                label: 'Select Chatflow',
                name: 'selectedChatflow',
                type: 'asyncOptions',
                loadMethod: 'listChatflows'
            },
            {
                label: 'Tool Name',
                name: 'name',
                type: 'string'
            },
            {
                label: 'Tool Description',
                name: 'description',
                type: 'string',
                description: 'Description of what the tool does. This is for LLM to determine when to use this tool.',
                rows: 3,
                placeholder:
                    'State of the Union QA - useful for when you need to ask questions about the most recent state of the union address.'
            },
            {
                label: 'Return Direct',
                name: 'returnDirect',
                type: 'boolean',
                optional: true
            },
            {
                label: 'Tool Enabled',
                name: 'toolEnabled',
                type: 'boolean',
                default: true,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Require User ID',
                name: 'requireUserId',
                type: 'boolean',
                description:
                    'Require vars.user_id from the parent request. Turn off for canvas tests without a user ID. A provided parent user_id is always forwarded.',
                default: true,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Override Config',
                name: 'overrideConfig',
                description:
                    'Child-specific overrides. Leave empty to inherit the current parent user_id, tool_usage and session. Parent user_id and tool_usage take precedence.',
                type: 'json',
                optional: true,
                additionalParams: true,
                acceptVariable: true
            },
            {
                label: 'Base URL',
                name: 'baseURL',
                type: 'string',
                description:
                    'Base URL to Flowise. By default, it is the URL of the incoming request. Useful when you need to execute the Chatflow through an alternative route.',
                placeholder: 'http://localhost:3000',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Start new session per message',
                name: 'startNewSession',
                type: 'boolean',
                description:
                    'Whether to continue the session with the Chatflow tool or start a new one with each interaction. Useful for Chatflows with memory if you want to avoid it.',
                default: false,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Use Question from Chat',
                name: 'useQuestionFromChat',
                type: 'boolean',
                description:
                    'Whether to use the question from the chat as input to the chatflow. If turned on, this will override the custom input.',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Custom Input',
                name: 'customInput',
                type: 'string',
                description: 'Custom input to be passed to the chatflow. Leave empty to let LLM decides the input.',
                optional: true,
                additionalParams: true,
                show: {
                    useQuestionFromChat: false
                }
            }
        ]
    }

    //@ts-ignore
    loadMethods = {
        async listChatflows(_: INodeData, options: ICommonObject): Promise<INodeOptionsValue[]> {
            const returnData: INodeOptionsValue[] = []

            const appDataSource = options.appDataSource as DataSource
            const databaseEntities = options.databaseEntities as IDatabaseEntity
            if (appDataSource === undefined || !appDataSource) {
                return returnData
            }

            const searchOptions = options.searchOptions || {}
            const chatflows = await appDataSource.getRepository(databaseEntities['ChatFlow']).findBy(searchOptions)

            for (let i = 0; i < chatflows.length; i += 1) {
                let type = chatflows[i].type
                if (type === 'AGENTFLOW') {
                    type = 'AgentflowV2'
                } else if (type === 'MULTIAGENT') {
                    type = 'AgentflowV1'
                } else if (type === 'ASSISTANT') {
                    type = 'Custom Assistant'
                } else {
                    type = 'Chatflow'
                }
                const data = {
                    label: chatflows[i].name,
                    name: chatflows[i].id,
                    description: type
                } as INodeOptionsValue
                returnData.push(data)
            }
            return returnData
        }
    }

    async init(nodeData: INodeData, input: string, options: ICommonObject): Promise<any> {
        const toolEnabled = nodeData.inputs?.toolEnabled
        if (toolEnabled === false || toolEnabled === 'false') return null

        const selectedChatflowId = nodeData.inputs?.selectedChatflow as string
        const _name = nodeData.inputs?.name as string
        const description = nodeData.inputs?.description as string
        const useQuestionFromChat = nodeData.inputs?.useQuestionFromChat === true || nodeData.inputs?.useQuestionFromChat === 'true'
        const returnDirect = nodeData.inputs?.returnDirect === true || nodeData.inputs?.returnDirect === 'true'
        // Saved v1.0 nodes have no value: preserve their required-identity behavior.
        const requireUserId = nodeData.inputs?.requireUserId !== false && nodeData.inputs?.requireUserId !== 'false'
        const customInput = nodeData.inputs?.customInput as string
        // Capture request-applied values, never workspace defaults or LLM arguments.
        const appliedParentVariables = Object.freeze({
            user_id: nodeData.inputs?.vars?.user_id,
            tool_usage: nodeData.inputs?.vars?.tool_usage
        })
        const overrideConfig = cloneDeep(nodeData.inputs?.overrideConfig)

        const startNewSession = nodeData.inputs?.startNewSession === true || nodeData.inputs?.startNewSession === 'true'

        const baseURL = (nodeData.inputs?.baseURL as string) || (options.baseURL as string)

        // Validate selectedChatflowId is a valid UUID
        if (!selectedChatflowId || !isValidUUID(selectedChatflowId)) {
            throw new Error('Invalid chatflow ID: must be a valid UUID')
        }

        // Validate baseURL is a valid URL
        if (!baseURL || !isValidURL(baseURL)) {
            throw new Error('Invalid base URL: must be a valid URL')
        }

        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const chatflowApiKey = getCredentialParam('chatflowApiKey', credentialData, nodeData)

        if (selectedChatflowId === options.chatflowid) throw new Error('Cannot call the same chatflow!')

        let headers = {}
        if (chatflowApiKey) headers = { Authorization: `Bearer ${chatflowApiKey}` }

        let toolInput = ''
        if (useQuestionFromChat) {
            toolInput = input
        } else if (customInput) {
            toolInput = customInput
        }

        const name = _name || 'vora_chatflow_tool'

        return new VoraChatflowTool({
            name,
            baseURL,
            description,
            returnDirect,
            chatflowid: selectedChatflowId,
            startNewSession,
            headers,
            input: toolInput,
            overrideConfig,
            appliedParentVariables,
            requireUserId
        })
    }
}

class VoraChatflowTool extends StructuredTool {
    static lc_name() {
        return 'VoraChatflowTool'
    }

    name: string
    description: string
    private readonly settings: {
        input: string
        chatflowid: string
        startNewSession: boolean
        baseURL: string
        headers: ICommonObject
        overrideConfig?: unknown
        appliedParentVariables: ParentToolVariables
        requireUserId: boolean
    }

    schema = z.object({ input: z.string().describe('input question') }) as any

    constructor(fields: {
        name: string
        description: string
        returnDirect: boolean
        input: string
        chatflowid: string
        startNewSession: boolean
        baseURL: string
        headers: ICommonObject
        overrideConfig?: unknown
        appliedParentVariables: ParentToolVariables
        requireUserId: boolean
    }) {
        super()
        this.name = fields.name
        this.description = fields.description
        this.returnDirect = fields.returnDirect
        this.settings = fields
        markTransparentTool(this)
    }

    async call(
        arg: z.infer<typeof this.schema>,
        configArg?: RunnableConfig | Callbacks,
        tags?: string[],
        flowConfig?: IToolFlowConfig
    ): Promise<string> {
        const config = parseCallbackConfigArg(configArg) as RunnableConfig
        if (config.runName === undefined) config.runName = this.name
        let parsed
        try {
            parsed = await parseWithTypeConversion(this.schema, arg)
        } catch {
            throw new Error('Vora Chatflow Tool requires an input question string.')
        }
        const callbackManager = await CallbackManager.configure(
            config.callbacks,
            this.callbacks,
            config.tags || tags,
            this.tags,
            config.metadata,
            this.metadata,
            { verbose: this.verbose }
        )
        const runManager = await callbackManager?.handleToolStart(
            this.toJSON(),
            JSON.stringify(parsed),
            undefined,
            undefined,
            undefined,
            undefined,
            config.runName
        )
        try {
            const result = await this._call(parsed, runManager, flowConfig, config.signal)
            await runManager?.handleToolEnd(result)
            return result
        } catch (error) {
            await runManager?.handleToolError(error)
            throw error
        }
    }

    protected async _call(
        arg: { input: string },
        _?: CallbackManagerForToolRun,
        flowConfig: IToolFlowConfig = {},
        signal?: AbortSignal
    ): Promise<string> {
        const settings = this.settings
        const overrideConfig = childOverrideConfig(
            settings.overrideConfig,
            settings.appliedParentVariables,
            settings.startNewSession ? uuidv4() : flowConfig.sessionId,
            settings.requireUserId
        )
        const streaming = Boolean(this.returnDirect && flowConfig.sseStreamer && flowConfig.chatId)
        const requestSignal = signal ?? flowConfig.signal
        if (requestSignal?.aborted) throw new Error('Vora Chatflow Tool call was aborted.')
        const response = await secureFetch(`${settings.baseURL.replace(/\/+$/, '')}/api/v1/prediction/${settings.chatflowid}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'flowise-tool': 'true',
                ...(streaming ? { 'flowise-tool-stream': 'true' } : {}),
                ...settings.headers
            },
            signal: requestSignal as RequestInit['signal'],
            body: JSON.stringify({
                question: settings.input || arg.input,
                chatId: uuidv4(),
                streaming,
                overrideConfig
            })
        })
        let started = false
        return readChildPrediction(response, {
            onUsedTools: (tools) => {
                flowConfig.usedTools = tools
            },
            onToken: streaming
                ? (token) => {
                      if (!started) {
                          flowConfig.sseStreamer!.streamStartEvent(flowConfig.chatId!, '')
                          started = true
                      }
                      flowConfig.streamed = true
                      flowConfig.sseStreamer!.streamTokenEvent(flowConfig.chatId!, token)
                  }
                : undefined
        })
    }
}

module.exports = { nodeClass: VoraChatflowTool_Tools }
