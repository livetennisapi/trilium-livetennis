"use strict";

class LiveTennisWidget extends api.RightPanelWidget {
    get widgetTitle() { return "Tennis score snapshots"; }
    get parentWidget() { return "right-pane"; }
    isEnabled() { return true; }

    doRenderBody() {
        this.stopped = false;
        this.busy = false;
        this.body = this.$body[0];
        return this.refreshSnapshot();
    }

    element(tag, value) {
        const node = document.createElement(tag);
        if (value !== undefined) node.textContent = value;
        return node;
    }

    draw(snapshot) {
        this.body.replaceChildren();
        this.body.style.fontSize = "0.9em";
        const hint = this.element("p", snapshot.status === "setup" ? snapshot.error
            : snapshot.error ? `${snapshot.lastSuccess === null ? "Snapshot unavailable" : "Stale snapshot"}. ${snapshot.error}`
                : snapshot.status === "waiting" ? "A request is reserved. Waiting for its snapshot."
                    : snapshot.status === "stale" ? "This snapshot is older than the refresh interval."
                    : "Score snapshots refresh every 15 minutes or longer.");
        hint.setAttribute("role", "status");
        this.body.append(hint);
        if (snapshot.lastSuccess !== null) {
            this.body.append(this.element("p", `Last snapshot: ${new Date(snapshot.lastSuccess).toLocaleString()}`));
        }
        if (snapshot.status !== "setup" && snapshot.matches.length === 0 && snapshot.lastSuccess !== null) {
            this.body.append(this.element("p", "No live matches were listed in this snapshot."));
        }
        for (const match of snapshot.matches) {
            const row = this.element("section");
            row.style.borderTop = "1px solid var(--main-border-color, #aaa)";
            row.style.padding = "8px 0";
            row.append(this.element("strong", match.tournament));
            for (const [i, name] of match.players.entries()) {
                row.append(this.element("div", `${name}${match.score?.server === i + 1 ? " (serving)" : ""}`));
            }
            const score = match.score;
            let result = "Score unavailable";
            if (score) {
                const length = score.games ? Math.max(score.games[0].length, score.games[1].length) : 0;
                const sets = length ? Array.from({ length }, (_, i) => {
                    const pair = `${score.games[0][i] ?? "?"}-${score.games[1][i] ?? "?"}`;
                    return score.isTiebreak && i >= 2 && i === length - 1
                        && Math.max(score.games[0][i] ?? 0, score.games[1][i] ?? 0) > 7
                        ? `[${pair} match tiebreak]` : pair;
                }).join("  ") : "Sets unavailable";
                result = `${sets} | ${score.isTiebreak ? "Tiebreak" : "Points"} ${score.points ? score.points.map(p => p ?? "?").join("-") : "?-?"}`;
            }
            row.append(this.element("div", result));
            if (score?.stale) row.append(this.element("small", "The source marks this score stale."));
            this.body.append(row);
        }
        if (snapshot.truncated) this.body.append(this.element("p", snapshot.total === null
            ? "The API reports more matches. This snapshot contains one page of at most 200 matches."
            : `Showing one page of at most 200 of ${snapshot.total} listed matches.`));
        const button = this.element("button", "Refresh snapshot");
        button.type = "button";
        button.addEventListener("click", () => this.refreshSnapshot());
        this.body.append(button);
        if (snapshot.nextAttempt !== null) this.body.append(this.element("p", `Next API attempt after ${new Date(snapshot.nextAttempt).toLocaleTimeString()}.`));
    }

    async refreshSnapshot() {
        if (this.busy || this.stopped) return;
        clearTimeout(this.timer);
        this.busy = true;
        let snapshot;
        try {
            if (!api.isBackendScriptingEnabled()) {
                snapshot = { status: "setup", error: "Enable backend scripting in Trilium Security settings, then reload this window.",
                    matches: [], lastSuccess: null, nextAttempt: null };
            } else {
                snapshot = await api.runAsyncOnBackendWithManualTransactionHandling(async () => {
                    return await LiveTennisBackend.refresh();
                });
            }
        } catch {
            snapshot = { status: "setup", error: "The backend widget could not run. Check its import settings and reload this window.",
                matches: [], lastSuccess: null, nextAttempt: null };
        } finally {
            this.busy = false;
        }
        if (this.stopped) return;
        this.draw(snapshot);
        const delay = snapshot.nextAttempt === null || snapshot.status === "waiting" ? 60000
            : Math.max(60000, snapshot.nextAttempt - Date.now());
        this.timer = setTimeout(() => this.refreshSnapshot(), Math.min(delay, 2147483647));
    }

    cleanup() {
        this.stopped = true;
        clearTimeout(this.timer);
        super.cleanup();
    }
}

module.exports = new LiveTennisWidget();
