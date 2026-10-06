import { Readable } from 'stream'
import { Response } from 'node-fetch'
import { childOverrideConfig, readChildPrediction } from './childPrediction'

const usage = { tool: 'search_music', toolInput: { query: '재즈' }, toolOutput: 'result' }
const event = (name: string, data: unknown) => `message:\ndata:${JSON.stringify({ event: name, data })}\n\n`
const response = (frames: string, chunks = [Buffer.from(frames)]) =>
    new Response(Readable.from(chunks), { headers: { 'content-type': 'text/event-stream' } })

describe('permission-filtered parent variables and explicit child settings', () => {
    it('keeps the complete quota map and protects parent identity without copying other parent settings', () => {
        const tool_usage = '{"vora_tool_search_music":0,"vora_tool_search_wiki":-1,"future_tool":3}'
        const explicit = Object.freeze({ vars: Object.freeze({ user_id: 'wrong', tool_usage: 'wrong', locale: 'ko' }), temperature: 0.3 })
        const actual = childOverrideConfig(explicit, { user_id: 'current-user', tool_usage }, 'parent-session')
        expect(actual).toEqual({
            temperature: 0.3,
            sessionId: 'parent-session',
            vars: { locale: 'ko', user_id: 'current-user', tool_usage }
        })
        expect(explicit.vars.user_id).toBe('wrong')
        expect(actual.vars).not.toBe(explicit.vars)
    })

    it('uses an explicit child session but clears stale manual quota when the parent has no quota map', () => {
        expect(childOverrideConfig('{"sessionId":"explicit","vars":{"tool_usage":"stale"}}', { user_id: 'user' }, 'parent')).toEqual({
            sessionId: 'explicit',
            vars: { user_id: 'user', tool_usage: '' }
        })
    })

    it.each([undefined, null, '', '   ', 123, {}, []])('rejects invalid parent identity %j', (user_id) => {
        expect(() => childOverrideConfig({ vars: { user_id: 'fallback' } }, { user_id })).toThrow('parent request user_id')
    })

    it.each([undefined, null, '', '   '])('allows missing identity %j only when optional, clearing stale child values', (user_id) => {
        expect(
            childOverrideConfig({ vars: { user_id: 'other-user', tool_usage: 'stale', locale: 'ko' } }, { user_id }, 'canvas', false)
        ).toEqual({
            sessionId: 'canvas',
            vars: { user_id: '', tool_usage: '', locale: 'ko' }
        })
    })

    it('still forwards the supplied identity and quota when identity is optional', () => {
        const vars = { user_id: 'current-user', tool_usage: '{"search":0}' }
        expect(childOverrideConfig({ vars: { user_id: 'other-user' } }, vars, 'canvas', false).vars).toEqual(vars)
    })

    it.each([123, false, {}, []])('does not accept malformed identity %j in optional mode', (user_id) => {
        expect(() => childOverrideConfig({}, { user_id }, 'canvas', false)).toThrow('user_id to be a string')
    })

    it.each([null, {}, 0, false])('rejects a non-string quota map %j', (tool_usage) => {
        expect(() => childOverrideConfig({}, { user_id: 'user', tool_usage })).toThrow('tool_usage')
    })

    it('leaves malformed quota JSON handling to existing tool policy', () => {
        expect(childOverrideConfig({}, { user_id: 'user', tool_usage: '{bad' }).vars.tool_usage).toBe('{bad')
    })

    it.each(['{bad', '[]', 4, [], { vars: 'invalid' }, { vars: [] }, { vars: null }])('rejects invalid child settings %j', (override) => {
        expect(() => childOverrideConfig(override, { user_id: 'user' })).toThrow('JSON object')
    })
})

describe('one child prediction response', () => {
    it.each(['\n', '\r\n'])('decodes fragmented Korean UTF-8, frames and final snapshots using %j', async (newline) => {
        const repeatedCalls = [usage, { ...usage }]
        const frames = (
            ':heartbeat\n\n' +
            event('start', '') +
            event('token', '한글 🎵') +
            event('usedTools', [usage]) +
            event('usedTools', repeatedCalls) +
            event('usedTools', repeatedCalls) +
            event('metadata', { chatId: 'child-only', chatMessageId: 'child-message' }) +
            event('end', '[DONE]')
        ).replace(/\n/g, newline)
        const bytes = Buffer.from(frames)
        const onToken = jest.fn()
        const onUsedTools = jest.fn()
        expect(
            await readChildPrediction(
                response(
                    frames,
                    Array.from(bytes, (byte) => Buffer.from([byte]))
                ),
                { onToken, onUsedTools }
            )
        ).toBe('한글 🎵')
        expect(onToken).toHaveBeenCalledWith('한글 🎵')
        expect(onUsedTools).toHaveBeenLastCalledWith(repeatedCalls)
        expect(onUsedTools.mock.calls.at(-1)![0]).toHaveLength(2)
    })

    it('accepts a complete zero-token response and a terminal frame without trailing blank lines', async () => {
        const onUsedTools = jest.fn()
        expect(await readChildPrediction(response(event('usedTools', [usage]) + event('end', '[DONE]').trimEnd()), { onUsedTools })).toBe(
            ''
        )
        expect(onUsedTools).toHaveBeenCalledWith([usage])
    })

    it('accepts multi-line data and ignores unrelated events', async () => {
        const frames =
            'event: message\ndata: {"event":"token",\ndata: "data":"answer"}\n\n' + event('usageMetadata', {}) + 'data: [DONE]\n\n'
        expect(await readChildPrediction(response(frames), { onUsedTools: jest.fn() })).toBe('answer')
    })

    it('processes a JSON response to an SSE request without another prediction', async () => {
        const onUsedTools = jest.fn()
        const res = new Response(JSON.stringify({ text: 'JSON answer', usedTools: [usage] }), {
            headers: { 'content-type': 'application/json' }
        })
        expect(await readChildPrediction(res, { onUsedTools })).toBe('JSON answer')
        expect(onUsedTools).toHaveBeenCalledWith([usage])
    })

    it.each(['', event('token', 'partial'), 'data: {broken}\n\n', event('error', 'secret upstream message'), event('abort', '')])(
        'rejects incomplete or failed streams and keeps previously received usage: %j',
        async (suffix) => {
            const onUsedTools = jest.fn()
            await expect(readChildPrediction(response(event('usedTools', [usage]) + suffix), { onUsedTools })).rejects.toThrow(
                'Vora Chatflow Tool'
            )
            expect(onUsedTools).toHaveBeenCalledWith([usage])
        }
    )

    it('reports HTTP failure without exposing the response body', async () => {
        await expect(readChildPrediction(new Response('private credentials', { status: 403 }), { onUsedTools: jest.fn() })).rejects.toThrow(
            'HTTP 403'
        )
    })

    it('rejects a success-shaped error JSON', async () => {
        await expect(readChildPrediction(new Response('{"text":"partial","error":"failed"}'), { onUsedTools: jest.fn() })).rejects.toThrow(
            'invalid child prediction'
        )
    })
})
