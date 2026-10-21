// Limits that keep a public deployment from being filled up or overloaded. Shared by the Node relay and the Worker.
// The per-network project quota can be changed without a code change: MAX_PROJECTS_PER_IP in wrangler.jsonc ("vars").
export const LIMITS = {
	maxDiagramsPerProject: 40,    // diagrams shown as tabs
	maxDeletedPerProject: 100,    // deleted diagrams are kept (restorable) until deleted permanently; this bounds that pile
	maxElementsPerDiagram: 1500,
	maxRecordsPerDiagram: 10000,  // elements plus remembered deletions
	maxMessageBytes: 1024 * 1024, // one websocket message
	maxPeersPerDiagram: 30,
	maxViewersPerProject: 100,
	maxProjectsPerIp: 5,          // new projects per network (IP address) ...
	quotaDays: 30,                // ... in this many days
	maxLookupIds: 100,
};

/**
 * A rolling quota: stamps are the times of earlier uses. Returns {ok, stamps, retryAt}: with ok the new use is
 * recorded in stamps, without it retryAt is when the oldest use in the window expires.
 */
export function takeQuota(stamps, now, limit, windowMs) {
	const recent = stamps.filter((t) => now - t < windowMs);
	if (recent.length >= limit) return { ok: false, stamps: recent, retryAt: Math.min(...recent) + windowMs };
	return { ok: true, stamps: recent.concat([now]), retryAt: null };
}

/* the network a visitor is on: an IPv4 address, or the /64 of an IPv6 address (one household has a whole /64) */
export function networkOf(ip) {
	if (!ip.includes(':')) return ip;
	const groups = ip.split('::')[0].split(':');
	return groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':');
}
