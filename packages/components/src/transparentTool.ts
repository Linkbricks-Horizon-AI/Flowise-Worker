import type { IUsedTool } from './Interface'

// Private, instance/call-local metadata. Neither marker is part of the API or model schema.
const TRANSPARENT_TOOL = Symbol('flowise.transparentTool')
const TRANSPARENT_CALL = Symbol('flowise.transparentToolCall')

export function markTransparentTool<T extends object>(tool: T): T {
    Object.defineProperty(tool, TRANSPARENT_TOOL, { value: true })
    return tool
}

export function isTransparentTool(tool: unknown): boolean {
    return Boolean(tool && (tool as any)[TRANSPARENT_TOOL] === true)
}

export function recordToolUsage(tool: unknown, usage: IUsedTool): IUsedTool {
    if (isTransparentTool(tool)) {
        Object.defineProperty(usage, TRANSPARENT_CALL, { value: true })
    }
    return usage
}

export function publicToolUsage(tools: IUsedTool[]): IUsedTool[] {
    return tools.filter((tool) => (tool as any)[TRANSPARENT_CALL] !== true)
}
