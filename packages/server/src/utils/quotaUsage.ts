import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../errors/internalFlowiseError'
import { UsageCacheManager } from '../UsageCacheManager'
import { LICENSE_QUOTAS } from './constants'
import logger from './logger'

type UsageType = 'flows' | 'users'
const DEFAULT_PREDICTION_USAGE_UPDATE_TIMEOUT_MS = (() => {
    const parsed = parseInt(process.env.PREDICTION_USAGE_UPDATE_TIMEOUT_MS || '', 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 5_000
})()

interface PredictionUsageUpdateOptions {
    timeoutMs?: number
    label?: string
}

export const ENTERPRISE_FEATURE_FLAGS = [
    //'feat:account', // Only for Cloud
    'feat:datasets',
    'feat:evaluations',
    'feat:evaluators',
    'feat:files',
    'feat:login-activity',
    'feat:users',
    'feat:workspaces',
    'feat:logs',
    'feat:roles',
    'feat:sso-config'
]

export const getCurrentUsage = async (orgId: string, subscriptionId: string, usageCacheManager: UsageCacheManager) => {
    try {
        if (!usageCacheManager || !subscriptionId || !orgId) return

        const currentStorageUsage = (await usageCacheManager.get(`storage:${orgId}`)) || 0
        const currentPredictionsUsage = (await usageCacheManager.get(`predictions:${orgId}`)) || 0

        const quotas = await usageCacheManager.getQuotas(subscriptionId)
        const storageLimit = quotas[LICENSE_QUOTAS.STORAGE_LIMIT]
        const predLimit = quotas[LICENSE_QUOTAS.PREDICTIONS_LIMIT]

        return {
            predictions: {
                usage: currentPredictionsUsage,
                limit: predLimit
            },
            storage: {
                usage: currentStorageUsage,
                limit: storageLimit
            }
        }
    } catch (error) {
        logger.error(`[getCurrentUsage] Error getting usage: ${error}`)
        throw error
    }
}

// For usage that doesn't renew per month, we just get the count from database and check
export const checkUsageLimit = async (
    type: UsageType,
    subscriptionId: string,
    usageCacheManager: UsageCacheManager,
    currentUsage: number
) => {
    if (!usageCacheManager || !subscriptionId) return

    const quotas = await usageCacheManager.getQuotas(subscriptionId)

    let limit = -1
    switch (type) {
        case 'flows':
            limit = quotas[LICENSE_QUOTAS.FLOWS_LIMIT]
            break
        case 'users':
            limit = quotas[LICENSE_QUOTAS.USERS_LIMIT] + (Math.max(quotas[LICENSE_QUOTAS.ADDITIONAL_SEATS_LIMIT], 0) || 0)
            break
    }

    if (limit === -1) return

    if (currentUsage > limit) {
        throw new InternalFlowiseError(StatusCodes.PAYMENT_REQUIRED, `Limit exceeded: ${type}`)
    }
}

// As predictions limit renew per month, we set to cache with 1 month TTL
export const updatePredictionsUsage = async (
    orgId: string,
    subscriptionId: string,
    _: string = '',
    usageCacheManager?: UsageCacheManager
) => {
    // Self-hosted / unlimited organizations do not have a subscription and their
    // prediction quota is never checked. Avoid a response-blocking Redis round trip
    // that cannot affect authorization or accounting for those requests.
    if (!usageCacheManager || !subscriptionId || !orgId) return

    const quotas = await usageCacheManager.getQuotas(subscriptionId)
    const predictionsLimit = quotas[LICENSE_QUOTAS.PREDICTIONS_LIMIT]
    if (predictionsLimit === -1) return

    let currentPredictions = 0
    const existingPredictions = await usageCacheManager.get(`predictions:${orgId}`)
    if (existingPredictions) {
        currentPredictions = 1 + (existingPredictions as number) > predictionsLimit ? predictionsLimit : 1 + (existingPredictions as number)
    } else {
        currentPredictions = 1
    }

    const currentTTL = await usageCacheManager.getTTL(`predictions:${orgId}`)
    if (currentTTL) {
        const currentTimestamp = Date.now()
        const timeLeft = currentTTL - currentTimestamp
        usageCacheManager.set(`predictions:${orgId}`, currentPredictions, timeLeft)
    } else {
        const subscriptionDetails = await usageCacheManager.getSubscriptionDetails(subscriptionId)
        if (subscriptionDetails && subscriptionDetails.created) {
            const MS_PER_DAY = 24 * 60 * 60 * 1000
            const DAYS = 30
            const approximateMonthMs = DAYS * MS_PER_DAY

            // Calculate time elapsed since subscription creation
            const createdTimestamp = subscriptionDetails.created * 1000 // Convert to milliseconds if timestamp is in seconds
            const currentTimestamp = Date.now()
            const timeElapsed = currentTimestamp - createdTimestamp

            // Calculate remaining time in the current month period
            const timeLeft = approximateMonthMs - (timeElapsed % approximateMonthMs)

            usageCacheManager.set(`predictions:${orgId}`, currentPredictions, timeLeft)
        } else {
            // Fallback to default 30 days if no creation date
            const MS_PER_DAY = 24 * 60 * 60 * 1000
            const DAYS = 30
            const approximateMonthMs = DAYS * MS_PER_DAY
            usageCacheManager.set(`predictions:${orgId}`, currentPredictions, approximateMonthMs)
        }
    }
}

/**
 * Keep the existing synchronous usage update on the healthy path, but do not let a
 * stalled Redis/Stripe connection hold a completed prediction response forever. On
 * timeout the same in-flight promise continues exactly once in the background; it is
 * neither cancelled nor duplicated.
 */
export const updatePredictionsUsageWithTimeout = async (
    orgId: string,
    subscriptionId: string,
    workspaceId: string = '',
    usageCacheManager?: UsageCacheManager,
    options: PredictionUsageUpdateOptions = {}
): Promise<void> => {
    if (!usageCacheManager || !subscriptionId || !orgId) return

    const timeoutMs = options.timeoutMs ?? DEFAULT_PREDICTION_USAGE_UPDATE_TIMEOUT_MS
    const label = options.label ?? 'prediction'
    const startedAt = Date.now()
    const updatePromise = updatePredictionsUsage(orgId, subscriptionId, workspaceId, usageCacheManager)

    const outcome = await new Promise<'completed' | 'timeout'>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
            settled = true
            resolve('timeout')
        }, timeoutMs)

        updatePromise.then(
            () => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                resolve('completed')
            },
            (error) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                reject(error)
            }
        )
    })

    if (outcome === 'completed') {
        logger.debug(`[updatePredictionsUsage] ${label}: completed after ${Date.now() - startedAt}ms`)
        return
    }

    logger.warn(`[updatePredictionsUsage] ${label}: still pending after ${timeoutMs}ms; allowing response finalization`)
    void updatePromise.then(
        () => logger.info(`[updatePredictionsUsage] ${label}: background update completed after ${Date.now() - startedAt}ms`),
        (error) => logger.error(`[updatePredictionsUsage] ${label}: background update failed: ${error}`)
    )
}

