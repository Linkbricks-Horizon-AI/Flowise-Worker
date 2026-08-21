import { IServerSideEventStreamer } from 'flowise-components'
import { createClient } from 'redis'
import logger from '../utils/logger'
import { createRedisClient } from '../utils/redis'

/**
 * Build the metadata payload from an apiResponse. Shared by RedisEventPublisher and its relay-scoped
 * wrapper so the two never drift. Returns null when there is nothing to emit. All fields are semantic
 * (chatId/sessionId/etc. as the client sees them) — never the transport relay id.
 */
function buildMetadataJson(apiResponse: any): Record<string, any> | null {
    const metadataJson: any = {}
    if (apiResponse.chatId) metadataJson['chatId'] = apiResponse.chatId
    if (apiResponse.chatMessageId) metadataJson['chatMessageId'] = apiResponse.chatMessageId
    if (apiResponse.question) metadataJson['question'] = apiResponse.question
    if (apiResponse.sessionId) metadataJson['sessionId'] = apiResponse.sessionId
    if (apiResponse.memoryType) metadataJson['memoryType'] = apiResponse.memoryType
    if (apiResponse.action) {
        metadataJson['action'] = typeof apiResponse.action === 'string' ? JSON.parse(apiResponse.action) : apiResponse.action
    }
    return Object.keys(metadataJson).length > 0 ? metadataJson : null
}

export class RedisEventPublisher implements IServerSideEventStreamer {
    private redisPublisher: ReturnType<typeof createClient>
    private connectPromise: Promise<void> | null = null

    constructor() {
        this.redisPublisher = createRedisClient()
        this.setupEventListeners()
    }

    /**
     * Return a streamer that publishes on a fixed relay channel instead of the caller-supplied
     * chatId, while keeping the payload (including its semantic `chatId`) intact and stamping a
     * `relayExecutionId` field for the subscriber to route by. Used per prediction job so concurrent
     * executions of the same conversation get isolated transport channels/SSE slots (the chatId they
     * carry — for $flow.chatId, file paths, message persistence, client-facing metadata — is
     * untouched). Absent relay id → callers keep using this instance directly (legacy chatId channel).
     */
    withChannel(relayExecutionId: string): IServerSideEventStreamer {
        return new RelayScopedPublisher(this, relayExecutionId)
    }

    /** Internal: publish a pre-built envelope on the relay channel (used by RelayScopedPublisher). */
    publishOnRelayChannel(relayExecutionId: string, envelope: Record<string, any>) {
        this.safePublish(relayExecutionId, JSON.stringify({ ...envelope, relayExecutionId }))
    }

    private setupEventListeners() {
        this.redisPublisher.on('connect', () => {
            logger.info(`[RedisEventPublisher] Redis client connecting...`)
        })

        this.redisPublisher.on('ready', () => {
            logger.info(`[RedisEventPublisher] Redis client ready and connected`)
        })

        this.redisPublisher.on('error', (err) => {
            logger.error(`[RedisEventPublisher] Redis client error:`, {
                error: err,
                isReady: this.redisPublisher.isReady,
                isOpen: this.redisPublisher.isOpen
            })
        })

        this.redisPublisher.on('end', () => {
            logger.warn(`[RedisEventPublisher] Redis client connection ended`)
        })

        this.redisPublisher.on('reconnecting', () => {
            logger.info(`[RedisEventPublisher] Redis client reconnecting...`)
        })
    }

    isConnected() {
        return this.redisPublisher.isReady
    }

    async connect(): Promise<void> {
        if (this.connectPromise === null) {
            this.connectPromise = this.redisPublisher.connect().then(() => undefined)
        }
        await this.connectPromise
    }

    private async safePublish(channel: string, message: string) {
        if (!this.redisPublisher.isReady) {
            logger.warn(`[RedisEventPublisher] Cannot publish to channel ${channel}: Redis client not ready`)
            return
        }
        try {
            await this.redisPublisher.publish(channel, message)
        } catch (error) {
            logger.error(`[RedisEventPublisher] Error publishing to channel ${channel}:`, { error })
        }
    }

    streamCustomEvent(chatId: string, eventType: string, data: any) {
        this.safePublish(chatId, JSON.stringify({ chatId, eventType, data }))
    }

    streamStartEvent(chatId: string, data: string) {
        this.safePublish(chatId, JSON.stringify({ chatId, eventType: 'start', data }))
    }

