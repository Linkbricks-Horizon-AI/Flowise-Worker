import { NextFunction, Request, Response } from 'express'
import { rateLimit, RateLimitRequestHandler } from 'express-rate-limit'
import { IChatFlow, MODE } from '../Interface'
import { Mutex } from 'async-mutex'
import { RedisStore } from 'rate-limit-redis'
import Redis from 'ioredis'
import { QueueEvents, QueueEventsListener, QueueEventsProducer } from 'bullmq'

/**
 * Build the rate-limit counter key for a request.
 * Mirrors getMemorySessionId() external-API precedence so that "per session"
 * limiting matches the conversation unit the engine actually uses.
 * Falls back to client IP when no session identifier is present.
 */
export const getRateLimiterKey = (req: Request): string => {
    const overrideSessionId = req.body?.overrideConfig?.sessionId
    if (typeof overrideSessionId === 'string' && overrideSessionId.length > 0) return overrideSessionId

    const chatId = req.body?.chatId
    if (typeof chatId === 'string' && chatId.length > 0) return chatId

    return req.ip || req.socket?.remoteAddress || 'unknown'
}

interface CustomListener extends QueueEventsListener {
    // NOTE: BullMQ serializes event payloads to strings over Redis streams,
    // so bySessionId may arrive as a string at runtime; normalize on receive.
    updateRateLimiter: (args: {
        limitDuration: number
        limitMax: number
        limitMsg: string
        id: string
        bySessionId?: boolean
    }) => void
}

const QUEUE_NAME = 'ratelimit'
const QUEUE_EVENT_NAME = 'updateRateLimiter'

export class RateLimiterManager {
    private rateLimiters: Map<string, RateLimitRequestHandler> = new Map()
    private rateLimiterMutex: Mutex = new Mutex()
    private redisClient: Redis
    private static instance: RateLimiterManager
    private queueEventsProducer: QueueEventsProducer
    private queueEvents: QueueEvents

    constructor() {
        if (process.env.MODE === MODE.QUEUE) {
            if (process.env.REDIS_URL) {
                this.redisClient = new Redis(process.env.REDIS_URL, {
                    keepAlive:
                        process.env.REDIS_KEEP_ALIVE && !isNaN(parseInt(process.env.REDIS_KEEP_ALIVE, 10))
                            ? parseInt(process.env.REDIS_KEEP_ALIVE, 10)
                            : undefined
                })
            } else {
                this.redisClient = new Redis({
                    host: process.env.REDIS_HOST || 'localhost',
                    port: parseInt(process.env.REDIS_PORT || '6379'),
                    username: process.env.REDIS_USERNAME || undefined,
                    password: process.env.REDIS_PASSWORD || undefined,
                    tls:
                        process.env.REDIS_TLS === 'true'
                            ? {
                                  cert: process.env.REDIS_CERT ? Buffer.from(process.env.REDIS_CERT, 'base64') : undefined,
                                  key: process.env.REDIS_KEY ? Buffer.from(process.env.REDIS_KEY, 'base64') : undefined,
                                  ca: process.env.REDIS_CA ? Buffer.from(process.env.REDIS_CA, 'base64') : undefined
                              }
                            : undefined,
                    keepAlive:
                        process.env.REDIS_KEEP_ALIVE && !isNaN(parseInt(process.env.REDIS_KEEP_ALIVE, 10))
                            ? parseInt(process.env.REDIS_KEEP_ALIVE, 10)
                            : undefined
                })
            }
            this.queueEventsProducer = new QueueEventsProducer(QUEUE_NAME, { connection: this.getConnection() })
            this.queueEvents = new QueueEvents(QUEUE_NAME, { connection: this.getConnection() })
        }
    }

