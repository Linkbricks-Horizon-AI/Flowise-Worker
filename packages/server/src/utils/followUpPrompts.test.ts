import { generateFollowUpPrompts } from 'flowise-components'
import { resolveFollowUpPrompts } from './followUpPrompts'
import logger from './logger'

jest.mock('flowise-components', () => ({
    generateFollowUpPrompts: jest.fn()
}))

jest.mock('./logger', () => ({
    __esModule: true,
    default: { warn: jest.fn() }
}))

const generateFollowUpPromptsMock = generateFollowUpPrompts as jest.MockedFunction<typeof generateFollowUpPrompts>
const loggerWarnMock = logger.warn as jest.Mock

const config = JSON.stringify({ status: true, selectedProvider: 'openai' })
const options = { chatId: 'chat-1', chatflowid: 'flow-1' }

describe('resolveFollowUpPrompts', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('returns the generated questions as a JSON string', async () => {
        generateFollowUpPromptsMock.mockResolvedValue({ questions: ['a', 'b'] })

        await expect(resolveFollowUpPrompts(config, 'answer', options)).resolves.toBe('["a","b"]')
    })

    it('skips generation entirely when the chatflow has no follow-up prompt config', async () => {
        await expect(resolveFollowUpPrompts(null, 'answer', options)).resolves.toBeUndefined()

        expect(generateFollowUpPromptsMock).not.toHaveBeenCalled()
    })

    it('drops the follow-up prompts instead of throwing when the provider is down', async () => {
        const providerOutage = Object.assign(new Error('500 The server had an error'), { status: 500 })
        generateFollowUpPromptsMock.mockRejectedValue(providerOutage)

        await expect(resolveFollowUpPrompts(config, 'answer', options)).resolves.toBeUndefined()

        expect(loggerWarnMock).toHaveBeenCalledWith(expect.stringContaining('Follow-up prompts skipped'))
    })

    it('drops the follow-up prompts when the stored config is not valid JSON', async () => {
        await expect(resolveFollowUpPrompts('{not json', 'answer', options)).resolves.toBeUndefined()

        expect(generateFollowUpPromptsMock).not.toHaveBeenCalled()
        expect(loggerWarnMock).toHaveBeenCalled()
    })

    it('returns undefined when the provider answers without questions', async () => {
        generateFollowUpPromptsMock.mockResolvedValue(undefined)

        await expect(resolveFollowUpPrompts(config, 'answer', options)).resolves.toBeUndefined()
    })
})
