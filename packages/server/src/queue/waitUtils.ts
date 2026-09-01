import logger from '../utils/logger'

/**
 * Thrown when a job can no longer be found in the queue (e.g. it was removed by
 * `removeOnComplete` age/count limits before we could recover its result). Callers
 * may catch this to fall back to another source of truth (e.g. the persisted DB row).
 */
export class JobNotFoundError extends Error {
    constructor(public readonly jobId: string) {
        super(`Job ${jobId} not found in queue`)
        this.name = 'JobNotFoundError'
    }
}

export interface ResilientWaitOptions {
    /** Per-attempt wait before re-checking the job's actual state. Defaults to env or 30s. */
    pollTtlMs?: number
    /** Hard cap on total wait for a still-running job before giving up. Defaults to env or 25min. */
    maxTotalMs?: number
    /** Maximum time for an individual Redis state read. Defaults to env or 5s. */
    stateReadTtlMs?: number
    /** Backoff after a transient Redis state-read failure. Defaults to 250ms. */
    retryDelayMs?: number
    /** Injectable clock for testing. */
    nowFn?: () => number
    /** Optional label for log lines. */
    label?: string
}

const positiveIntegerFromEnv = (name: string, fallback: number): number => {
    const parsed = parseInt(process.env[name] || '', 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

// In-code defaults so the behaviour works with NO new environment variables.
// Optional env overrides are read only if present.
const DEFAULT_POLL_TTL_MS = positiveIntegerFromEnv('QUEUE_WAIT_POLL_TTL_MS', 30_000)
// 25 min: comfortably below the default REMOVE_ON_AGE window so the job (and its
// returnvalue) is still present when we recover, yet bounded so we never hang forever.
const DEFAULT_MAX_TOTAL_MS = positiveIntegerFromEnv('QUEUE_WAIT_MAX_TOTAL_MS', 1_500_000)
const DEFAULT_STATE_READ_TTL_MS = positiveIntegerFromEnv('QUEUE_WAIT_STATE_READ_TTL_MS', 5_000)
const DEFAULT_RETRY_DELAY_MS = 250

// States that mean the job is still in flight — keep waiting, exactly as the original
// `waitUntilFinished` would have.
const IN_FLIGHT_STATES = new Set(['active', 'waiting', 'waiting-children', 'delayed', 'prioritized', 'paused'])

interface MinimalJob {
    id?: string
    waitUntilFinished: (queueEvents: any, ttl?: number) => Promise<any>
}

interface MinimalQueue {
    getJob: (id: string) => Promise<any>
}

class WaitOperationTimeoutError extends Error {
    constructor(operation: string, timeoutMs: number) {
        super(`${operation} timed out after ${timeoutMs}ms`)
        this.name = 'WaitOperationTimeoutError'
    }
}

/**
 * Bound a single async operation and consume a late settlement from the original
 * promise. BullMQ starts its own wait TTL only after `queue.waitUntilReady()`, so
 * an outer timer is required to cover Redis reconnect stalls before that point.
 */
const waitWithTimeout = <T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
            settled = true
            reject(new WaitOperationTimeoutError(operation, timeoutMs))
        }, timeoutMs)

        promise.then(
            (value) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                resolve(value)
            },
            (error) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                reject(error)
            }
        )
    })

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wait for a BullMQ job to finish, resilient to missed completion events.
 *
 * On the happy path this resolves the moment the completion event arrives (identical to
 * `job.waitUntilFinished`). If the event is missed (e.g. the QueueEvents Redis connection
 * dropped during a restart), the per-attempt TTL expires and we inspect the job's real
 * state instead of hanging:
 *   - completed  → recover the stored return value
 *   - failed     → throw the failure reason (same as the original behaviour)
 *   - in-flight  → keep waiting (up to maxTotalMs)
 *   - gone       → throw JobNotFoundError so the caller can fall back to the DB
 */
