import { DataSource } from 'typeorm'
import { z } from 'zod/v3'
import { RunnableConfig } from '@langchain/core/runnables'
import { CallbackManagerForToolRun, Callbacks, CallbackManager, parseCallbackConfigArg } from '@langchain/core/callbacks/manager'
import { StructuredTool } from '@langchain/core/tools'
import {
    ICommonObject,
    IDatabaseEntity,
    INode,
    INodeData,
    INodeOptionsValue,
    INodeParams,
    IServerSideEventStreamer
} from '../../../src/Interface'
import {
    getCredentialData,
    getCredentialParam,
    executeJavaScriptCode,
    createCodeExecutionSandbox,
    parseWithTypeConversion
} from '../../../src/utils'
import { secureFetch } from '../../../src/httpSecurity'
import { isValidUUID, isValidURL } from '../../../src/validator'
import { v4 as uuidv4 } from 'uuid'

class ChatflowTool_Tools implements INode {
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

    constructor() {
        this.label = 'Chatflow Tool'
        this.name = 'ChatflowTool'
        this.version = 5.1
        this.type = 'ChatflowTool'
        this.icon = 'chatflowTool.svg'
        this.category = 'Tools'
        this.description = 'Use as a tool to execute another chatflow'
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
                label: 'Override Config',
                name: 'overrideConfig',
                description: 'Override the config passed to the Chatflow.',
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
        const selectedChatflowId = nodeData.inputs?.selectedChatflow as string
        const _name = nodeData.inputs?.name as string
        const description = nodeData.inputs?.description as string
        const useQuestionFromChat = nodeData.inputs?.useQuestionFromChat as boolean
        const returnDirect = nodeData.inputs?.returnDirect as boolean
        const customInput = nodeData.inputs?.customInput as string
        const overrideConfig =
            typeof nodeData.inputs?.overrideConfig === 'string' &&
            nodeData.inputs.overrideConfig.startsWith('{') &&
            nodeData.inputs.overrideConfig.endsWith('}')
                ? JSON.parse(nodeData.inputs.overrideConfig)
                : nodeData.inputs?.overrideConfig

        const startNewSession = nodeData.inputs?.startNewSession as boolean

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

        let name = _name || 'chatflow_tool'

        return new ChatflowTool({
            name,
            baseURL,
            description,
            returnDirect,
            chatflowid: selectedChatflowId,
            startNewSession,
            headers,
            input: toolInput,
            overrideConfig
        })
    }
}

class ChatflowTool extends StructuredTool {
    static lc_name() {
        return 'ChatflowTool'
    }

    name = 'chatflow_tool'

    description = 'Execute another chatflow'

    input = ''

    chatflowid = ''

    startNewSession = false

    baseURL = 'http://localhost:3000'

    headers = {}

    overrideConfig?: object

    schema = z.object({
        input: z.string().describe('input question')
        // overrideConfig: z.record(z.any()).optional().describe('override config'), // This will be passed to the Agent, so comment it for now.
    }) as any

    constructor({
        name,
        description,
        returnDirect,
        input,
        chatflowid,
        startNewSession,
        baseURL,
        headers,
        overrideConfig
    }: {
        name: string
        description: string
        returnDirect: boolean
        input: string
        chatflowid: string
        startNewSession: boolean
        baseURL: string
        headers: ICommonObject
        overrideConfig?: object
    }) {
        super()
        this.name = name
        this.description = description
        this.input = input
        this.baseURL = baseURL
        this.startNewSession = startNewSession
        this.headers = headers
        this.chatflowid = chatflowid
        this.overrideConfig = overrideConfig
        this.returnDirect = returnDirect
    }

    async call(
        arg: z.infer<typeof this.schema>,
        configArg?: RunnableConfig | Callbacks,
        tags?: string[],
        flowConfig?: { sessionId?: string; chatId?: string; input?: string }
    ): Promise<string> {
        const config = parseCallbackConfigArg(configArg)
        if (config.runName === undefined) {
            config.runName = this.name
        }
        let parsed
        try {
            parsed = await parseWithTypeConversion(this.schema, arg)
        } catch (e) {
            throw new Error(`Received tool input did not match expected schema: ${JSON.stringify(arg)}`)
        }
        const callbackManager_ = await CallbackManager.configure(
            config.callbacks,
            this.callbacks,
            config.tags || tags,
            this.tags,
            config.metadata,
            this.metadata,
            { verbose: this.verbose }
        )
        const runManager = await callbackManager_?.handleToolStart(
            this.toJSON(),
            typeof parsed === 'string' ? parsed : JSON.stringify(parsed),
            undefined,
            undefined,
            undefined,
            undefined,
            config.runName
        )
        let result
        try {
            result = await this._call(parsed, runManager, flowConfig)
        } catch (e) {
            await runManager?.handleToolError(e)
            throw e
        }
        if (result && typeof result !== 'string') {
            result = JSON.stringify(result)
        }
        await runManager?.handleToolEnd(result)
        return result
    }

