"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function fixture(enabled = true) {
    const delays = [];
    const node = tag => ({ tag, children: [], style: {}, attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        append(...values) { this.children.push(...values); },
        replaceChildren() { this.children = []; },
        addEventListener() {} });
    const body = node("body");
    const api = { RightPanelWidget: class { cleanup() {} }, isBackendScriptingEnabled: () => enabled,
        runAsyncOnBackendWithManualTransactionHandling: async () => { throw new Error("Not used"); } };
    const context = { api, module: { exports: {} }, document: { createElement: node }, Date,
        setTimeout(callback, delay) { delays.push(delay); return 1; }, clearTimeout() {} };
    vm.runInNewContext(fs.readFileSync(require.resolve("../src/widget"), "utf8"), context);
    const widget = context.module.exports;
    widget.$body = [body];
    widget.body = body;
    const content = item => [item.textContent || "", ...item.children.map(content)].join(" ");
    return { widget, body, delays, content: () => content(body) };
}

test("backend disabled renders setup without sending a backend request", async () => {
    const view = fixture(false);
    await view.widget.doRenderBody();
    assert.match(view.content(), /Enable backend scripting/);
    assert.equal(view.delays[0], 60000);
});

test("names and nullable scores are displayed as text and unknown page totals stay readable", () => {
    const view = fixture();
    view.widget.draw({ status: "ready", error: null, lastSuccess: 1800000000000, nextAttempt: null,
        truncated: true, total: null, matches: [{ tournament: "<script>bad()</script>",
            players: ["<img src=x onerror=bad()>", "Second player"], score: null }] });
    assert.match(view.content(), /<script>bad\(\)<\/script>/);
    assert.match(view.content(), /Score unavailable/);
    assert.match(view.content(), /at most 200 matches/);
    assert.doesNotMatch(view.content(), /of null/);
    const inspect = item => { assert.equal(item.innerHTML, undefined); item.children.forEach(inspect); };
    inspect(view.body);
});

test("first request errors say unavailable without claiming a previous snapshot", () => {
    const view = fixture();
    view.widget.draw({ status: "stale", error: "The API request failed.", lastSuccess: null,
        nextAttempt: null, truncated: false, matches: [] });
    assert.match(view.content(), /Snapshot unavailable/);
    assert.doesNotMatch(view.content(), /Stale snapshot/);
});

test("waiting widgets check the shared snapshot after one minute", async () => {
    const view = fixture();
    view.widget.stopped = false;
    view.widget.busy = false;
    const contextResult = { status: "waiting", error: null, matches: [], lastSuccess: null,
        nextAttempt: Date.now() + 900000 };
    view.widget.draw = () => {};
    // The callback is run by Trilium. This fixture supplies its already reserved result.
    const source = fs.readFileSync(require.resolve("../src/widget"), "utf8");
    const sandbox = { api: { RightPanelWidget: class { cleanup() {} }, isBackendScriptingEnabled: () => true,
        runAsyncOnBackendWithManualTransactionHandling: async () => contextResult }, module: { exports: {} },
        Date, clearTimeout() {}, setTimeout(callback, delay) { view.delays.push(delay); return 1; } };
    vm.runInNewContext(source, sandbox);
    const widget = sandbox.module.exports;
    widget.stopped = false;
    widget.busy = false;
    widget.draw = () => {};
    await widget.refreshSnapshot();
    assert.equal(view.delays[0], 60000);
});
