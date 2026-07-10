import { AIMessage, AIMessageChunk } from '@langchain/core/messages'
import { ChatGenerationChunk } from '@langchain/core/outputs'
import { ChatOpenRouter } from './FlowiseChatOpenRouter'

const createProviderError = (message: string, status: number): Error => {
    const error = new Error(message) as Error & { status: number; response: { status: number } }
    error.status = status
    error.response = { status }
    return error
}

const parseAttempt = (attempt: string): { modelName: string; apiKey: string } => {
    const separatorIndex = attempt.lastIndexOf(':')
    return { modelName: attempt.slice(0, separatorIndex), apiKey: attempt.slice(separatorIndex + 1) }
}

class DeterministicChatOpenRouter extends ChatOpenRouter {
    readonly attempts: string[] = []
    mode: 'success' | 'generateFallback' | 'streamBeforeTokenFallback' | 'streamAfterTokenFailure' = 'generateFallback'
    failuresRemaining = 1
    failureStatus = 503

    protected createAttemptModel(attempt: any): any {
        const attempts = this.attempts
        const mode = this.mode
        const model = this

        return {
            async _generate() {
                attempts.push(`${attempt.modelName}:${attempt.apiKey}`)
                if (mode === 'generateFallback' && model.failuresRemaining > 0) {
                    model.failuresRemaining -= 1
                    throw createProviderError('first attempt failed', model.failureStatus)
                }

                return {
                    generations: [
                        {
                            text: 'ok',
                            message: new AIMessage('ok')
                        }
                    ],
                    llmOutput: {}
                }
            },
            async *_streamResponseChunks() {
                attempts.push(`${attempt.modelName}:${attempt.apiKey}`)

                if (mode === 'streamBeforeTokenFallback' && model.failuresRemaining > 0) {
                    model.failuresRemaining -= 1
                    throw createProviderError('stream failed before token', model.failureStatus)
                }

                yield new ChatGenerationChunk({
                    text: 'ok',
                    message: new AIMessageChunk({ content: 'ok' })
                })

                if (mode === 'streamAfterTokenFailure') {
                    throw new Error('stream failed after token')
                }
            }
        }
    }
}

const attachDeterministicAttemptModel = (
    model: ChatOpenRouter,
    options: {
        mode?: 'success' | 'generateFallback' | 'streamBeforeTokenFallback' | 'streamAfterTokenFailure'
        failuresRemaining?: number
        failureStatus?: number
    } = {}
) => {
    const attempts: string[] = []
    const state = {
        mode: options.mode ?? 'success',
        failuresRemaining: options.failuresRemaining ?? 0,
        failureStatus: options.failureStatus ?? 503
    }

    ;(model as any).createAttemptModel = (attempt: any): any => ({
        async _generate() {
            attempts.push(`${attempt.modelName}:${attempt.apiKey}`)
            if (state.mode === 'generateFallback' && state.failuresRemaining > 0) {
                state.failuresRemaining -= 1
                throw createProviderError('first attempt failed', state.failureStatus)
            }

            return {
                generations: [
                    {
                        text: 'ok',
                        message: new AIMessage('ok')
                    }
                ],
                llmOutput: {}
            }
        },
        async *_streamResponseChunks() {
            attempts.push(`${attempt.modelName}:${attempt.apiKey}`)

            if (state.mode === 'streamBeforeTokenFallback' && state.failuresRemaining > 0) {
                state.failuresRemaining -= 1
                throw createProviderError('stream failed before token', state.failureStatus)
            }

            yield new ChatGenerationChunk({
                text: 'ok',
                message: new AIMessageChunk({ content: 'ok' })
            })

            if (state.mode === 'streamAfterTokenFailure') {
                throw new Error('stream failed after token')
            }
        }
    })

    return { attempts, state }
}

