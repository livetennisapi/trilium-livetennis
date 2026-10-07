"use strict";

const ENDPOINT = "https://api.livetennisapi.com/api/public/v1/matches?status=live&limit=200";
const FLOOR_SECONDS = 900;
const MAX_SECONDS = 604800;
const CONFIG_LABEL = "liveTennisConfig";
const CACHE_LABEL = "liveTennisSharedCache";

function intervalSeconds(value) {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.min(MAX_SECONDS, Math.max(FLOOR_SECONDS, Math.ceil(value))) : FLOOR_SECONDS;
}

function retryAfterDeadline(value, now) {
    if (typeof value !== "string" || value.length > 128) return null;
    const header = value.trim();
    let delay;
    if (/^\d+$/.test(header)) {
        delay = Number(header) * 1000;
    } else if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header)) {
        delay = Date.parse(header) - now;
    }
    return Number.isFinite(delay) && delay >= 0
        ? now + Math.min(MAX_SECONDS * 1000, Math.ceil(delay)) : null;
}

function text(value, fallback, secret = "") {
    if (typeof value !== "string") return fallback;
    const safe = secret ? value.split(secret).join("[redacted]") : value;
    return safe.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160) || fallback;
}

function count(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeResponse(payload, secret = "") {
    if (!payload || !Array.isArray(payload.data)) throw new Error("Invalid match response");
    const matches = payload.data.slice(0, 200).filter(row => row && typeof row === "object")
        .filter(row => row.status === "live").map(row => {
            const score = row.score && typeof row.score === "object" ? row.score : null;
            const games = score && Array.isArray(score.games) && score.games.length === 2
                && score.games.every(side => Array.isArray(side))
                ? score.games.map(side => side.slice(0, 5).map(count)) : null;
            return {
                id: count(row.id),
                tournament: text(row.tournament, "Tournament unavailable", secret),
                players: [text(row.players?.p1?.name, "Player unavailable", secret),
                    text(row.players?.p2?.name, "Player unavailable", secret)],
                score: score ? {
                    games,
                    sets: Array.isArray(score.sets) ? [count(score.sets[0]), count(score.sets[1])] : null,
                    points: Array.isArray(score.points) ? [0, 1].map(i =>
                        typeof score.points[i] === "string" ? text(score.points[i], null, secret) : null) : null,
                    server: score.server === 1 || score.server === 2 ? score.server : null,
                    isTiebreak: score.is_tiebreak === true,
                    stale: score.stale === true
                } : null
            };
        });
    const total = count(payload.meta?.total);
    return { matches, total, truncated: payload.meta?.has_more === true
        || total !== null && total > payload.data.length || payload.data.length > 200 };
}

function formatMatch(match) {
    if (!match.score) return "Score unavailable";
    const score = match.score;
    const games = score.games;
    const length = games ? Math.max(games[0].length, games[1].length) : 0;
    const sets = length ? Array.from({ length }, (_, i) => {
        const pair = `${games[0][i] ?? "?"}-${games[1][i] ?? "?"}`;
        return score.isTiebreak && i >= 2 && i === length - 1
            && Math.max(games[0][i] ?? 0, games[1][i] ?? 0) > 7 ? `[${pair} match tiebreak]` : pair;
    }).join("  ") : "Sets unavailable";
    const points = score.points ? score.points.map(value => value ?? "?").join("-") : "?-?";
    return `${sets} | ${score.isTiebreak ? "Tiebreak" : "Points"} ${points}`;
}

function emptyState() {
    return { version: 1, lastAttempt: null, lastSuccess: null, nextAllowedAt: 0,
        snapshot: null, error: null, pending: false, reservation: 0 };
}

function readState(note) {
    const state = JSON.parse(note.getContent());
    if (state.version !== 1 || !Number.isSafeInteger(state.nextAllowedAt) || state.nextAllowedAt < 0
        || !Number.isSafeInteger(state.reservation) || state.reservation < 0
        || (state.lastAttempt !== null && count(state.lastAttempt) === null)
        || (state.lastSuccess !== null && count(state.lastSuccess) === null)
        || (state.snapshot !== null && !Array.isArray(state.snapshot?.matches))) {
        throw new Error("Invalid stored state");
    }
    return state;
}

function publicSnapshot(state, interval, now) {
    const snapshot = state.snapshot || { matches: [], total: null, truncated: false };
    return {
        status: state.pending ? "waiting" : state.error || state.lastSuccess !== null
            && now - state.lastSuccess >= interval * 1000 ? "stale" : "ready",
        matches: snapshot.matches, total: snapshot.total, truncated: snapshot.truncated,
        lastAttempt: state.lastAttempt, lastSuccess: state.lastSuccess,
        nextAttempt: Math.max(state.nextAllowedAt, state.lastAttempt === null ? now : state.lastAttempt + interval * 1000),
        intervalSeconds: interval, error: state.error || null
    };
}

function setup(message) {
    return { status: "setup", matches: [], total: null, truncated: false,
        lastAttempt: null, lastSuccess: null, nextAttempt: null, intervalSeconds: FLOOR_SECONDS, error: message };
}

function createService(host, transport = (...args) => fetch(...args), clock = () => Date.now()) {
    return {
        async refresh() {
            let reservation;
            try {
                // 100 requests per day allows a shared floor of 900 seconds: at most 96 daily attempts.
                reservation = host.transactional(() => {
                    const configs = host.getNotesWithLabel(CONFIG_LABEL, "v1");
                    if (configs.length !== 1) return { result: setup("Keep exactly one settings note with #liveTennisConfig=v1.") };
                    const config = JSON.parse(configs[0].getContent());
                    const key = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
                    if (!key) return { result: setup("Add your free account key to the Live Tennis settings note.") };
                    if (/[\r\n]/.test(key)) return { result: setup("The API key contains a line break. Replace it in settings.") };
                    const interval = intervalSeconds(config.intervalSeconds);
                    const caches = host.getNotesWithLabel(CACHE_LABEL, "v1");
                    if (caches.length > 1) return { result: setup("More than one shared cache note exists. Keep the original cache and remove duplicates.") };
                    let note = caches[0];
                    if (!note) {
                        note = host.createDataNote(configs[0].noteId, "Live Tennis shared cache", emptyState()).note;
                        note.setLabel(CACHE_LABEL, "v1");
                    }
                    const state = readState(note);
                    const now = Math.floor(clock());
                    const next = Math.max(state.nextAllowedAt, state.lastAttempt === null ? 0 : state.lastAttempt + interval * 1000);
                    if (now < next) return { result: publicSnapshot(state, interval, now) };
                    state.lastAttempt = now;
                    state.nextAllowedAt = now + interval * 1000;
                    state.pending = true;
                    state.reservation += 1;
                    note.setContent(JSON.stringify(state));
                    return { note, token: state.reservation, key, interval };
                });
            } catch {
                return setup("Settings or stored cache cannot be read. Repair the JSON without resetting the attempt timestamps.");
            }
            if (reservation.result) return reservation.result;

            let snapshot = null;
            let failure = null;
            let retryAt = null;
            try {
                const response = await transport(ENDPOINT, {
                    headers: { "X-API-Key": reservation.key, Accept: "application/json" },
                    signal: AbortSignal.timeout(10000), redirect: "error"
                });
                if (!response.ok) {
                    retryAt = retryAfterDeadline(response.headers?.get?.("Retry-After"), Math.floor(clock()));
                    failure = response.status === 401 || response.status === 403
                        ? "The API rejected the key. Check the key in settings."
                        : response.status === 429 ? "The API request limit was reached. The next attempt will wait."
                            : "The API request failed. The last snapshot is retained.";
                } else {
                    snapshot = normalizeResponse(await response.json(), reservation.key);
                }
            } catch {
                failure = "The request or response could not be read. The last snapshot is retained.";
            }
            try {
                return host.transactional(() => {
                    const state = readState(reservation.note);
                    if (state.reservation === reservation.token) {
                        state.pending = false;
                        state.error = failure;
                        if (retryAt !== null) state.nextAllowedAt = Math.max(state.nextAllowedAt, retryAt);
                        if (snapshot) {
                            state.snapshot = snapshot;
                            state.lastSuccess = Math.floor(clock());
                        }
                        reservation.note.setContent(JSON.stringify(state));
                    }
                    return publicSnapshot(state, reservation.interval, Math.floor(clock()));
                });
            } catch {
                return setup("The snapshot could not be saved. The reserved attempt still counts toward the request limit.");
            }
        }
    };
}

module.exports = { createService, normalizeResponse, formatMatch, intervalSeconds, retryAfterDeadline };
if (typeof api !== "undefined") module.exports.refresh = () => createService(api).refresh();
