"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("ZIP is reproducible and creates the frontend parent before backend children", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trilium-livetennis-test-"));
    try {
        const first = path.join(temporary, "first.zip");
        const second = path.join(temporary, "second.zip");
        const builder = path.join(__dirname, "../scripts/build.py");
        execFileSync("python3", [builder, first]);
        execFileSync("python3", [builder, second]);
        assert.deepEqual(fs.readFileSync(first), fs.readFileSync(second));
        const metadata = JSON.parse(execFileSync("python3", ["-c", [
            "import json,sys,zipfile",
            "with zipfile.ZipFile(sys.argv[1]) as z:",
            " print(json.dumps({'files':z.namelist(),'metadata':json.loads(z.read('!!!meta.json'))}))"
        ].join("\n"), first], { encoding: "utf8" }));
        assert.deepEqual(metadata.files, ["!!!meta.json", "widget.js",
            "Live Tennis snapshots/backend.js", "Live Tennis snapshots/config.json"]);
        const root = metadata.metadata.files[0];
        assert.equal(metadata.metadata.appVersion, "0.106.0");
        assert.equal(root.mime, "application/javascript;env=frontend");
        assert.equal(root.children[0].title, "LiveTennisBackend");
        assert.equal(root.children[0].mime, "application/javascript;env=backend");
        assert.ok(root.attributes.some(attribute => attribute.name === "widget"));
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
