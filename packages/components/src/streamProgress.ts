import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import { Serialized } from '@langchain/core/load/serializable'
import { v4 as uuidv4 } from 'uuid'
import type { IServerSideEventStreamer } from './Interface'

type Activity = 'search' | 'document' | 'image' | 'video' | 'tool'

function activityFor(tool: Serialized): Activity {
    const name = String(tool.name ?? '').toLowerCase()
    if (/search|retriev|crawl|folder/.test(name)) return 'search'
    if (/video/.test(name)) return 'video'
    if (/image|paint/.test(name)) return 'image'
    if (/document|pdf|file.*read|summary/.test(name)) return 'document'
    return 'tool'
}

/** Opt-in, display-only telemetry. Never reads prompts, tool arguments/results or reasoning. */
export class StreamProgressHandler extends BaseCallbackHandler {
    name = 'stream_progress_handler'
    private readonly runId = uuidv4()
    private readonly startedAt = Date.now()
    private sequence = 0
    private lastState = ''
    private usedTool = false
    private readonly active = new Map<string, Activity>()

    constructor(private readonly streamer: IServerSideEventStreamer, private readonly chatId: string) {
        super()
    }

    private emit(phase: 'analyzing' | 'collecting' | 'composing' | 'working', activity?: Activity) {
        const state = `${phase}:${activity ?? ''}`
        if (state === this.lastState) return
        this.lastState = state
        // Progress is best-effort: instrumentation must never interrupt generation.
        try {
            this.streamer.streamCustomEvent(this.chatId, 'progress', {
                version: 1,
                runId: this.runId,
                sequence: ++this.sequence,
                startedAt: this.startedAt,
                at: Date.now(),
                phase,
                ...(activity ? { activity } : {})
            })
        } catch {
            // The existing token/error/termination paths remain authoritative.
        }
    }

    private emitActive() {
        const activity = this.active.values().next().value as Activity | undefined
        if (activity) this.emit(activity === 'search' || activity === 'document' ? 'collecting' : 'working', activity)
    }

    handleLLMStart() {
        if (this.active.size) this.emitActive()
        else this.emit(this.usedTool ? 'composing' : 'analyzing')
    }

    handleChatModelStart() {
        this.handleLLMStart()
    }

    handleToolStart(tool: Serialized, _input: string, runId: string) {
        this.usedTool = true
        this.active.set(runId, activityFor(tool))
        this.emitActive()
    }

    handleToolEnd(_output: unknown, runId: string) {
        if (this.active.delete(runId)) this.emitActive()
        // Do not announce composition until a model actually resumes. Direct tool returns
        // may produce the answer immediately, and another tool may start next.
    }

    handleRetrieverStart(_retriever: Serialized, _query: string, runId: string) {
        this.usedTool = true
        this.active.set(runId, 'document')
        this.emitActive()
    }

    handleRetrieverEnd(_documents: unknown, runId: string) {
        this.handleToolEnd(undefined, runId)
    }

    handleRetrieverError(_error: unknown, runId: string) {
        this.handleToolEnd(undefined, runId)
    }

    handleToolError(_error: unknown, runId: string) {
        this.handleToolEnd(undefined, runId)
    }
}