    // @ts-ignore
    protected async _call(
        arg: z.infer<typeof this.schema>,
        _?: CallbackManagerForToolRun,
        flowConfig?: { sessionId?: string; chatId?: string; input?: string; sseStreamer?: IServerSideEventStreamer }
    ): Promise<string> {
        const inputQuestion = this.input || arg.input

        // True token streaming: only when this tool returns its output directly (returnDirect)
        // AND the parent flow is itself streaming (parent SSE streamer present). Forwards the
        // child chatflow's tokens to the parent stream in real time. Every other case falls
        // through to the blocking path below, so existing behavior is byte-identical.
        const parentSseStreamer = flowConfig?.sseStreamer
        const parentChatId = flowConfig?.chatId
        if (parentSseStreamer && parentChatId && flowConfig && this.returnDirect) {
            const streamedText = await this.streamChildPrediction(arg, flowConfig, parentSseStreamer, parentChatId)
            // null -> nothing streamed (child not stream-valid / zero tokens / pre-token error):
            // fall through to the blocking request. Non-null (full or partial) -> tokens were
            // forwarded live, return as-is (never re-run, which would duplicate the answer).
            if (streamedText !== null) return streamedText
        }

        const body = {
            question: inputQuestion,
            chatId: this.startNewSession ? uuidv4() : flowConfig?.chatId,
            overrideConfig: {
                sessionId: this.startNewSession ? uuidv4() : flowConfig?.sessionId,
                ...(this.overrideConfig ?? {}),
                ...(arg.overrideConfig ?? {})
            }
        }

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'flowise-tool': 'true',
                ...this.headers
            },
            body: JSON.stringify(body)
        }

        const code = `
const fetch = require('node-fetch');
const url = "${this.baseURL}/api/v1/prediction/${this.chatflowid}";

const body = $callBody;

const options = $callOptions;

try {
	const response = await fetch(url, options);
	const resp = await response.json();
	return resp.text;
} catch (error) {
	console.error(error);
	return '';
}
`

        // Create additional sandbox variables
        const additionalSandbox: ICommonObject = {
            $callOptions: options,
            $callBody: body
        }

        const sandbox = createCodeExecutionSandbox('', [], {}, additionalSandbox)

        let response = await executeJavaScriptCode(code, sandbox, {
            useSandbox: false
        })

        if (typeof response === 'object') {
            response = JSON.stringify(response)
        }

        return response
    }

    /**
     * Calls the child chatflow in streaming mode and forwards its answer tokens to the parent
     * flow's SSE stream in real time. Returns the accumulated answer text (full, or partial on a
     * mid-stream error), or null when nothing could be streamed (child not stream-valid, zero
     * tokens, or a pre-token error) so the caller can fall back to the blocking request.
     *
     * All per-call state is local or carried on the call-scoped `flowConfig` object (unique per
     * tool invocation), so concurrent invocations of the same tool instance never interfere.
     */
    private async streamChildPrediction(
        arg: any,
        flowConfig: {
            sessionId?: string
            chatId?: string
            input?: string
            sseStreamer?: IServerSideEventStreamer
            streamed?: boolean
            usedTools?: any[]
        },
        parentSseStreamer: IServerSideEventStreamer,
        parentChatId: string
    ): Promise<string | null> {
        const inputQuestion = this.input || arg.input

        // Use a DISTINCT transport chatId for the child SSE so it never overwrites the parent's
        // SSE client entry (the streamer's client map is keyed by chatId). Memory continuity is
        // preserved via overrideConfig.sessionId, which the child keys its memory off — not chatId.
        const body = {
            question: inputQuestion,
            chatId: uuidv4(),
            streaming: true,
            overrideConfig: {
                sessionId: this.startNewSession ? uuidv4() : flowConfig?.sessionId,
                ...(this.overrideConfig ?? {}),
                ...(arg.overrideConfig ?? {})
            }
        }

        const url = `${this.baseURL}/api/v1/prediction/${this.chatflowid}`
        const options: any = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'flowise-tool': 'true',
                // Opt-in flag that lets an AgentFlow child stream when invoked as a tool. Regular
                // chatflow children stream on `streaming: true` alone; this header is ignored by
                // older servers, so a rolling deploy degrades gracefully to the blocking fallback.
                'flowise-tool-stream': 'true',
                ...this.headers
            },
            body: JSON.stringify(body)
        }

        let accumulated = ''
        let tokenCount = 0
        // The child chatflow's own tool usage, captured from its SSE `usedTools` frame and surfaced to
        // the caller via flowConfig so the parent agent can merge it into its own usedTools.
        let childUsedTools: any[] = []

        try {
            // Reuse secureFetch (the same SSRF deny-list + pinned agent the blocking sandbox path
            // uses via node-fetch), but consume the response body as a stream instead of buffering.
            const response = await secureFetch(url, options)
            const contentType = (response.headers?.get?.('content-type') || '').toLowerCase()

            // Child is not stream-valid -> it answered with a single JSON payload. Return that text
            // and let the caller emit it once (existing behavior). The child still ran exactly once.
            if (!contentType.includes('text/event-stream')) {
                const json: any = await response.json().catch(() => null)
                // Surface a non-stream-valid child's own tool usage too (single JSON payload path).
                if (json && Array.isArray(json.usedTools) && json.usedTools.length) flowConfig.usedTools = json.usedTools
                if (json && typeof json.text === 'string') return json.text
                if (typeof json === 'string') return json
                return null
            }

            let started = false
            const ensureStart = () => {
                if (!started) {
                    started = true
                    // Idempotent on the parent (streamStartEvent guards on client.started).
                    parentSseStreamer.streamStartEvent(parentChatId, '')
                }
            }

            let buffer = ''
            let terminal = false

            const handleFrame = (rawFrame: string) => {
                // Flowise frames are `message:\ndata:{json}\n\n`. The real event type lives in the
                // JSON `event` field. Ignore the `message:` line, heartbeats (`:...`) and blanks.
                const dataLine = rawFrame.split('\n').find((l) => l.startsWith('data:'))
                if (!dataLine) return
                let parsed: any
                try {
                    parsed = JSON.parse(dataLine.replace(/^data:\s?/, ''))
                } catch (e) {
                    return
                }
                switch (parsed?.event) {
                    case 'start':
                        ensureStart()
                        break
                    case 'token':
                        if (typeof parsed.data === 'string' && parsed.data.length) {
                            ensureStart()
                            parentSseStreamer.streamTokenEvent(parentChatId, parsed.data)
                            accumulated += parsed.data
                            tokenCount += 1
                            // Mark on the call-scoped flowConfig so the agent skips the bulk re-emit.
                            flowConfig.streamed = true
                        }
                        break
                    case 'usedTools':
                        // The child agent's own usedTools (a flat IUsedTool[]). Accumulate across the
                        // child's iterations. The length guard ignores the empty `data:[]` frame an agent
                        // emits when its usedTools is an empty (but truthy) array. Do NOT emit to the parent
                        // streamer here — the parent ToolAgent.run emits the full merged array exactly once,
                        // and the client REPLACEs usedTools on each event (a partial emit would be clobbered).
                        // This frame always arrives before the terminal `end`, so the break-on-terminal loop
                        // below still captures it.
                        if (Array.isArray(parsed.data) && parsed.data.length) {
                            childUsedTools = childUsedTools.concat(parsed.data)
                            flowConfig.usedTools = childUsedTools
                        }
                        break
                    case 'end':
                    case 'error':
                    case 'abort':
                        terminal = true
                        break
                    default:
                        break
                }
            }

            for await (const chunk of response.body as any) {
                buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
                let idx
                while ((idx = buffer.indexOf('\n\n')) !== -1) {
                    const rawFrame = buffer.slice(0, idx)
                    buffer = buffer.slice(idx + 2)
                    handleFrame(rawFrame)
                    if (terminal) break
                }
                if (terminal) break
            }
            // Flush a trailing frame that arrived without the blank-line terminator.
            if (!terminal && buffer.trim().length) handleFrame(buffer)

            // No tokens produced (e.g. an AgentFlow child whose streamer was not opted-in during a
            // rolling deploy). Signal the caller to fall back to a blocking request so the answer is
            // not lost. In steady state (both web + worker deployed) this path is not reached.
            if (tokenCount === 0) return null

            return accumulated
        } catch (e) {
            // Network/parse failure. If tokens were already forwarded, return the partial text —
            // re-running via the blocking path would duplicate the answer and the child's memory
            // writes. If nothing was forwarded yet, fall back to the blocking request.
            if (tokenCount > 0) return accumulated
            return null
        }
    }
}

module.exports = { nodeClass: ChatflowTool_Tools }
