"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createService, normalizeResponse, formatMatch, intervalSeconds } = require("../src/backend");

const SECRET = "fixture-secret";
const START = 1800000000000;
const MATCH = {
    id: 7, status: "live", tournament: "Test Open",
    players: { p1: { name: "First player" }, p2: { name: "Second player" } },
    score: { games: [[6, 3], [4, 2]], sets: [1, 0], points: ["40", "15"],
        server: 2, is_tiebreak: false, stale: false }
};
const payload = (matches = [MATCH], meta = {}) => ({ data: matches, meta });
const response = data => ({ ok: true, status: 200, json: async () => data });

function fixture(config = { apiKey: SECRET, intervalSeconds: 900 }) {
    let now = START;
    let depth = 0;
    const notes = new Map();
    let serial = 1;
    function note(id, data, labels = {}) {
        return {
            noteId: id, content: JSON.stringify(data), labels: new Map(Object.entries(labels)),
            getContent() { return this.content; },
            setContent(value) { assert.equal(depth, 1); this.content = value; },
            setLabel(name, value) { assert.equal(depth, 1); this.labels.set(name, value); }
        };
    }
    notes.set("config", note("config", config, { liveTennisConfig: "v1" }));
    const host = {
        transactional(callback) {
            assert.equal(depth, 0, "transactions do not nest");
            depth = 1;
            const contents = new Map([...notes].map(([id, value]) => [id, value.content]));
            try {
                const result = callback();
                assert.equal(typeof result?.then, "undefined", "transaction callback is synchronous");
                return result;
            } catch (error) {
                for (const id of [...notes.keys()]) if (!contents.has(id)) notes.delete(id);
                for (const [id, content] of contents) notes.get(id).content = content;
                throw error;
            } finally { depth = 0; }
        },
        getNotesWithLabel(name, value) {
            return [...notes.values()].filter(item => item.labels.get(name) === value);
        },
        createDataNote(parent, title, data) {
            assert.equal(depth, 1);
            assert.equal(parent, "config");
            const item = note(`cache-${serial++}`, data);
            notes.set(item.noteId, item);
            return { note: item };
        }
    };
    return {
        host, notes, clock: () => now, advance: ms => { now += ms; },
        setNow: value => { now = value; }, inTransaction: () => depth > 0,
        config: data => { notes.get("config").content = JSON.stringify(data); },
        cacheNote: () => host.getNotesWithLabel("liveTennisSharedCache", "v1")[0],
        cache: () => JSON.parse(host.getNotesWithLabel("liveTennisSharedCache", "v1")[0].content),
        duplicateConfig: () => notes.set("duplicate", note("duplicate", config, { liveTennisConfig: "v1" }))
    };
}

test("one reservation precedes network and coalesces concurrent widget calls", async () => {
    const db = fixture();
    let finish;
    let requests = 0;
    const service = createService(db.host, async (url, options) => {
        requests++;
        assert.equal(db.inTransaction(), false);
        assert.equal(db.cache().lastAttempt, START);
        assert.equal(db.cache().nextAllowedAt, START + 900000);
        assert.equal(db.cache().pending, true);
        assert.equal(url, "https://api.livetennisapi.com/api/public/v1/matches?status=live&limit=200");
        assert.equal(options.headers["X-API-Key"], SECRET);
        assert.equal(options.redirect, "error");
        return new Promise(resolve => { finish = resolve; });
    }, db.clock);
    const first = service.refresh();
    const waiting = await Promise.all(Array.from({ length: 8 }, () => service.refresh()));
    assert.equal(requests, 1);
    assert.ok(waiting.every(result => result.status === "waiting"));
    finish(response(payload()));
    const done = await first;
    assert.equal(done.status, "ready");
    assert.equal(done.matches[0].players[1], "Second player");
    assert.equal(db.cache().pending, false);
    assert.equal(JSON.stringify(done).includes(SECRET), false);
    assert.equal(db.cacheNote().content.includes(SECRET), false);
});

