/**
 * Unit tests for resilientWaitUntilFinished.
 *
 * Background: in QUEUE mode the web server awaits a BullMQ job's completion via
 * `job.waitUntilFinished(queueEvents)`. If the QueueEvents stream connection drops
 * (e.g. a Redis restart on Render), the completion event can be missed and the
 * promise hangs forever, leaving the SSE request in an infinite loading state.
 *
 * resilientWaitUntilFinished waits with a bounded poll TTL and, on timeout, inspects
 * the job's actual state so a missed event is recovered instead of hanging.
 *
 * BullMQ Job/Queue/QueueEvents need a real Redis connection, so they are faked here —
 * the assertions are on the function's own return/throw behaviour, not on the fakes.
 */
import { resilientWaitUntilFinished, JobNotFoundError } from './waitUtils'

jest.mock('../utils/logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() }
}))

const queueEvents = {} as any

const makeJob = (id: string, waitImpl: jest.Mock) => ({ id, waitUntilFinished: waitImpl })

const makeQueue = (getJobImpl: jest.Mock) => ({ getJob: getJobImpl })

describe('resilientWaitUntilFinished', () => {
    test('returns the value immediately when the completion event arrives (happy path)', async () => {
        const wait = jest.fn().mockResolvedValue({ text: 'done' })
        const getJob = jest.fn()
        const job = makeJob('1', wait)

        const result = await resilientWaitUntilFinished(makeQueue(getJob) as any, job as any, queueEvents)

        expect(result).toEqual({ text: 'done' })
        expect(wait).toHaveBeenCalledTimes(1)
        expect(getJob).not.toHaveBeenCalled() // no recovery path on happy path
    })

    test('recovers from job.returnvalue when the completion event was missed', async () => {
        const wait = jest.fn().mockRejectedValue(new Error('timed out before finishing'))
        const freshJob = { getState: jest.fn().mockResolvedValue('completed'), returnvalue: { text: 'recovered' } }
        const getJob = jest.fn().mockResolvedValue(freshJob)
        const job = makeJob('2', wait)

        const result = await resilientWaitUntilFinished(makeQueue(getJob) as any, job as any, queueEvents)

        expect(result).toEqual({ text: 'recovered' })
    })

    test('recovers when BullMQ stalls before its own TTL starts', async () => {
        const wait = jest.fn().mockReturnValue(new Promise(() => undefined))
        const freshJob = { getState: jest.fn().mockResolvedValue('completed'), returnvalue: { text: 'outer-timeout-recovery' } }
        const getJob = jest.fn().mockResolvedValue(freshJob)
        const job = makeJob('2b', wait)

        const result = await resilientWaitUntilFinished(makeQueue(getJob) as any, job as any, queueEvents, {
            pollTtlMs: 10,
            maxTotalMs: 100,
            stateReadTtlMs: 10
        })

        expect(result).toEqual({ text: 'outer-timeout-recovery' })
        expect(getJob).toHaveBeenCalledTimes(1)
    })

    test('throws the failure reason when the job actually failed', async () => {
        const wait = jest.fn().mockRejectedValue(new Error('timed out before finishing'))
        const freshJob = { getState: jest.fn().mockResolvedValue('failed'), failedReason: 'boom' }
        const getJob = jest.fn().mockResolvedValue(freshJob)
        const job = makeJob('3', wait)

        await expect(resilientWaitUntilFinished(makeQueue(getJob) as any, job as any, queueEvents)).rejects.toThrow('boom')
    })

    test('keeps waiting while the job is still active, then returns when it completes', async () => {
        const wait = jest.fn().mockRejectedValueOnce(new Error('timed out before finishing')).mockResolvedValueOnce({ text: 'eventually' })
        const freshJob = { getState: jest.fn().mockResolvedValue('active') }
        const getJob = jest.fn().mockResolvedValue(freshJob)
        const job = makeJob('4', wait)

        const result = await resilientWaitUntilFinished(makeQueue(getJob) as any, job as any, queueEvents)

        expect(result).toEqual({ text: 'eventually' })
        expect(wait).toHaveBeenCalledTimes(2) // it did NOT give up while active
    })

    test('throws JobNotFoundError when the job is gone from the queue', async () => {
        const wait = jest.fn().mockRejectedValue(new Error('timed out before finishing'))
        const getJob = jest.fn().mockResolvedValue(null)
        const job = makeJob('5', wait)

        await expect(resilientWaitUntilFinished(makeQueue(getJob) as any, job as any, queueEvents)).rejects.toBeInstanceOf(JobNotFoundError)
    })

    test('retries a transient Redis lookup error instead of treating the job as missing', async () => {
        const wait = jest.fn().mockRejectedValue(new Error('timed out before finishing'))
        const freshJob = { getState: jest.fn().mockResolvedValue('completed'), returnvalue: { text: 'after-reconnect' } }
        const getJob = jest.fn().mockRejectedValueOnce(new Error('Redis reconnecting')).mockResolvedValueOnce(freshJob)
        const job = makeJob('5b', wait)

        const result = await resilientWaitUntilFinished(makeQueue(getJob) as any, job as any, queueEvents, {
            pollTtlMs: 10,
            maxTotalMs: 100,
            stateReadTtlMs: 10,
            retryDelayMs: 1
        })

        expect(result).toEqual({ text: 'after-reconnect' })
        expect(getJob).toHaveBeenCalledTimes(2)
    })

    test('bounds a Redis state read that never settles', async () => {
        const wait = jest.fn().mockRejectedValue(new Error('timed out before finishing'))
        const freshJob = { getState: jest.fn().mockReturnValue(new Promise(() => undefined)) }
        const getJob = jest.fn().mockResolvedValue(freshJob)
        const job = makeJob('5c', wait)

        await expect(
            resilientWaitUntilFinished(makeQueue(getJob) as any, job as any, queueEvents, {
                pollTtlMs: 5,
                maxTotalMs: 30,
                stateReadTtlMs: 5,
                retryDelayMs: 1
            })
        ).rejects.toThrow(/max wait/i)
    })

    test('gives up with an error once the max total wait is exceeded while still running', async () => {
        const wait = jest.fn().mockRejectedValue(new Error('timed out before finishing'))
        const freshJob = { getState: jest.fn().mockResolvedValue('active') }
        const getJob = jest.fn().mockResolvedValue(freshJob)
        const job = makeJob('6', wait)
        const nowFn = jest.fn().mockReturnValueOnce(0).mockReturnValue(1000)

        await expect(
            resilientWaitUntilFinished(makeQueue(getJob) as any, job as any, queueEvents, {
                maxTotalMs: 1000,
                nowFn
            })
        ).rejects.toThrow(/max wait/i)
    })
})
