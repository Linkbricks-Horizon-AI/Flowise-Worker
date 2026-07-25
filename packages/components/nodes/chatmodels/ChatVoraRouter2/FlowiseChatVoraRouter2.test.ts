import { AIMessage, AIMessageChunk } from '@langchain/core/messages'
import { ChatGenerationChunk } from '@langchain/core/outputs'
import { APIError } from 'openai'
import { ChatVoraRouter2, VoraRouter2FallbackConfig } from './FlowiseChatVoraRouter2'

const createProviderError = (message: string, status?: number): Error => {
    const error = new Error(message) as Error & { status?: number; response?: { status: number } }
    if (status !== undefined) {
        error.status = status
        error.response = { status }
    }
    return error
}

class DeterministicChatVoraRouter2 extends ChatVoraRouter2 {
    readonly primaryAttempts: string[] = []
    readonly fallbackAttempts: string[] = []
    primaryMode: 'fail' | 'streamAfterTokenFailure' = 'fail'
    primaryFailureMessage = 'primary failed'
    primaryStreamFailureMessage = 'primary stream failed before token'
    primaryFailureStatus: number | undefined = 503
    primaryFailureError: Error | undefined = undefined
    fallbackFailureStatuses: number[] = []

    protected createAttemptModel(attempt: any): any {
        const model = this
        return {
            async _generate() {
                model.primaryAttempts.push(`${attempt.modelName}:${attempt.apiKey}`)
                throw model.primaryFailureError ?? createProviderError(model.primaryFailureMessage, model.primaryFailureStatus)
            },
            async *_streamResponseChunks() {
                model.primaryAttempts.push(`${attempt.modelName}:${attempt.apiKey}`)
                if (model.primaryMode === 'streamAfterTokenFailure') {
                    yield new ChatGenerationChunk({
                        text: 'primary',
                        message: new AIMessageChunk({ content: 'primary' })
                    })
                    throw new Error('primary stream failed after token')
                }
                throw model.primaryFailureError ?? createProviderError(model.primaryStreamFailureMessage, model.primaryFailureStatus)
            }
        }
    }

    protected createFallbackModel(fallback: VoraRouter2FallbackConfig): any {
        const model = this
        return {
            async _generate() {
                model.fallbackAttempts.push(`${fallback.provider}:${fallback.modelName}`)
                const fallbackFailureStatus = model.fallbackFailureStatuses.shift()
                if (fallbackFailureStatus) {
                    throw createProviderError('fallback failed', fallbackFailureStatus)
                }

                return {
                    generations: [
                        {
                            text: 'fallback ok',
                            message: new AIMessage('fallback ok')
                        }
                    ],
                    llmOutput: {}
                }
            },
            async *_streamResponseChunks() {
                model.fallbackAttempts.push(`${fallback.provider}:${fallback.modelName}`)
                yield new ChatGenerationChunk({
                    text: 'fallback ok',
                    message: new AIMessageChunk({ content: 'fallback ok' })
                })
            }
        }
    }
}

const fallbackConfigs: VoraRouter2FallbackConfig[] = [
    {
        provider: 'openai',
        providerLabel: 'OpenAI',
        modelName: 'gpt-fallback',
        apiKey: 'openai-key',
        order: 2
    },
    {
        provider: 'xai',
        providerLabel: 'xAI Grok',
        modelName: 'grok-fallback',
        apiKey: 'xai-key',
        order: 1
    }
]

let fixtureScopeCounter = 0