test("shared durable cache survives service recreation and reserves the exact boundary", async () => {
    const db = fixture();
    let requests = 0;
    const fetch = async () => { requests++; return response(payload()); };
    await createService(db.host, fetch, db.clock).refresh();
    const restarted = createService(db.host, fetch, db.clock);
    db.advance(899999);
    for (let i = 0; i < 20; i++) await restarted.refresh();
    assert.equal(requests, 1);
    db.advance(1);
    await restarted.refresh();
    assert.equal(requests, 2);
    assert.equal(db.cache().lastAttempt, START + 900000);
});

test("intervals are finite and clamped to 15 minutes through 7 days", async () => {
    assert.equal(intervalSeconds(-2), 900);
    assert.equal(intervalSeconds(900.1), 901);
    assert.equal(intervalSeconds(Infinity), 900);
    assert.equal(intervalSeconds("900"), 900);
    assert.equal(intervalSeconds(1e300), 604800);
    const db = fixture({ apiKey: SECRET, intervalSeconds: 1e300 });
    let requests = 0;
    const service = createService(db.host, async () => { requests++; return response(payload()); }, db.clock);
    await service.refresh();
    assert.equal(db.cache().nextAllowedAt, START + 604800000);
    db.config({ apiKey: SECRET, intervalSeconds: 0 });
    db.advance(900000);
    await service.refresh();
    assert.equal(requests, 1, "reducing settings does not erase the prior reservation");
});

test("increasing interval and a backwards clock cannot bypass a persisted attempt", async () => {
    const db = fixture();
    let requests = 0;
    const service = createService(db.host, async () => { requests++; return response(payload()); }, db.clock);
    await service.refresh();
    db.config({ apiKey: SECRET, intervalSeconds: 1800 });
    db.advance(900000);
    assert.equal((await service.refresh()).nextAttempt, START + 1800000);
    db.setNow(START - 300000);
    await service.refresh();
    assert.equal(requests, 1);
    db.setNow(START + 1800000);
    await service.refresh();
    assert.equal(requests, 2);
});

for (const [name, fetch] of [
    ["HTTP authentication", async () => ({ ok: false, status: 401 })],
    ["HTTP rate limit", async () => ({ ok: false, status: 429 })],
    ["HTTP server", async () => ({ ok: false, status: 500 })],
    ["network", async () => { throw new Error(SECRET); }],
    ["JSON", async () => ({ ok: true, json: async () => { throw new Error(SECRET); } })],
    ["envelope", async () => response({ error: SECRET })]
]) {
    test(`${name} failures retain scores and consume the full request interval`, async () => {
        const db = fixture();
        await createService(db.host, async () => response(payload()), db.clock).refresh();
        db.advance(900000);
        let requests = 0;
        const service = createService(db.host, async (...args) => { requests++; return fetch(...args); }, db.clock);
        const result = await service.refresh();
        assert.equal(result.status, "stale");
        assert.equal(result.matches.length, 1);
        assert.equal(result.lastSuccess, START);
        assert.equal(result.nextAttempt, START + 1800000);
        assert.equal(JSON.stringify(result).includes(SECRET), false);
        db.advance(899999);
        await createService(db.host, async () => { requests++; return response(payload()); }, db.clock).refresh();
        assert.equal(requests, 1);
    });
}

test("late completion cannot overwrite a later reserved snapshot", async () => {
    const db = fixture();
    let finish;
    const slow = createService(db.host, () => new Promise(resolve => { finish = resolve; }), db.clock).refresh();
    db.advance(900000);
    const newer = { ...MATCH, tournament: "Newer event" };
    await createService(db.host, async () => response(payload([newer])), db.clock).refresh();
    finish(response(payload()));
    assert.equal((await slow).matches[0].tournament, "Newer event");
    assert.equal(db.cache().reservation, 2);
});

