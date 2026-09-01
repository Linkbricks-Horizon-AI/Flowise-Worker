import { updatePredictionsUsage, updatePredictionsUsageWithTimeout } from './quotaUsage'

const PREDICTIONS_LIMIT = 'quota:predictions'

jest.mock('./constants', () => ({
    LICENSE_QUOTAS: {
        PREDICTIONS_LIMIT: 'quota:predictions',
        STORAGE_LIMIT: 'quota:storage',
        FLOWS_LIMIT: 'quota:flows',
        USERS_LIMIT: 'quota:users',
        ADDITIONAL_SEATS_LIMIT: 'quota:additionalSeats'
    }
}))

jest.mock('../UsageCacheManager', () => ({ UsageCacheManager: class UsageCacheManager {} }))

jest.mock('./logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() }
}))

const makeUsageCache = () => ({
    getQuotas: jest.fn(),
    get: jest.fn(),
    getTTL: jest.fn(),
    getSubscriptionDetails: jest.fn(),
    set: jest.fn()
})

describe('prediction usage response finalization', () => {
    test('does not access Redis for an organization without a subscription', async () => {
        const usageCache = makeUsageCache()

        await updatePredictionsUsage('org-1', '', 'workspace-1', usageCache as any)

        expect(usageCache.getQuotas).not.toHaveBeenCalled()
        expect(usageCache.get).not.toHaveBeenCalled()
    })

    test('does not maintain a prediction counter when the configured quota is unlimited', async () => {
        const usageCache = makeUsageCache()
        usageCache.getQuotas.mockResolvedValue({ [PREDICTIONS_LIMIT]: -1 })

        await updatePredictionsUsage('org-1', 'subscription-1', 'workspace-1', usageCache as any)

        expect(usageCache.getQuotas).toHaveBeenCalledWith('subscription-1')
        expect(usageCache.get).not.toHaveBeenCalled()
        expect(usageCache.set).not.toHaveBeenCalled()
    })

    test('keeps the healthy-path update synchronous', async () => {
        const usageCache = makeUsageCache()
        usageCache.getQuotas.mockResolvedValue({ [PREDICTIONS_LIMIT]: 100 })
        usageCache.get.mockResolvedValue(4)
        usageCache.getTTL.mockResolvedValue(Date.now() + 60_000)

        await updatePredictionsUsageWithTimeout('org-1', 'subscription-1', 'workspace-1', usageCache as any, {
            timeoutMs: 100
        })

        expect(usageCache.set).toHaveBeenCalledWith('predictions:org-1', 5, expect.any(Number))
    })

    test('allows response finalization when the same usage update remains pending', async () => {
        const usageCache = makeUsageCache()
        usageCache.getQuotas.mockReturnValue(new Promise(() => undefined))

        await expect(
            updatePredictionsUsageWithTimeout('org-1', 'subscription-1', 'workspace-1', usageCache as any, {
                timeoutMs: 10,
                label: 'test-prediction'
            })
        ).resolves.toBeUndefined()

        expect(usageCache.getQuotas).toHaveBeenCalledTimes(1)
    })

    test('preserves an immediate usage update failure', async () => {
        const usageCache = makeUsageCache()
        usageCache.getQuotas.mockRejectedValue(new Error('quota lookup failed'))

        await expect(
            updatePredictionsUsageWithTimeout('org-1', 'subscription-1', 'workspace-1', usageCache as any, {
                timeoutMs: 100
            })
        ).rejects.toThrow('quota lookup failed')
    })
})