export const checkPredictions = async (orgId: string, subscriptionId: string, usageCacheManager: UsageCacheManager) => {
    if (!usageCacheManager || !subscriptionId) return

    const currentPredictions: number = (await usageCacheManager.get(`predictions:${orgId}`)) || 0

    const quotas = await usageCacheManager.getQuotas(subscriptionId)
    const predictionsLimit = quotas[LICENSE_QUOTAS.PREDICTIONS_LIMIT]
    if (predictionsLimit === -1) return

    if (currentPredictions >= predictionsLimit) {
        throw new InternalFlowiseError(StatusCodes.PAYMENT_REQUIRED, 'Predictions limit exceeded')
    }

    return {
        usage: currentPredictions,
        limit: predictionsLimit
    }
}

// Storage does not renew per month nor do we store the total size in database, so we just store the total size in cache
export const updateStorageUsage = (orgId: string, _: string = '', totalSize: number, usageCacheManager?: UsageCacheManager) => {
    if (!usageCacheManager) return
    usageCacheManager.set(`storage:${orgId}`, totalSize)
}

export const checkStorage = async (orgId: string, subscriptionId: string, usageCacheManager: UsageCacheManager) => {
    if (!usageCacheManager || !subscriptionId) return

    let currentStorageUsage = 0
    currentStorageUsage = (await usageCacheManager.get(`storage:${orgId}`)) || 0

    const quotas = await usageCacheManager.getQuotas(subscriptionId)
    const storageLimit = quotas[LICENSE_QUOTAS.STORAGE_LIMIT]
    if (storageLimit === -1) return

    if (currentStorageUsage >= storageLimit) {
        throw new InternalFlowiseError(StatusCodes.PAYMENT_REQUIRED, 'Storage limit exceeded')
    }

    return {
        usage: currentStorageUsage,
        limit: storageLimit
    }
}