test("Retry-After persists a longer account limit across manual calls and service restarts", async () => {
    const db = fixture();
    let requests = 0;
    const fetch = async () => {
        requests++;
        return { ok: false, status: 429, headers: { get: () => "86400" } };
    };
    const result = await createService(db.host, fetch, db.clock).refresh();
    assert.equal(result.nextAttempt, START + 86400000);
    assert.equal(db.cache().nextAllowedAt, START + 86400000);
    db.config({ apiKey: SECRET, intervalSeconds: 1 });
    db.advance(900000);
    const restarted = createService(db.host, fetch, db.clock);
    for (let i = 0; i < 20; i++) await restarted.refresh();
    assert.equal(requests, 1);
    db.advance(85500000);
    await restarted.refresh();
    assert.equal(requests, 2);

    const longer = fixture({ apiKey: SECRET, intervalSeconds: 200000 });
    await createService(longer.host, fetch, longer.clock).refresh();
    assert.equal(longer.cache().nextAllowedAt, START + 200000000);
});

test("Retry-After accepts bounded HTTP dates and seconds while malformed values retain the floor", async () => {
    const cases = [
        ["broken", 900000], ["-3", 900000], ["0", 900000], ["30", 900000],
        ["1e6", 900000], ["9".repeat(200), 900000],
        [new Date(START + 172800000).toUTCString(), 172800000],
        [new Date(START - 1000).toUTCString(), 900000], ["999999999", 604800000]
    ];
    for (const [header, expected] of cases) {
        const db = fixture();
        await createService(db.host, async () => ({ ok: false, status: 429,
            headers: { get: () => header } }), db.clock).refresh();
        assert.equal(db.cache().nextAllowedAt, START + expected, header);
    }
});

test("missing key, duplicate settings and corrupt cache fail closed", async () => {
    const db = fixture({ apiKey: "", intervalSeconds: 900 });
    let requests = 0;
    const service = createService(db.host, async () => { requests++; return response(payload()); }, db.clock);
    assert.equal((await service.refresh()).status, "setup");
    assert.equal(db.cacheNote(), undefined);
    db.config({ apiKey: SECRET, intervalSeconds: 900 });
    await service.refresh();
    const reserved = db.cacheNote().content;
    db.cacheNote().content = "{broken";
    db.advance(900000);
    assert.equal((await service.refresh()).status, "setup");
    assert.equal(requests, 1);
    assert.equal(db.cacheNote().content, "{broken");
    db.cacheNote().content = reserved;
    db.duplicateConfig();
    assert.equal((await service.refresh()).status, "setup");
    assert.equal(requests, 1);
});

test("response orientation, nullable score fields and deciding match tiebreak are preserved", () => {
    const result = normalizeResponse(payload());
    assert.equal(formatMatch(result.matches[0]), "6-4  3-2 | Points 40-15");
    assert.equal(result.matches[0].score.server, 2);
    const nullable = { ...MATCH, score: { games: null, sets: [0, 0], points: [null, null], server: null } };
    assert.equal(formatMatch(normalizeResponse(payload([nullable])).matches[0]), "Sets unavailable | Points ?-?");
    assert.equal(formatMatch(normalizeResponse(payload([{ ...MATCH, score: null }])).matches[0]), "Score unavailable");
    const tiebreak = { ...MATCH, score: { ...MATCH.score, games: [[6, 4, 10], [4, 6, 5]], is_tiebreak: true } };
    assert.equal(formatMatch(normalizeResponse(payload([tiebreak])).matches[0]),
        "6-4  4-6  [10-5 match tiebreak] | Tiebreak 40-15");
});

test("empty and truncated pages do not trigger pagination and redact key echoes", async () => {
    assert.deepEqual(normalizeResponse(payload([])), { matches: [], total: null, truncated: false });
    assert.equal(normalizeResponse(payload([], { total: null, has_more: true })).truncated, true);
    assert.equal(normalizeResponse(payload([MATCH], { total: 3, has_more: false })).truncated, true);
    const db = fixture();
    let requests = 0;
    const echo = { ...MATCH, tournament: SECRET, players: { p1: { name: `<b>${SECRET}</b>` }, p2: { name: "B" } } };
    const result = await createService(db.host, async () => {
        requests++; return response(payload([echo], { total: null, has_more: true }));
    }, db.clock).refresh();
    assert.equal(requests, 1);
    assert.equal(result.truncated, true);
    assert.equal(result.total, null);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.equal(result.matches[0].players[0], "<b>[redacted]</b>");
});
