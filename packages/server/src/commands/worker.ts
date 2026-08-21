import logger from '../utils/logger'
import { QueueManager } from '../queue/QueueManager'
import { BaseCommand } from './base'
import { getDataSource } from '../DataSource'
import { Telemetry } from '../utils/telemetry'
import { NodesPool } from '../NodesPool'
import { CachePool } from '../CachePool'
import { QueueEvents, QueueEventsListener } from 'bullmq'
import { AbortControllerPool } from '../AbortControllerPool'
import { UsageCacheManager } from '../UsageCacheManager'
import { IdentityManager } from '../IdentityManager'

interface CustomListener extends QueueEventsListener {
    abort: (args: { id: string }, id: string) => void
}

export default class Worker extends BaseCommand {
    predictionWorkerId: string
    upsertionWorkerId: string
    scheduleWorkerId: string

    async run(): Promise<void> {
        logger.info('Starting Flowise Worker...')

        const { appDataSource, telemetry, componentNodes, cachePool, abortControllerPool, usageCacheManager, identityManager } =
            await this.prepareData()

        const queueManager = QueueManager.getInstance()
        queueManager.setupAllQueues({
            componentNodes,
            telemetry,
            cachePool,
            appDataSource,
            abortControllerPool,
            usageCacheManager,
            identityManager
        })

        /** Prediction */
        const predictionQueue = queueManager.getQueue('prediction')
        const predictionWorker = predictionQueue.createWorker()
        this.predictionWorkerId = predictionWorker.id
        logger.info(`Prediction Worker ${this.predictionWorkerId} created`)

        const predictionQueueName = predictionQueue.getQueueName()
        const queueEvents = new QueueEvents(predictionQueueName, { connection: queueManager.getConnection() })

        queueEvents.on<CustomListener>('abort', async ({ id }: { id: string }) => {
            // Two id namespaces, non-overlapping: a per-execution relayExecutionId (uuid) → exact abort,
            // or a chat-scope key `${chatflowid}_${chatId}` from the public abort API → abort every
            // execution indexed under that scope. Trying both is always safe: abort(id) no-ops for a
            // scope key (nothing registered under it directly), and abortAllForScope(id) falls back to an
            // exact abort for a relay id (no scope set). Covers rolling deploys where either id shape arrives.
            abortControllerPool.abort(id)
            abortControllerPool.abortAllForScope(id)
        })

        /** Upsertion */
        const upsertionQueue = queueManager.getQueue('upsert')
        const upsertionWorker = upsertionQueue.createWorker()
        this.upsertionWorkerId = upsertionWorker.id
        logger.info(`Upsertion Worker ${this.upsertionWorkerId} created`)

        /** Schedule */
        const scheduleQueue = queueManager.getQueue('schedule')
        const scheduleWorker = scheduleQueue.createWorker()
        this.scheduleWorkerId = scheduleWorker.id
        logger.info(`Schedule Worker ${this.scheduleWorkerId} created`)

        // Keep the process running
        process.stdin.resume()
    }

    async prepareData() {
        // Init database
        const appDataSource = getDataSource()
        await appDataSource.initialize()
        await appDataSource.runMigrations({ transaction: 'each' })

        // Initialize abortcontroller pool
        const abortControllerPool = new AbortControllerPool()

        // Init telemetry
        const telemetry = new Telemetry()

        // Initialize nodes pool
        const nodesPool = new NodesPool()
        await nodesPool.initialize()

        // Initialize cache pool
        const cachePool = new CachePool()

        // Initialize usage cache manager
        const usageCacheManager = await UsageCacheManager.getInstance()

        // Initialize identity manager
        const identityManager = await IdentityManager.getInstance()

        return {
            appDataSource,
            telemetry,
            componentNodes: nodesPool.componentNodes,
            cachePool,
            abortControllerPool,
            usageCacheManager,
            identityManager
        }
    }

    async catch(error: Error) {
        if (error.stack) logger.error(error.stack)
        await new Promise((resolve) => {
            setTimeout(resolve, 1000)
        })
        await this.failExit()
    }

    async stopProcess() {
        try {
            const queueManager = QueueManager.getInstance()
            const predictionWorker = queueManager.getQueue('prediction').getWorker()
            logger.info(`Shutting down Flowise Prediction Worker ${this.predictionWorkerId}...`)
            await predictionWorker.close()

            const upsertWorker = queueManager.getQueue('upsert').getWorker()
            logger.info(`Shutting down Flowise Upsertion Worker ${this.upsertionWorkerId}...`)
            await upsertWorker.close()

            const scheduleWorker = queueManager.getQueue('schedule').getWorker()
            logger.info(`Shutting down Flowise Schedule Worker ${this.scheduleWorkerId}...`)
            await scheduleWorker.close()
        } catch (error) {
            logger.error('There was an error shutting down Flowise Worker...', error)
            await this.failExit()
        }

        await this.gracefullyExit()
    }
}
