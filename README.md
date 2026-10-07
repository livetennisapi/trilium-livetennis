# Tennis score snapshots for Trilium

Show tennis score snapshots in the Trilium Notes right pane. The widget uses the FREE plan of [Live Tennis API](https://livetennisapi.com).

Snapshots refresh every 15 minutes or longer. The display shows when the snapshot was taken. This interval suits occasional score checks.

The import archive targets [Trilium Notes 0.106.0](https://github.com/TriliumNext/Trilium/releases/tag/v0.106.0). It contains a frontend widget, a backend module and an empty settings note.

## Install

1. Download [trilium-livetennis.zip](dist/trilium-livetennis.zip). Review [widget.js](src/widget.js) and [backend.js](src/backend.js) before allowing them to run.
2. Open Trilium's Options, then Security. In "Backend scripting", enable "Backend script execution". Reload the window after changing this setting.
3. Select a private parent note and import the ZIP. Uncheck "Safe import" for this reviewed archive so Trilium preserves its widget and scripting attributes.
4. Open the imported "Live Tennis settings" child note. Set `apiKey` to the key from your FREE account at [livetennisapi.com](https://livetennisapi.com).
5. Keep `intervalSeconds` at `900`, or set a longer interval. Save the note and reload the window. Select "Widgets" in the right panel, using its puzzle icon.

The FREE account requires no card. Its documented limit is 100 requests per day. See [authentication and quota](https://docs.livetennisapi.com/auth-quota-and-health.html) for account details.

For a server installation, enable backend scripting through its configuration and restart the server:

```ini
[Security]
backendScriptingEnabled=true
```

The equivalent environment setting is `TRILIUM_SECURITY_BACKEND_SCRIPTING_ENABLED=true`. See [Trilium's backend scripting guard](https://github.com/TriliumNext/Trilium/blob/v0.106.0/apps/server/src/services/scripting_guard.ts).

Backend scripting executes code on the Trilium server. Enable it only after reviewing the imported scripts. With an empty `apiKey`, the widget shows a setup message.

## Settings and privacy

The settings note starts with:

```json
{
  "apiKey": "",
  "intervalSeconds": 900
}
```

`intervalSeconds` accepts a number from 900 to 604800 seconds, which is seven days. Smaller numbers become 900. Larger numbers become 604800. Invalid values use 900.

The settings note stores the key in your Trilium database. Keep it out of shared notes and exports. Use the same database access controls as other private notes.

The backend sends the key in the `X-API-Key` header. The shared cache and returned widget snapshot omit it. Errors use fixed messages without response bodies.

Keep exactly one note labeled `#liveTennisConfig=v1` in the database. Multiple widget instances use that settings note and one cache labeled `#liveTennisSharedCache=v1`.

If you import another widget copy, remove `#liveTennisConfig` from its duplicate settings note. Keep the original settings and shared cache. Multiple settings notes produce a setup message.

## Request timing

Each attempt reserves its next permitted time in the shared cache before sending the request. Trilium saves that reservation in a synchronous database transaction.

All widget instances in the same database share the reservation. The wait survives manual refreshes and restarts. Updating `apiKey` or reducing the interval also preserves it.

HTTP failures, network failures and unreadable responses consume the interval. A failed refresh retains any previous snapshot. The network timeout is ten seconds.

On a failed response, a valid `Retry-After` header can extend the wait. Seconds and HTTP dates are accepted, capped at seven days. The deadline never moves earlier. Invalid values preserve the reserved interval.

A continuous 15 minute schedule uses 96 attempts per day. Other applications can use the same API credential. Their requests count toward its quota. Separate Trilium databases have separate caches.

While another widget's request is pending, the display checks the shared cache after one minute. This check sends no API request before the reserved time.

Keep the shared cache across upgrades and imports. If its JSON is damaged, restore the original attempt timestamps before retrying. The widget stops requests when it cannot read the cache.

## Display limits

The backend makes one request to:

```text
https://api.livetennisapi.com/api/public/v1/matches?status=live&limit=200
```

It reads the response's `data` array and `meta` object. A page contains at most 200 matches. The widget shows a truncation message when more matches exist.

It makes no pagination requests. The display contains matches listed as live at the snapshot time. A match that finishes disappears from the next snapshot.

Scores use player order. For example, `games: [[6,3],[4,2]]` displays `6-4  3-2`. Null scores and withheld fields display as unavailable or `?`.

The widget labels a deciding match tiebreak score above seven explicitly. It also displays the source's stale flag. Names render as plain text.

For the response model, see the [API OpenAPI schema](https://docs.livetennisapi.com/openapi.yaml).

## Build and test

Node.js 22 or later and Python 3 are required. No package dependencies are installed.

```sh
npm test
npm run check
npm run build
```

The build writes `dist/trilium-livetennis.zip` with fixed metadata and reproducible ZIP entries. Its parent note comes before child files, as required by Trilium's importer.

Tests check the shared reservation across concurrent calls and service instances. Failed requests consume the interval. Score validation and archive ordering have separate checks.

The source and archive use the [MIT license](LICENSE).