describe('ChatVoraRouter2 provider fallbacks', () => {
    it('runs provider fallbacks by configured order after primary OpenRouter attempts fail', async () => {
        const model = new DeterministicChatVoraRouter2(
            'chatVoraRouter2_0',
            {
                modelName: 'openrouter-a, openrouter-b',
                apiKey: 'openrouter-key',
                roundRobinScope: `vora2-fixture-${fixtureScopeCounter++}`
            },
            fallbackConfigs
        )
        model.fallbackFailureStatuses = [503]

        const result = await model._generate([], {} as any)

        expect(result.generations[0].text).toBe('fallback ok')
        expect(model.primaryAttempts).toEqual(['openrouter-a:openrouter-key', 'openrouter-b:openrouter-key'])
        expect(model.fallbackAttempts).toEqual(['xai:grok-fallback', 'openai:gpt-fallback'])
        expect(result.generations[0].generationInfo?.vora_router2_fallback_provider).toBe('openai')
    })

    it('runs provider fallbacks when the primary OpenRouter failure is a 500', async () => {
        const model = new DeterministicChatVoraRouter2(
            'chatVoraRouter2_0',
            {
                modelName: 'openrouter-a, openrouter-b',
                apiKey: 'openrouter-key',
                roundRobinScope: `vora2-fixture-${fixtureScopeCounter++}`
            },
            fallbackConfigs
        )
        model.primaryFailureStatus = 500

        const result = await model._generate([], {} as any)

        expect(result.generations[0].text).toBe('fallback ok')
        expect(model.fallbackAttempts).toEqual(['xai:grok-fallback'])
    })

    it('runs provider fallbacks when OpenRouter reports the provider 500 inside the SSE stream', async () => {
        const model = new DeterministicChatVoraRouter2(
            'chatVoraRouter2_0',
            {
                modelName: 'openrouter-a, openrouter-b',
                apiKey: 'openrouter-key',
                roundRobinScope: `vora2-fixture-${fixtureScopeCounter++}`
            },
            fallbackConfigs
        )
        // HTTP 200 stream carrying an error payload: the OpenAI SDK throws this with no status,
        // so the 5xx is only visible as a numeric `code`.
        model.primaryFailureError = new APIError(undefined, { message: 'Provider returned error', code: 500 }, undefined, undefined)

        const result = await model._generate([], {} as any)

        expect(result.generations[0].text).toBe('fallback ok')
        expect(model.primaryAttempts).toEqual(['openrouter-a:openrouter-key', 'openrouter-b:openrouter-key'])
        expect(model.fallbackAttempts).toEqual(['xai:grok-fallback'])
    })

    it('runs streaming provider fallbacks when OpenRouter reports the provider 500 inside the SSE stream', async () => {
        const model = new DeterministicChatVoraRouter2(
            'chatVoraRouter2_0',
            {
                modelName: 'openrouter-a, openrouter-b',
                apiKey: 'openrouter-key',
                roundRobinScope: `vora2-fixture-${fixtureScopeCounter++}`
            },
            fallbackConfigs
        )
        model.primaryFailureError = new APIError(undefined, { message: 'Provider returned error', code: 500 }, undefined, undefined)

        const chunks: string[] = []
        for await (const chunk of model._streamResponseChunks([], {} as any)) {
            chunks.push(chunk.text)
        }

        expect(chunks).toEqual(['fallback ok'])
        expect(model.fallbackAttempts).toEqual(['xai:grok-fallback'])
    })

    it('does not run provider fallbacks when the primary OpenRouter failure is a request or configuration error', async () => {
        const model = new DeterministicChatVoraRouter2(
            'chatVoraRouter2_0',
            {
                modelName: 'openrouter-a, openrouter-b',
                apiKey: 'openrouter-key',
                roundRobinScope: `vora2-fixture-${fixtureScopeCounter++}`
            },
            fallbackConfigs
        )
        model.primaryFailureStatus = 400

        await expect(model._generate([], {} as any)).rejects.toThrow('primary failed')

        expect(model.primaryAttempts).toEqual(['openrouter-a:openrouter-key'])
        expect(model.fallbackAttempts).toEqual([])
    })

    it('runs provider fallbacks when the primary OpenRouter failure is forbidden', async () => {
        const model = new DeterministicChatVoraRouter2(
            'chatVoraRouter2_0',
            {
                modelName: 'openrouter-a, openrouter-b',
                apiKey: 'openrouter-key',
                roundRobinScope: `vora2-fixture-${fixtureScopeCounter++}`
            },
            fallbackConfigs
        )
        model.primaryFailureStatus = 403

        const result = await model._generate([], {} as any)

        expect(result.generations[0].text).toBe('fallback ok')
        expect(model.primaryAttempts).toEqual(['openrouter-a:openrouter-key', 'openrouter-b:openrouter-key'])
        expect(model.fallbackAttempts).toEqual(['xai:grok-fallback'])
        expect(result.generations[0].generationInfo?.vora_router2_fallback_provider).toBe('xai')
    })

    it('runs provider fallbacks when the primary OpenRouter failure message is forbidden', async () => {
        const model = new DeterministicChatVoraRouter2(
            'chatVoraRouter2_0',
            {
                modelName: 'openrouter-a, openrouter-b',
                apiKey: 'openrouter-key',
                roundRobinScope: `vora2-fixture-${fixtureScopeCounter++}`
            },
            fallbackConfigs
        )
        model.primaryFailureMessage = 'Forbidden'
        model.primaryFailureStatus = undefined

        const result = await model._generate([], {} as any)

        expect(result.generations[0].text).toBe('fallback ok')
        expect(model.primaryAttempts).toEqual(['openrouter-a:openrouter-key', 'openrouter-b:openrouter-key'])
        expect(model.fallbackAttempts).toEqual(['xai:grok-fallback'])
    })

    it('falls back for streaming primary failures before the first token', async () => {
        const model = new DeterministicChatVoraRouter2(
            'chatVoraRouter2_0',
            {
                modelName: 'openrouter-a, openrouter-b',
                apiKey: 'openrouter-key',
                roundRobinScope: `vora2-fixture-${fixtureScopeCounter++}`
            },
            fallbackConfigs
        )

        const chunks: string[] = []
        for await (const chunk of model._streamResponseChunks([], {} as any)) {
            chunks.push(chunk.text)
        }

        expect(chunks).toEqual(['fallback ok'])
        expect(model.fallbackAttempts).toEqual(['xai:grok-fallback'])
    })

    it('does not run streaming provider fallbacks when the primary failure is a request or configuration error', async () => {
        const model = new DeterministicChatVoraRouter2(
            'chatVoraRouter2_0',
            {
                modelName: 'openrouter-a, openrouter-b',
                apiKey: 'openrouter-key',
                roundRobinScope: `vora2-fixture-${fixtureScopeCounter++}`
            },
            fallbackConfigs
        )
        model.primaryFailureStatus = 400

        const chunks: string[] = []
        await expect(async () => {
            for await (const chunk of model._streamResponseChunks([], {} as any)) {
                chunks.push(chunk.text)
            }
        }).rejects.toThrow('primary stream failed before token')

        expect(chunks).toEqual([])
        expect(model.primaryAttempts).toEqual(['openrouter-a:openrouter-key'])
        expect(model.fallbackAttempts).toEqual([])
    })

    it('runs streaming provider fallbacks when the primary OpenRouter failure is forbidden before the first token', async () => {
        const model = new DeterministicChatVoraRouter2(
            'chatVoraRouter2_0',
            {
                modelName: 'openrouter-a, openrouter-b',
                apiKey: 'openrouter-key',
                roundRobinScope: `vora2-fixture-${fixtureScopeCounter++}`
            },
            fallbackConfigs
        )
        model.primaryFailureStatus = 403

        const chunks: string[] = []
        for await (const chunk of model._streamResponseChunks([], {} as any)) {
            chunks.push(chunk.text)
        }

        expect(chunks).toEqual(['fallback ok'])
        expect(model.primaryAttempts).toEqual(['openrouter-a:openrouter-key', 'openrouter-b:openrouter-key'])
        expect(model.fallbackAttempts).toEqual(['xai:grok-fallback'])
    })

    it('stops the provider fallback chain when a fallback provider returns a request or configuration error', async () => {
        const model = new DeterministicChatVoraRouter2(
            'chatVoraRouter2_0',
            {
                modelName: 'openrouter-a, openrouter-b',
                apiKey: 'openrouter-key',
                roundRobinScope: `vora2-fixture-${fixtureScopeCounter++}`
            },
            fallbackConfigs
        )
        model.fallbackFailureStatuses = [400]

        await expect(model._generate([], {} as any)).rejects.toThrow('fallback failed')

        expect(model.fallbackAttempts).toEqual(['xai:grok-fallback'])
    })

    it('continues the provider fallback chain when a fallback provider returns forbidden', async () => {
        const model = new DeterministicChatVoraRouter2(
            'chatVoraRouter2_0',
            {
                modelName: 'openrouter-a, openrouter-b',
                apiKey: 'openrouter-key',
                roundRobinScope: `vora2-fixture-${fixtureScopeCounter++}`
            },
            fallbackConfigs
        )
        model.fallbackFailureStatuses = [403]

        const result = await model._generate([], {} as any)

        expect(result.generations[0].text).toBe('fallback ok')
        expect(model.fallbackAttempts).toEqual(['xai:grok-fallback', 'openai:gpt-fallback'])
        expect(result.generations[0].generationInfo?.vora_router2_fallback_provider).toBe('openai')
    })

    it('does not switch providers after a streaming primary attempt has yielded a token', async () => {
        const model = new DeterministicChatVoraRouter2(
            'chatVoraRouter2_0',
            {
                modelName: 'openrouter-a, openrouter-b',
                apiKey: 'openrouter-key',
                roundRobinScope: `vora2-fixture-${fixtureScopeCounter++}`
            },
            fallbackConfigs
        )
        model.primaryMode = 'streamAfterTokenFailure'

        const chunks: string[] = []
        await expect(async () => {
            for await (const chunk of model._streamResponseChunks([], {} as any)) {
                chunks.push(chunk.text)
            }
        }).rejects.toThrow('primary stream failed after token')

        expect(chunks).toEqual(['primary'])
        expect(model.fallbackAttempts).toEqual([])
    })

    it('preserves VoraRouter2 provider fallback behavior through withConfig', async () => {
        const model = new DeterministicChatVoraRouter2(
            'chatVoraRouter2_0',
            {
                modelName: 'openrouter-a, openrouter-b',
                apiKey: 'openrouter-key',
                roundRobinScope: `vora2-fixture-${fixtureScopeCounter++}`
            },
            fallbackConfigs
        )

        const configured = model.withConfig({ tags: ['test'] })

        expect(configured).toBeInstanceOf(ChatVoraRouter2)
        expect(((configured as ChatVoraRouter2)._identifyingParams() as any).vora_router2_fallbacks).toContain('xai:grok-fallback')
    })
})
