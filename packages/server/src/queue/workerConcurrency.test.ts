import { getTotalWorkerConcurrency, getWorkerConcurrency, hasQueueSpecificConcurrency } from './workerConcurrency'

describe('workerConcurrency', () => {
    it('keeps WORKER_CONCURRENCY as the fallback for every queue', () => {
        const env = { WORKER_CONCURRENCY: '20' } as NodeJS.ProcessEnv

        expect(getWorkerConcurrency('prediction', env)).toBe(20)
        expect(getWorkerConcurrency('upsert', env)).toBe(20)
        expect(getWorkerConcurrency('schedule', env)).toBe(20)
        expect(hasQueueSpecificConcurrency(env)).toBe(false)
    })

    it('allows each queue to be bounded independently', () => {
        const env = {
            WORKER_CONCURRENCY: '20',
            PREDICTION_WORKER_CONCURRENCY: '20',
            UPSERT_WORKER_CONCURRENCY: '5',
            SCHEDULE_WORKER_CONCURRENCY: '5'
        } as NodeJS.ProcessEnv

        expect(getWorkerConcurrency('prediction', env)).toBe(20)
        expect(getWorkerConcurrency('upsert', env)).toBe(5)
        expect(getWorkerConcurrency('schedule', env)).toBe(5)
        expect(getTotalWorkerConcurrency(env)).toBe(30)
        expect(hasQueueSpecificConcurrency(env)).toBe(true)
    })

    it('ignores invalid queue-specific values and falls back safely', () => {
        const env = {
            WORKER_CONCURRENCY: '7',
            PREDICTION_WORKER_CONCURRENCY: '0',
            UPSERT_WORKER_CONCURRENCY: 'invalid'
        } as NodeJS.ProcessEnv

        expect(getWorkerConcurrency('prediction', env)).toBe(7)
        expect(getWorkerConcurrency('upsert', env)).toBe(7)
        expect(getWorkerConcurrency('schedule', env)).toBe(7)
        expect(hasQueueSpecificConcurrency(env)).toBe(false)
    })
})
