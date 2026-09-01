export type WorkerQueueType = 'prediction' | 'upsert' | 'schedule'

const DEFAULT_WORKER_CONCURRENCY = 100000

const ENV_BY_QUEUE: Record<WorkerQueueType, string> = {
    prediction: 'PREDICTION_WORKER_CONCURRENCY',
    upsert: 'UPSERT_WORKER_CONCURRENCY',
    schedule: 'SCHEDULE_WORKER_CONCURRENCY'
}

const parsePositiveInteger = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined
    const parsed = parseInt(value, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Queue-specific worker concurrency with a backwards-compatible fallback.
 * Existing deployments that only set WORKER_CONCURRENCY keep exactly the same behaviour.
 */
export const getWorkerConcurrency = (queueType: WorkerQueueType, env: NodeJS.ProcessEnv = process.env): number => {
    return parsePositiveInteger(env[ENV_BY_QUEUE[queueType]]) ?? parsePositiveInteger(env.WORKER_CONCURRENCY) ?? DEFAULT_WORKER_CONCURRENCY
}

export const hasQueueSpecificConcurrency = (env: NodeJS.ProcessEnv = process.env): boolean => {
    return Object.values(ENV_BY_QUEUE).some((name) => parsePositiveInteger(env[name]) !== undefined)
}

export const getTotalWorkerConcurrency = (env: NodeJS.ProcessEnv = process.env): number => {
    return (Object.keys(ENV_BY_QUEUE) as WorkerQueueType[]).reduce((total, queueType) => total + getWorkerConcurrency(queueType, env), 0)
}
