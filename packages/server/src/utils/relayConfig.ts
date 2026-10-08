import { v4 as uuidv4 } from 'uuid'
import { MODE } from '../Interface'

/**
 * Relay-scoped streaming transport (per-execution channel/SSE-slot/abort isolation).
 *
 * When ON, each streaming prediction request gets a fresh relayExecutionId (uuid) used ONLY for the
 * transport layer — the Redis pub/sub channel, the SSE client slot, and the abort key. The semantic
 * chatId (client-facing metadata, $flow.chatId, file paths, message persistence, observability
 * sessions) is never changed. This removes the cross-execution collision where concurrent or
 * overlapping calls of the same conversation share one channel/slot/abort id and stomp each other.
 *
 * QUEUE-mode only. In non-QUEUE (single-process) mode, executeFlow writes stream events straight to
 * the raw SSEStreamer keyed by the semantic chatId, so a controller that registered its SSE slot under
 * a relay id would never receive those events (tokens/tools/auto-TTS lost). Relay isolation only makes
 * sense on the worker→web pub/sub hop, which exists solely in QUEUE mode. Production runs QUEUE; the
 * gate below makes local/single-process runs behave exactly as before regardless of the env flag.
 *
 * The WORKER side is always data-driven and backward compatible (it relay-scopes only when the job
 * carries a relayExecutionId), so it is safe to deploy first with no behavior change. Only the WEB
 * side reads this flag, so flipping it is an atomic rollout switch and rollback is flag-off — no
 * redeploy.
 *
 * Deploy order is mandatory: (1) worker (new code), (2) web (new code, flag off), (3) flip flag on.
 * Worker-first is required because a new web with the flag on subscribes only to the relay channel,
 * while an OLD worker publishes on the chatId channel — the subscriber's chatId fallback cannot help
 * because the channel was never subscribed. The flag flip restarts web, dropping in-flight SSE
 * connections (vora reconnects), so no stale chatId-channel jobs straddle the switch. Rollback =
 * flag off + restart.
 */
export function isRelayExecutionChannelEnabled(): boolean {
    return process.env.RELAY_EXECUTION_CHANNEL === 'on' && process.env.MODE === MODE.QUEUE
}

/**
 * Resolve the transport key for a streaming request: a fresh relayExecutionId when the feature is on,
 * otherwise the semantic chatId (legacy behavior — channel/slot/abort all keyed by chatId).
 * Returns both so callers can thread the relayExecutionId into the job (undefined when off).
 */
export function resolveTransportKey(chatId: string): { transportKey: string; relayExecutionId?: string } {
    if (isRelayExecutionChannelEnabled()) {
        const relayExecutionId = uuidv4()
        return { transportKey: relayExecutionId, relayExecutionId }
    }
    return { transportKey: chatId }
}
