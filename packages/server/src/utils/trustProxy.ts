/** Resolve a bounded proxy policy before Express reads forwarded client addresses. */
export const getTrustProxy = (env: NodeJS.ProcessEnv = process.env): string | boolean | number => {
    const value = env.TRUST_PROXY?.trim() || env.NUMBER_OF_PROXIES?.trim() || '1'

    // Keep legacy deployments using true running, but trust only the nearest proxy.
    // Trusting every hop lets clients choose their rate-limit key through X-Forwarded-For.
    if (value === 'true') return 1
    if (value === 'false') return false

    const hops = Number(value)
    if (!Number.isNaN(hops)) {
        if (!Number.isSafeInteger(hops) || hops < 0) {
            throw new Error('TRUST_PROXY / NUMBER_OF_PROXIES must be a non-negative integer when specifying a proxy count')
        }
        return hops
    }

    // Express also supports explicit proxy IP addresses, CIDRs and named subnet lists.
    return value
}
