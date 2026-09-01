import logger from '../utils/logger'

interface SseClientRegistry {
    removeClient: (transportKey: string) => void
}

interface RedisSubscriptionCleanup {
    unsubscribe: (transportKey: string) => Promise<void>
}

interface FinalizeSseResponseOptions {
    transportKey: string
    sseStreamer: SseClientRegistry
    redisSubscriber?: RedisSubscriptionCleanup
}

/**
 * Complete the public SSE contract synchronously (metadata/error has already been
 * written by the caller, followed by the existing end/[DONE] frame here). Redis
 * subscription cleanup is deliberately best-effort afterwards so a reconnecting
 * cleanup client cannot hold the HTTP response open.
 */
export const finalizeSseResponse = ({ transportKey, sseStreamer, redisSubscriber }: FinalizeSseResponseOptions): void => {
    sseStreamer.removeClient(transportKey)

    if (!redisSubscriber) return

    try {
        void redisSubscriber.unsubscribe(transportKey).catch((error) => {
            logger.warn(`[finalizeSseResponse] Redis unsubscribe failed for ${transportKey}: ${error}`)
        })
    } catch (error) {
        logger.warn(`[finalizeSseResponse] Redis unsubscribe failed for ${transportKey}: ${error}`)
    }
}