    getConnection() {
        let tlsOpts = undefined
        if (process.env.REDIS_URL && process.env.REDIS_URL.startsWith('rediss://')) {
            tlsOpts = {
                rejectUnauthorized: false
            }
        } else if (process.env.REDIS_TLS === 'true') {
            tlsOpts = {
                cert: process.env.REDIS_CERT ? Buffer.from(process.env.REDIS_CERT, 'base64') : undefined,
                key: process.env.REDIS_KEY ? Buffer.from(process.env.REDIS_KEY, 'base64') : undefined,
                ca: process.env.REDIS_CA ? Buffer.from(process.env.REDIS_CA, 'base64') : undefined
            }
        }
        return {
            url: process.env.REDIS_URL || undefined,
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT || '6379'),
            username: process.env.REDIS_USERNAME || undefined,
            password: process.env.REDIS_PASSWORD || undefined,
            tls: tlsOpts,
            maxRetriesPerRequest: null,
            enableReadyCheck: true,
            keepAlive:
                process.env.REDIS_KEEP_ALIVE && !isNaN(parseInt(process.env.REDIS_KEEP_ALIVE, 10))
                    ? parseInt(process.env.REDIS_KEEP_ALIVE, 10)
                    : undefined
        }
    }

    public static getInstance(): RateLimiterManager {
        if (!RateLimiterManager.instance) {
            RateLimiterManager.instance = new RateLimiterManager()
        }
        return RateLimiterManager.instance
    }

    public async addRateLimiter(id: string, duration: number, limit: number, message: string, bySessionId = false): Promise<void> {
        const release = await this.rateLimiterMutex.acquire()
        try {
            const keyGeneratorOpt = bySessionId ? { keyGenerator: getRateLimiterKey } : {}
            if (process.env.MODE === MODE.QUEUE) {
                this.rateLimiters.set(
                    id,
                    rateLimit({
                        windowMs: duration * 1000,
                        max: limit,
                        standardHeaders: true,
                        legacyHeaders: false,
                        message,
                        ...keyGeneratorOpt,
                        store: new RedisStore({
                            prefix: `rl:${id}`,
                            // @ts-expect-error - Known issue: the `call` function is not present in @types/ioredis
                            sendCommand: (...args: string[]) => this.redisClient.call(...args)
                        })
                    })
                )
            } else {
                this.rateLimiters.set(
                    id,
                    rateLimit({
                        windowMs: duration * 1000,
                        max: limit,
                        message,
                        ...keyGeneratorOpt
                    })
                )
            }
        } finally {
            release()
        }
    }

    public removeRateLimiter(id: string): void {
        this.rateLimiters.delete(id)
    }

    public getRateLimiter(): (req: Request, res: Response, next: NextFunction) => void {
        return (req: Request, res: Response, next: NextFunction) => {
            const id = req.params.id
            if (typeof id === 'string' && id.length > 0 && this.rateLimiters.has(id)) {
                return this.rateLimiters.get(id)!(req, res, next)
            }
            return next()
        }
    }

    public getRateLimiterById(id: string): (req: Request, res: Response, next: NextFunction) => void {
        return (req: Request, res: Response, next: NextFunction) => {
            if (this.rateLimiters.has(id)) {
                return this.rateLimiters.get(id)!(req, res, next)
            }
            return next()
        }
    }

    public async updateRateLimiter(chatFlow: IChatFlow, isInitialized?: boolean): Promise<void> {
        if (!chatFlow.apiConfig) return
        const apiConfig = JSON.parse(chatFlow.apiConfig)

        const rateLimit: { limitDuration: number; limitMax: number; limitMsg: string; status?: boolean; bySessionId?: boolean } =
            apiConfig.rateLimit
        if (!rateLimit) return

        const { limitDuration, limitMax, limitMsg, status, bySessionId } = rateLimit

        if (!isInitialized && process.env.MODE === MODE.QUEUE && this.queueEventsProducer) {
            await this.queueEventsProducer.publishEvent({
                eventName: QUEUE_EVENT_NAME,
                limitDuration,
                limitMax,
                limitMsg,
                id: chatFlow.id,
                bySessionId: bySessionId ?? false
            })
        } else {
            if (status === false) {
                this.removeRateLimiter(chatFlow.id)
            } else if (limitMax && limitDuration && limitMsg) {
                await this.addRateLimiter(chatFlow.id, limitDuration, limitMax, limitMsg, bySessionId ?? false)
            }
        }
    }

    public async initializeRateLimiters(chatflows: IChatFlow[]): Promise<void> {
        await Promise.all(
            chatflows.map(async (chatFlow) => {
                await this.updateRateLimiter(chatFlow, true)
            })
        )

        if (process.env.MODE === MODE.QUEUE && this.queueEvents) {
            this.queueEvents.on<CustomListener>(
                QUEUE_EVENT_NAME,
                async ({
                    limitDuration,
                    limitMax,
                    limitMsg,
                    id,
                    bySessionId
                }: {
                    limitDuration: number
                    limitMax: number
                    limitMsg: string
                    id: string
                    bySessionId?: boolean
                }) => {
                    // BullMQ delivers payload values as strings; normalize the boolean.
                    await this.addRateLimiter(id, limitDuration, limitMax, limitMsg, String(bySessionId) === 'true')
                }
            )
        }
    }
}
