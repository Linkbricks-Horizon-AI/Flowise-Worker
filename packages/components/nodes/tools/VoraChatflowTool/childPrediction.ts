import { StringDecoder } from 'string_decoder'
import type { Readable } from 'stream'
import type { Response } from 'node-fetch'
import type { ICommonObject, IUsedTool } from '../../../src/Interface'

export type ParentToolVariables = Readonly<{ user_id?: unknown; tool_usage?: unknown }>

function isObject(value: unknown): value is ICommonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function childOverrideConfig(
    explicit: unknown,
    parent: ParentToolVariables,
    sessionId?: string,
    requireUserId = true
): ICommonObject {
    const hasUserId = typeof parent.user_id === 'string' && Boolean(parent.user_id.trim())
    if (requireUserId && !hasUserId) {
        throw new Error(
            'Vora Chatflow Tool requires the parent request user_id. Enable API Override and allow user_id in Variables, or turn off Require User ID for canvas tests.'
        )
    }
    if (parent.user_id != null && typeof parent.user_id !== 'string') {
        throw new Error('Vora Chatflow Tool requires user_id to be a string when provided.')
    }
    if (parent.tool_usage !== undefined && typeof parent.tool_usage !== 'string') {
        throw new Error('Vora Chatflow Tool requires tool_usage to be a JSON string when provided.')
    }

    let override: unknown = explicit ?? {}
    if (typeof override === 'string') {
        try {
            override = JSON.parse(override || '{}')
        } catch {
            throw new Error('Vora Chatflow Tool Override Config must be a JSON object.')
        }
    }
    if (!isObject(override) || (override.vars !== undefined && !isObject(override.vars))) {
        throw new Error('Vora Chatflow Tool Override Config and its vars must be JSON objects.')
    }

    // Copy only the current, permission-filtered request variables. Node IDs are workflow-local;
    // never copy the parent's toolEnabled map or infer tool identity from those IDs.
    return {
        sessionId,
        ...override,
        // An anonymous test must not inherit a saved/workspace user's identity.
        vars: { ...override.vars, user_id: hasUserId ? parent.user_id : '', tool_usage: parent.tool_usage ?? '' }
    }
}

type ChildResponseHandlers = {
    onToken?: (text: string) => void
    onUsedTools: (tools: IUsedTool[]) => void
}

/** Consume one prediction response. A missing token is never a reason to execute it again. */
export async function readChildPrediction(response: Response, handlers: ChildResponseHandlers): Promise<string> {
    const body = response.body as Readable | null
    if (!response.ok) {
        body?.destroy?.()
        throw new Error(`Vora Chatflow Tool child prediction failed (HTTP ${response.status}).`)
    }

    const captureTools = (value: unknown) => {
        if (!Array.isArray(value)) return
        if (value.some((tool) => !isObject(tool) || typeof tool.tool !== 'string')) {
            throw new Error('Vora Chatflow Tool received invalid child tool usage.')
        }
        // Flowise sends cumulative/final snapshots, not deltas. Preserve repeated real calls
        // within the snapshot, but do not append the same snapshot again.
        handlers.onUsedTools(value)
    }

    if (!(response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream')) {
        const result = await response.json()
        if (typeof result === 'string') return result
        if (isObject(result)) {
            captureTools(result.usedTools)
            if (!result.error && typeof result.text === 'string') return result.text
        }
        throw new Error('Vora Chatflow Tool received an invalid child prediction response.')
    }

    let text = ''
    let ended = false
    let buffer = ''
    const decoder = new StringDecoder('utf8')

    const frame = (raw: string) => {
        const data = raw
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n')
        if (!data) return // Heartbeats and comments.
        if (data === '[DONE]') {
            ended = true
            return
        }
        let event: any
        try {
            event = JSON.parse(data)
        } catch {
            throw new Error('Vora Chatflow Tool received an invalid child stream frame.')
        }
        switch (event?.event) {
            case 'token':
                if (typeof event.data !== 'string') {
                    throw new Error('Vora Chatflow Tool received an invalid child answer token.')
                }
                text += event.data
                if (event.data) handlers.onToken?.(event.data)
                break
            case 'usedTools':
                captureTools(event.data)
                break
            case 'metadata':
                // Never forward the child's chatId/messageId to the parent's client.
                captureTools(event.data?.usedTools)
                break
            case 'end':
                ended = true
                break
            case 'error':
                throw new Error('Vora Chatflow Tool child prediction failed while streaming.')
            case 'abort':
                throw new Error('Vora Chatflow Tool child prediction was aborted.')
        }
    }

    const drain = () => {
        let boundary: RegExpExecArray | null
        while (!ended && (boundary = /\r?\n\r?\n/.exec(buffer))) {
            const raw = buffer.slice(0, boundary.index)
            buffer = buffer.slice(boundary.index + boundary[0].length)
            frame(raw)
        }
    }

    try {
        if (!body) throw new Error('Vora Chatflow Tool received an empty child stream.')
        for await (const chunk of body) {
            buffer += decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
            drain()
            if (ended) break
        }
        buffer += decoder.end()
        drain()
        if (!ended && buffer.trim()) frame(buffer)
        if (!ended) throw new Error('Vora Chatflow Tool child stream ended before completion.')
        return text
    } finally {
        body?.destroy?.()
    }
}