describe('ChatOpenRouter fallback candidates', () => {
    it('uses the first comma-separated model as the cache model and removes multiple API keys from the cache key', () => {
        const model = new ChatOpenRouter('chatOpenRouter_0', {
            modelName: 'openai/gpt-5.4, openai/gpt-5.5',
            apiKey: 'key-a, key-b',
            temperature: 0.7
        })

        const params = model._identifyingParams()
        const cacheKey = model._getSerializedCacheKeyParametersForCall({})

        expect(params.model_name).toBe('openai/gpt-5.4')
        expect(params.model).toBe('openai/gpt-5.4')
        expect(params.apiKey).toBeUndefined()
        expect(cacheKey).toContain('openai/gpt-5.4')
        expect(cacheKey).not.toContain('openai/gpt-5.5')
        expect(cacheKey).not.toContain('key-a')
        expect(cacheKey).not.toContain('key-b')
    })

    it('keeps single model and single key cache parameters unchanged', () => {
        const model = new ChatOpenRouter('chatOpenRouter_0', {
            modelName: 'openai/gpt-5.4',
            apiKey: 'key-a',
            temperature: 0.7
        })

        const params = model._identifyingParams()

        expect(params.model_name).toBe('openai/gpt-5.4')
        expect(params.model).toBe('openai/gpt-5.4')
        expect(params.apiKey).toBe('key-a')
    })

    it('falls back to the next model/key pair when a non-streaming call fails', async () => {
        const model = new DeterministicChatOpenRouter('chatOpenRouter_0', {
            modelName: 'openai/gpt-5.4, openai/gpt-5.5',
            apiKey: 'key-a, key-b',
            roundRobinScope: 'test-generate-fallback',
            roundRobinSessionId: 'session-a'
        })

        const result = await model._generate([], {} as any)

        expect(result.generations[0].text).toBe('ok')
        expect(model.attempts).toHaveLength(2)
        const [first, second] = model.attempts.map(parseAttempt)
        expect(second.modelName).not.toBe(first.modelName)
        expect(second.apiKey).not.toBe(first.apiKey)
    })

    it('does not fall back to another model/key pair for request or configuration errors', async () => {
        const model = new DeterministicChatOpenRouter('chatOpenRouter_0', {
            modelName: 'openai/gpt-5.4, openai/gpt-5.5',
            apiKey: 'key-a, key-b',
            roundRobinScope: 'test-generate-no-fallback-on-config-error',
            roundRobinSessionId: 'session-a'
        })
        model.failureStatus = 400

        await expect(model._generate([], {} as any)).rejects.toThrow('first attempt failed')

        expect(model.attempts).toHaveLength(1)
    })

    it('falls back to another model/key pair for forbidden errors', async () => {
        const model = new DeterministicChatOpenRouter('chatOpenRouter_0', {
            modelName: 'openai/gpt-5.4, openai/gpt-5.5',
            apiKey: 'key-a, key-b',
            roundRobinScope: 'test-generate-fallback-on-forbidden-error',
            roundRobinSessionId: 'session-a'
        })
        model.failureStatus = 403

        const result = await model._generate([], {} as any)

        expect(result.generations[0].text).toBe('ok')
        expect(model.attempts).toHaveLength(2)
        const [first, second] = model.attempts.map(parseAttempt)
        expect(second.modelName).not.toBe(first.modelName)
        expect(second.apiKey).not.toBe(first.apiKey)
    })

    it('falls back for streaming failures before the first token', async () => {
        const model = new DeterministicChatOpenRouter('chatOpenRouter_0', {
            modelName: 'openai/gpt-5.4, openai/gpt-5.5',
            apiKey: 'key-a',
            roundRobinScope: 'test-stream-fallback',
            roundRobinSessionId: 'session-a'
        })
        model.mode = 'streamBeforeTokenFallback'

        const chunks: string[] = []
        for await (const chunk of model._streamResponseChunks([], {} as any)) {
            chunks.push(chunk.text)
        }

        expect(chunks).toEqual(['ok'])
        expect(model.attempts).toHaveLength(2)
        const [first, second] = model.attempts.map(parseAttempt)
        expect(second.modelName).not.toBe(first.modelName)
        expect(second.apiKey).toBe(first.apiKey)
    })

    it('falls back for streaming forbidden errors before the first token', async () => {
        const model = new DeterministicChatOpenRouter('chatOpenRouter_0', {
            modelName: 'openai/gpt-5.4, openai/gpt-5.5',
            apiKey: 'key-a',
            roundRobinScope: 'test-stream-fallback-on-forbidden-error',
            roundRobinSessionId: 'session-a'
        })
        model.mode = 'streamBeforeTokenFallback'
        model.failureStatus = 403

        const chunks: string[] = []
        for await (const chunk of model._streamResponseChunks([], {} as any)) {
            chunks.push(chunk.text)
        }

        expect(chunks).toEqual(['ok'])
        expect(model.attempts).toHaveLength(2)
        const [first, second] = model.attempts.map(parseAttempt)
        expect(second.modelName).not.toBe(first.modelName)
        expect(second.apiKey).toBe(first.apiKey)
    })

    it('does not fall back for streaming request or configuration errors before the first token', async () => {
        const model = new DeterministicChatOpenRouter('chatOpenRouter_0', {
            modelName: 'openai/gpt-5.4, openai/gpt-5.5',
            apiKey: 'key-a',
            roundRobinScope: 'test-stream-no-fallback-on-config-error',
            roundRobinSessionId: 'session-a'
        })
        model.mode = 'streamBeforeTokenFallback'
        model.failureStatus = 400

        const chunks: string[] = []
        await expect(async () => {
            for await (const chunk of model._streamResponseChunks([], {} as any)) {
                chunks.push(chunk.text)
            }
        }).rejects.toThrow('stream failed before token')

        expect(chunks).toEqual([])
        expect(model.attempts).toHaveLength(1)
    })

    it('does not fall back for streaming failures after a token was yielded', async () => {
        const model = new DeterministicChatOpenRouter('chatOpenRouter_0', {
            modelName: 'openai/gpt-5.4, openai/gpt-5.5',
            apiKey: 'key-a',
            roundRobinScope: 'test-stream-after-token',
            roundRobinSessionId: 'session-a'
        })
        model.mode = 'streamAfterTokenFailure'

        const chunks: string[] = []
        await expect(async () => {
            for await (const chunk of model._streamResponseChunks([], {} as any)) {
                chunks.push(chunk.text)
            }
        }).rejects.toThrow('stream failed after token')

        expect(chunks).toEqual(['ok'])
        expect(model.attempts).toHaveLength(1)
    })

    it('keeps the assigned primary attempt across calls within the same session', async () => {
        const model = new DeterministicChatOpenRouter('chatOpenRouter_0', {
            modelName: 'openai/gpt-5.4, openai/gpt-5.5',
            apiKey: 'key-a, key-b',
            roundRobinScope: 'test-same-session',
            roundRobinSessionId: 'session-a'
        })
        const rebuiltModelForSameSession = new DeterministicChatOpenRouter('chatOpenRouter_0', {
            modelName: 'openai/gpt-5.4, openai/gpt-5.5',
            apiKey: 'key-a, key-b',
            roundRobinScope: 'test-same-session',
            roundRobinSessionId: 'session-a'
        })
        model.mode = 'success'
        rebuiltModelForSameSession.mode = 'success'

        await model._generate([], {} as any)
        await model._generate([], {} as any)
        await model._generate([], {} as any)
        await rebuiltModelForSameSession._generate([], {} as any)

        expect(model.attempts).toHaveLength(3)
        expect(new Set(model.attempts).size).toBe(1)
        expect(rebuiltModelForSameSession.attempts).toEqual([model.attempts[0]])
    })

    it('pins each session to a hash-determined attempt that is identical in every process', async () => {
        // Golden FNV-1a values: any change to the hash or key layout breaks cross-worker pinning
        const expectedAssignments: Record<string, string> = {
            'session-1': 'openai/gpt-5.5:key-a',
            'session-2': 'openai/gpt-5.5:key-b',
            'session-3': 'openai/gpt-5.4:key-a',
            'session-4': 'openai/gpt-5.4:key-b'
        }

        for (const [sessionId, expectedAttempt] of Object.entries(expectedAssignments)) {
            const model = new DeterministicChatOpenRouter('chatOpenRouter_0', {
                modelName: 'openai/gpt-5.4, openai/gpt-5.5',
                apiKey: 'key-a, key-b',
                roundRobinScope: 'golden-scope',
                roundRobinSessionId: sessionId
            })
            model.mode = 'success'

            await model._generate([], {} as any)

            expect(model.attempts).toEqual([expectedAttempt])
        }
    })

    it('assigns the same attempt to a session regardless of arrival order across worker processes', async () => {
        const loadFreshChatOpenRouter = (): typeof ChatOpenRouter => {
            let fresh: typeof ChatOpenRouter | undefined
            jest.isolateModules(() => {
                fresh = require('./FlowiseChatOpenRouter').ChatOpenRouter
            })
            return fresh!
        }
        const runSession = async (WorkerChatOpenRouter: typeof ChatOpenRouter, sessionId: string): Promise<string> => {
            const model = new WorkerChatOpenRouter('chatOpenRouter_0', {
                modelName: 'openai/gpt-5.4, openai/gpt-5.5',
                apiKey: 'key-a, key-b',
                roundRobinScope: 'test-arrival-order',
                roundRobinSessionId: sessionId
            })
            const deterministic = attachDeterministicAttemptModel(model)
            await model._generate([], {} as any)
            return deterministic.attempts[0]
        }

        const workerOne = loadFreshChatOpenRouter()
        const workerOneSessionX = await runSession(workerOne, 'session-x')
        const workerOneSessionY = await runSession(workerOne, 'session-y')

        const workerTwo = loadFreshChatOpenRouter()
        const workerTwoSessionY = await runSession(workerTwo, 'session-y')
        const workerTwoSessionX = await runSession(workerTwo, 'session-x')

        expect(workerTwoSessionX).toBe(workerOneSessionX)
        expect(workerTwoSessionY).toBe(workerOneSessionY)
    })

    it('rotates attempts across calls when no session id is provided', async () => {
        const model = new DeterministicChatOpenRouter('chatOpenRouter_0', {
            modelName: 'openai/gpt-5.4, openai/gpt-5.5',
            apiKey: 'key-a, key-b',
            roundRobinScope: 'test-sessionless-rotation'
        })
        model.mode = 'success'

        await model._generate([], {} as any)
        await model._generate([], {} as any)
        await model._generate([], {} as any)
        await model._generate([], {} as any)

        expect(model.attempts).toEqual([
            'openai/gpt-5.4:key-a',
            'openai/gpt-5.4:key-b',
            'openai/gpt-5.5:key-a',
            'openai/gpt-5.5:key-b'
        ])
    })

    it('tries remaining model/key pairs before failing when preferred fallbacks are exhausted', async () => {
        const model = new DeterministicChatOpenRouter('chatOpenRouter_0', {
            modelName: 'openai/gpt-5.4, openai/gpt-5.5',
            apiKey: 'key-a, key-b',
            roundRobinScope: 'test-exhausted-preferred-fallbacks',
            roundRobinSessionId: 'session-a'
        })
        model.failuresRemaining = 2

        const result = await model._generate([], {} as any)

        expect(result.generations[0].text).toBe('ok')
        // Hash start index is 2 for this scope/session, so the rotated order is
        // [5.5:a, 5.5:b, 5.4:a, 5.4:b]; after 5.5:a fails, the both-clean pick is 5.4:b,
        // and full exhaustion falls through to the first untried attempt 5.5:b.
        expect(model.attempts).toEqual(['openai/gpt-5.5:key-a', 'openai/gpt-5.4:key-b', 'openai/gpt-5.5:key-b'])
    })

    it('preserves ChatOpenRouter and accumulates default options when withConfig is chained', () => {
        const model = new ChatOpenRouter('chatOpenRouter_0', {
            modelName: 'openai/gpt-5.4, openai/gpt-5.5',
            apiKey: 'key-a, key-b',
            roundRobinScope: 'test-with-config-chain',
            roundRobinSessionId: 'session-a'
        })

        const configured = model.withConfig({ stop: ['END'] } as any)
        const chained = configured.withConfig({ tags: ['tag-a'] } as any)

        expect(configured).toBeInstanceOf(ChatOpenRouter)
        expect(chained).toBeInstanceOf(ChatOpenRouter)
        expect((chained as any).defaultOptions).toEqual({
            stop: ['END'],
            tags: ['tag-a']
        })
    })

    it('preserves multi modal options when withConfig rebuilds the wrapper', () => {
        const model = new ChatOpenRouter('chatOpenRouter_0', {
            modelName: 'openai/gpt-5.4, openai/gpt-5.5',
            apiKey: 'key-a, key-b',
            roundRobinScope: 'test-with-config-multimodal',
            roundRobinSessionId: 'session-a'
        })
        const multiModalOption = { image: { allowImageUploads: true } }

        model.setMultiModalOption(multiModalOption)
        const configured = model.withConfig({ stop: ['END'] } as any)

        expect(configured).toBeInstanceOf(ChatOpenRouter)
        expect((configured as any).multiModalOption).toBe(multiModalOption)
    })

    it('keeps single model and single key attempts unchanged after bindTools', () => {
        const model = new ChatOpenRouter('chatOpenRouter_0', {
            modelName: 'openai/gpt-5.4',
            apiKey: 'key-a',
            roundRobinScope: 'test-bind-tools-single',
            roundRobinSessionId: 'session-a'
        })

        const bound = model.bindTools([])

        expect(bound).toBeInstanceOf(ChatOpenRouter)
        expect((bound as any).getAllAttempts()).toEqual([
            {
                modelName: 'openai/gpt-5.4',
                apiKey: 'key-a',
                apiKeyIndex: 0
            }
        ])
    })

    it('preserves round-robin session assignment after bindTools', async () => {
        const buildFixture = (sessionId: string) =>
            new ChatOpenRouter('chatOpenRouter_0', {
                modelName: 'openai/gpt-5.4, openai/gpt-5.5',
                apiKey: 'key-a, key-b',
                roundRobinScope: 'test-bind-tools-session-assignment',
                roundRobinSessionId: sessionId
            })
        const sessionA = buildFixture('session-a')
        const sessionB = buildFixture('session-b')

        const boundA = sessionA.bindTools([]) as ChatOpenRouter
        const boundB = sessionB.bindTools([]) as ChatOpenRouter
        const deterministicA = attachDeterministicAttemptModel(boundA)
        const deterministicB = attachDeterministicAttemptModel(boundB)

        await boundA._generate([], {} as any)
        await boundA._generate([], {} as any)
        await boundB._generate([], {} as any)

        expect(boundA).toBeInstanceOf(ChatOpenRouter)
        expect(boundB).toBeInstanceOf(ChatOpenRouter)
        expect((boundA as any).defaultOptions.tools).toEqual([])
        expect(deterministicA.attempts).toHaveLength(2)
        expect(new Set(deterministicA.attempts).size).toBe(1)
        expect(deterministicB.attempts).toHaveLength(1)

        const unboundSessionB = buildFixture('session-b')
        const deterministicUnboundB = attachDeterministicAttemptModel(unboundSessionB)
        await unboundSessionB._generate([], {} as any)
        expect(deterministicB.attempts[0]).toBe(deterministicUnboundB.attempts[0])
    })

    it('falls back to another model/key pair after bindTools', async () => {
        const model = new ChatOpenRouter('chatOpenRouter_0', {
            modelName: 'openai/gpt-5.4, openai/gpt-5.5',
            apiKey: 'key-a, key-b',
            roundRobinScope: 'test-bind-tools-fallback',
            roundRobinSessionId: 'session-a'
        })
        const bound = model.bindTools([]) as ChatOpenRouter
        const deterministic = attachDeterministicAttemptModel(bound, {
            mode: 'generateFallback',
            failuresRemaining: 1
        })

        const result = await bound._generate([], {} as any)

        expect(result.generations[0].text).toBe('ok')
        expect(deterministic.attempts).toHaveLength(2)
        const [first, second] = deterministic.attempts.map(parseAttempt)
        expect(second.modelName).not.toBe(first.modelName)
        expect(second.apiKey).not.toBe(first.apiKey)
    })

    it('preserves streaming round-robin after bindTools', async () => {
        const model = new ChatOpenRouter('chatOpenRouter_0', {
            modelName: 'openai/gpt-5.4, openai/gpt-5.5',
            apiKey: 'key-a',
            roundRobinScope: 'test-bind-tools-stream',
            roundRobinSessionId: 'session-a'
        })
        const bound = model.bindTools([]) as ChatOpenRouter
        const deterministic = attachDeterministicAttemptModel(bound, {
            mode: 'streamBeforeTokenFallback',
            failuresRemaining: 1
        })

        const chunks: string[] = []
        for await (const chunk of bound._streamResponseChunks([], {} as any)) {
            chunks.push(chunk.text)
        }

        expect(chunks).toEqual(['ok'])
        expect(deterministic.attempts).toHaveLength(2)
        const [first, second] = deterministic.attempts.map(parseAttempt)
        expect(second.modelName).not.toBe(first.modelName)
        expect(second.apiKey).toBe(first.apiKey)
    })

    it('keeps the ChatOpenRouter wrapper for structured output configuration', () => {
        const model = new ChatOpenRouter('chatOpenRouter_0', {
            modelName: 'openai/gpt-5.4, openai/gpt-5.5',
            apiKey: 'key-a, key-b',
            roundRobinScope: 'test-structured-output',
            roundRobinSessionId: 'session-a'
        })
        const originalWithConfig = model.withConfig.bind(model)
        let configuredModel: ReturnType<ChatOpenRouter['withConfig']> | undefined
        ;(model as any).withConfig = (config: any) => {
            configuredModel = originalWithConfig(config)
            return configuredModel
        }

        model.withStructuredOutput(
            {
                title: 'extract',
                type: 'object',
                properties: {
                    answer: {
                        type: 'string'
                    }
                },
                required: ['answer']
            },
            { method: 'jsonMode' } as any
        )

        expect(configuredModel).toBeInstanceOf(ChatOpenRouter)
        expect((configuredModel as any).defaultOptions.response_format).toEqual({ type: 'json_object' })
    })
})