    streamTokenEvent(chatId: string, data: string) {
        this.safePublish(chatId, JSON.stringify({ chatId, eventType: 'token', data }))
    }

    streamThinkingEvent(chatId: string, data: string, duration?: number) {
        this.safePublish(
            chatId,
            JSON.stringify({
                chatId,
                eventType: 'thinking',
                data,
                duration
            })
        )
    }

    streamSourceDocumentsEvent(chatId: string, data: any) {
        this.safePublish(chatId, JSON.stringify({ chatId, eventType: 'sourceDocuments', data }))
    }

    streamArtifactsEvent(chatId: string, data: any) {
        this.safePublish(chatId, JSON.stringify({ chatId, eventType: 'artifacts', data }))
    }

    streamUsedToolsEvent(chatId: string, data: any) {
        this.safePublish(chatId, JSON.stringify({ chatId, eventType: 'usedTools', data }))
    }

    streamCalledToolsEvent(chatId: string, data: any) {
        this.safePublish(chatId, JSON.stringify({ chatId, eventType: 'calledTools', data }))
    }

    streamFileAnnotationsEvent(chatId: string, data: any) {
        this.safePublish(chatId, JSON.stringify({ chatId, eventType: 'fileAnnotations', data }))
    }

    streamToolEvent(chatId: string, data: any): void {
        this.safePublish(chatId, JSON.stringify({ chatId, eventType: 'tool', data }))
    }

    streamAgentReasoningEvent(chatId: string, data: any): void {
        this.safePublish(chatId, JSON.stringify({ chatId, eventType: 'agentReasoning', data }))
    }

    streamAgentFlowEvent(chatId: string, data: any): void {
        this.safePublish(chatId, JSON.stringify({ chatId, eventType: 'agentFlowEvent', data }))
    }

    streamAgentFlowExecutedDataEvent(chatId: string, data: any): void {
        this.safePublish(chatId, JSON.stringify({ chatId, eventType: 'agentFlowExecutedData', data }))
    }

    streamNextAgentEvent(chatId: string, data: any): void {
        this.safePublish(chatId, JSON.stringify({ chatId, eventType: 'nextAgent', data }))
    }

    streamNextAgentFlowEvent(chatId: string, data: any): void {
        this.safePublish(chatId, JSON.stringify({ chatId, eventType: 'nextAgentFlow', data }))
    }

    streamActionEvent(chatId: string, data: any): void {
        this.safePublish(chatId, JSON.stringify({ chatId, eventType: 'action', data }))
    }

    streamAbortEvent(chatId: string): void {
        this.safePublish(chatId, JSON.stringify({ chatId, eventType: 'abort', data: '[DONE]' }))
    }

    streamEndEvent(_: string) {
        // placeholder for future use
    }

    streamErrorEvent(chatId: string, msg: string) {
        this.safePublish(chatId, JSON.stringify({ chatId, eventType: 'error', data: msg }))
    }

    streamMetadataEvent(chatId: string, apiResponse: any) {
        try {
            const metadataJson = buildMetadataJson(apiResponse)
            if (metadataJson) {
                this.streamCustomEvent(chatId, 'metadata', metadataJson)
            }
        } catch (error) {
            logger.error('[RedisEventPublisher] Error streaming metadata event:', { error })
        }
    }

    streamUsageMetadataEvent(chatId: string, data: any): void {
        this.safePublish(chatId, JSON.stringify({ chatId, eventType: 'usageMetadata', data }))
    }

    streamTTSStartEvent(chatId: string, chatMessageId: string, format: string): void {
        this.safePublish(chatId, JSON.stringify({ chatId, chatMessageId, eventType: 'tts_start', data: { format } }))
    }

    streamTTSDataEvent(chatId: string, chatMessageId: string, audioChunk: string): void {
        this.safePublish(chatId, JSON.stringify({ chatId, chatMessageId, eventType: 'tts_data', data: audioChunk }))
    }

    streamTTSEndEvent(chatId: string, chatMessageId: string): void {
        this.safePublish(chatId, JSON.stringify({ chatId, chatMessageId, eventType: 'tts_end', data: {} }))
    }

    streamTTSAbortEvent(chatId: string, chatMessageId: string): void {
        this.safePublish(chatId, JSON.stringify({ chatId, chatMessageId, eventType: 'tts_abort', data: {} }))
    }

    async disconnect() {
        if (this.redisPublisher) {
            await this.redisPublisher.quit()
        }
    }
}

