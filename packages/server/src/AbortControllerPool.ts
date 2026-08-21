/**
 * This pool is to keep track of abort controllers.
 *
 * Keys are per-execution ids (relayExecutionId, a uuid) when relay-scoping is active, or the legacy
 * `${chatflowid}_${chatId}` chat-scope id otherwise. A secondary scope index maps a chat-scope key to
 * the set of per-execution keys currently running under it, so the public abort API (which only knows
 * chatflowid+chatId) can still abort every in-flight execution of that conversation without a fragile
 * key prefix scan. See `abortAllForScope`.
 */
export class AbortControllerPool {
    abortControllers: Record<string, AbortController> = {}
    /** chat-scope key (`${chatflowid}_${chatId}`) → set of per-execution keys running under it. */
    private scopeIndex: Record<string, Set<string>> = {}
    /** per-execution id → its chat-scope key, so remove() is O(1) instead of scanning every scope. */
    private idToScopeKey: Record<string, string> = {}

    /**
     * Add to the pool.
     * @param {string} id per-execution (or legacy chat-scope) key
     * @param {AbortController} abortController
     * @param {string} [scopeKey] optional chat-scope key to index this execution under
     */
    add(id: string, abortController: AbortController, scopeKey?: string) {
        this.abortControllers[id] = abortController
        if (scopeKey) {
            if (!this.scopeIndex[scopeKey]) this.scopeIndex[scopeKey] = new Set()
            this.scopeIndex[scopeKey].add(id)
            this.idToScopeKey[id] = scopeKey
        }
    }

    /**
     * Remove from the pool. O(1): uses the reverse index to reach this id's scope set directly rather
     * than scanning every active scope (which would be O(N) per removal, O(N²) across a burst).
     * @param {string} id
     */
    remove(id: string) {
        if (Object.prototype.hasOwnProperty.call(this.abortControllers, id)) {
            delete this.abortControllers[id]
        }
        const scopeKey = this.idToScopeKey[id]
        if (scopeKey !== undefined) {
            delete this.idToScopeKey[id]
            const set = this.scopeIndex[scopeKey]
            if (set) {
                set.delete(id)
                if (set.size === 0) delete this.scopeIndex[scopeKey]
            }
        }
    }

    /**
     * Get the abort controller.
     * @param {string} id
     */
    get(id: string) {
        return this.abortControllers[id]
    }

    /**
     * Abort a single execution by its exact key.
     * @param {string} id
     */
    abort(id: string) {
        const abortController = this.abortControllers[id]
        if (abortController) {
            abortController.abort()
            this.remove(id)
        }
    }

    /**
     * Abort every execution registered under a chat-scope key. Backs the public abort API, whose
     * contract is "stop all executions of this chatflowid+chatId". Falls back to an exact-key abort
     * so a legacy chat-scope key registered directly (no relay-scoping) is still handled.
     * @param {string} scopeKey `${chatflowid}_${chatId}`
     */
    abortAllForScope(scopeKey: string) {
        const ids = this.scopeIndex[scopeKey]
        if (ids && ids.size > 0) {
            // Snapshot: abort()→remove() mutates the set during iteration.
            for (const id of Array.from(ids)) {
                this.abort(id)
            }
            return
        }
        // No relay-scoped executions indexed — treat scopeKey as an exact key (legacy path).
        this.abort(scopeKey)
    }
}