export async function resilientWaitUntilFinished(
    queue: MinimalQueue,
    job: MinimalJob,
    queueEvents: any,
    options: ResilientWaitOptions = {}
): Promise<any> {
    const pollTtl = options.pollTtlMs ?? DEFAULT_POLL_TTL_MS
    const maxTotal = options.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS
    const stateReadTtl = options.stateReadTtlMs ?? DEFAULT_STATE_READ_TTL_MS
    const retryDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    const now = options.nowFn ?? Date.now
    const label = options.label ?? `job ${job.id}`
    const startedAt = now()
    const deadline = startedAt + maxTotal

    const remainingMs = () => deadline - now()
    const maxWaitError = (state: string) => new Error(`[resilientWait] ${label}: exceeded max wait (${maxTotal}ms) while state=${state}`)

    logger.debug(`[resilientWait] ${label}: started (poll=${pollTtl}ms, stateRead=${stateReadTtl}ms, maxTotal=${maxTotal}ms)`)

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const remainingBeforeWait = remainingMs()
        if (remainingBeforeWait <= 0) throw maxWaitError('unknown')

        const attemptTtl = Math.min(pollTtl, remainingBeforeWait)
        let waitError: unknown
        try {
            const result = await waitWithTimeout(
                job.waitUntilFinished(queueEvents, attemptTtl),
                attemptTtl,
                `${label} completion event wait`
            )
            logger.debug(`[resilientWait] ${label}: completed after ${now() - startedAt}ms`)
            return result
        } catch (err) {
            waitError = err
        }

        // The rejection is either a TTL timeout, a Redis reconnect stall bounded by
        // our outer timer, or a real job failure. Disambiguate using the job's stored
        // state. A Redis read error is not the same as a missing job, so retry it.
        const remainingBeforeLookup = remainingMs()
        if (remainingBeforeLookup <= 0) throw maxWaitError('unknown')

        let fresh: any
        try {
            fresh = await waitWithTimeout(
                queue.getJob(job.id as string),
                Math.min(stateReadTtl, remainingBeforeLookup),
                `${label} job lookup`
            )
        } catch (stateReadError) {
            logger.warn(
                `[resilientWait] ${label}: job lookup unavailable; retrying (${
                    stateReadError instanceof Error ? stateReadError.message : String(stateReadError)
                })`
            )
            const remainingBeforeRetry = remainingMs()
            if (remainingBeforeRetry <= 0) throw maxWaitError('unknown')
            await delay(Math.min(retryDelay, remainingBeforeRetry))
            continue
        }

        if (!fresh) throw new JobNotFoundError(job.id as string)

        const remainingBeforeState = remainingMs()
        if (remainingBeforeState <= 0) throw maxWaitError('unknown')

        let state: string
        try {
            state = await waitWithTimeout(fresh.getState(), Math.min(stateReadTtl, remainingBeforeState), `${label} job state read`)
        } catch (stateReadError) {
            logger.warn(
                `[resilientWait] ${label}: job state unavailable; retrying (${
                    stateReadError instanceof Error ? stateReadError.message : String(stateReadError)
                })`
            )
            const remainingBeforeRetry = remainingMs()
            if (remainingBeforeRetry <= 0) throw maxWaitError('unknown')
            await delay(Math.min(retryDelay, remainingBeforeRetry))
            continue
        }

        if (state === 'completed') {
            logger.warn(`[resilientWait] ${label}: completion event missed; recovered from job.returnvalue`)
            return fresh.returnvalue
        }
        if (state === 'failed') {
            throw new Error(fresh.failedReason || (waitError instanceof Error ? waitError.message : 'Job failed'))
        }
        if (!IN_FLIGHT_STATES.has(state)) {
            // 'unknown' or any unexpected terminal-without-result state.
            throw new JobNotFoundError(job.id as string)
        }

        if (remainingMs() <= 0) throw maxWaitError(state)
        logger.debug(`[resilientWait] ${label}: still ${state}, re-waiting (poll ${pollTtl}ms)`)
    }
}
