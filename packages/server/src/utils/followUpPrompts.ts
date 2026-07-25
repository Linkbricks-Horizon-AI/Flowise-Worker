import { generateFollowUpPrompts, ICommonObject } from 'flowise-components'
import { getErrorMessage } from '../errors/utils'
import logger from './logger'

/**
 * Follow-up prompts are a cosmetic add-on produced by a second LLM call that runs *after* the
 * answer is already complete. That call reaches a provider of its own, so an outage there — or a
 * malformed config — used to reject the whole prediction before the answer was even persisted.
 *
 * Every failure degrades to "no follow-up prompts" instead: the caller still returns its answer.
 *
 * @returns the questions as a JSON string, or undefined when they could not be generated
 */
export const resolveFollowUpPrompts = async (
    followUpPromptsConfig: string | null | undefined,
    apiMessageContent: string,
    options: ICommonObject
): Promise<string | undefined> => {
    if (!followUpPromptsConfig) return undefined

    try {
        const parsedConfig = JSON.parse(followUpPromptsConfig)
        const followUpPrompts = await generateFollowUpPrompts(parsedConfig, apiMessageContent, options)

        if (!followUpPrompts?.questions) return undefined

        return JSON.stringify(followUpPrompts.questions)
    } catch (error) {
        logger.warn(
            `[server]: Follow-up prompts skipped for chatflow ${options.chatflowid} chat ${options.chatId}: ${getErrorMessage(error)}`
        )
        return undefined
    }
}