/**
 * Wraps a RedisEventPublisher to publish every event on a fixed relay channel while preserving the
 * exact payload shape (envelope) the subscriber already parses. Only the transport channel and the
 * added top-level `relayExecutionId` routing field differ from the base publisher — the semantic
 * `chatId` inside each envelope is never rewritten. Implements the full IServerSideEventStreamer so a
 * missing method can't silently publish to the unrouted chatId channel.
 */
class RelayScopedPublisher implements IServerSideEventStreamer {
    constructor(private readonly inner: RedisEventPublisher, private readonly relayExecutionId: string) {}

    private publish(envelope: Record<string, any>) {
        this.inner.publishOnRelayChannel(this.relayExecutionId, envelope)
    }

    streamCustomEvent(chatId: string, eventType: string, data: any) {
        this.publish({ chatId, eventType, data })
    }
    streamStartEvent(chatId: string, data: string) {
        this.publish({ chatId, eventType: 'start', data })
    }
    streamTokenEvent(chatId: string, data: string) {
        this.publish({ chatId, eventType: 'token', data })
    }
    streamThinkingEvent(chatId: string, data: string, duration?: number) {
        this.publish({ chatId, eventType: 'thinking', data, duration })
    }
    streamSourceDocumentsEvent(chatId: string, data: any) {
        this.publish({ chatId, eventType: 'sourceDocuments', data })
    }
    streamArtifactsEvent(chatId: string, data: any) {
        this.publish({ chatId, eventType: 'artifacts', data })
    }
    streamUsedToolsEvent(chatId: string, data: any) {
        this.publish({ chatId, eventType: 'usedTools', data })
    }
    streamCalledToolsEvent(chatId: string, data: any) {
        this.publish({ chatId, eventType: 'calledTools', data })
    }
    streamFileAnnotationsEvent(chatId: string, data: any) {
        this.publish({ chatId, eventType: 'fileAnnotations', data })
    }
    streamToolEvent(chatId: string, data: any): void {
        this.publish({ chatId, eventType: 'tool', data })
    }
    streamAgentReasoningEvent(chatId: string, data: any): void {
        this.publish({ chatId, eventType: 'agentReasoning', data })
    }
    streamAgentFlowEvent(chatId: string, data: any): void {
        this.publish({ chatId, eventType: 'agentFlowEvent', data })
    }
    streamAgentFlowExecutedDataEvent(chatId: string, data: any): void {
        this.publish({ chatId, eventType: 'agentFlowExecutedData', data })
    }
    streamNextAgentEvent(chatId: string, data: any): void {
        this.publish({ chatId, eventType: 'nextAgent', data })
    }
    streamNextAgentFlowEvent(chatId: string, data: any): void {
        this.publish({ chatId, eventType: 'nextAgentFlow', data })
    }
    streamActionEvent(chatId: string, data: any): void {
        this.publish({ chatId, eventType: 'action', data })
    }
    streamAbortEvent(chatId: string): void {
        this.publish({ chatId, eventType: 'abort', data: '[DONE]' })
    }
    streamEndEvent(_: string) {
        // placeholder for future use — parity with base publisher
    }
    streamErrorEvent(chatId: string, msg: string) {
        this.publish({ chatId, eventType: 'error', data: msg })
    }
    streamMetadataEvent(chatId: string, apiResponse: any) {
        try {
            const metadataJson = buildMetadataJson(apiResponse)
            if (metadataJson) {
                this.streamCustomEvent(chatId, 'metadata', metadataJson)
            }
        } catch (error) {
            logger.error('[RelayScopedPublisher] Error streaming metadata event:', { error })
        }
    }
    streamUsageMetadataEvent(chatId: string, data: any): void {
        this.publish({ chatId, eventType: 'usageMetadata', data })
    }
    streamTTSStartEvent(chatId: string, chatMessageId: string, format: string): void {
        this.publish({ chatId, chatMessageId, eventType: 'tts_start', data: { format } })
    }
    streamTTSDataEvent(chatId: string, chatMessageId: string, audioChunk: string): void {
        this.publish({ chatId, chatMessageId, eventType: 'tts_data', data: audioChunk })
    }
    streamTTSEndEvent(chatId: string, chatMessageId: string): void {
        this.publish({ chatId, chatMessageId, eventType: 'tts_end', data: {} })
    }
    streamTTSAbortEvent(chatId: string, chatMessageId: string): void {
        this.publish({ chatId, chatMessageId, eventType: 'tts_abort', data: {} })
    }
}
