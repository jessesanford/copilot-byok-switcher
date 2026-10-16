# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [1.4.3] - 2026-10-16

### Fixed

- Hardened the OpenAI Responses adapter boundary by rebuilding requests from
  supported fields, including position-aware JSON Schema canonicalization for
  function parameters, so Copilot-private metadata is never forwarded.
- Preserved assistant tool-call history, parallel tool results, multimodal
  content, and dense tool-call indexes when translating between Chat
  Completions and Responses.
- Made Responses stream completion deterministic: terminal events finish
  immediately without waiting for socket closure, while provider failures,
  malformed frames, invalid tool arguments, and truncated streams produce typed
  downstream errors instead of silent success or hangs.

## [1.4.2] - 2026-08-12

### Changed

- Documentation catches up with the last few releases: the `shim` commands and
  `npm run catalog:audit` were missing from the README, as were several
  environment variables that only appeared in the troubleshooting guide. There is
  now one table listing all of them, so nothing is discoverable only by reading
  the source.

## [1.4.1] - 2026-08-12

### Fixed

- Removed `kimi-k2.6` from the Alibaba Token Plan list: that plan does not serve
  it, so it was offered and would have failed on selection.

### Added

- `npm run catalog:audit` checks every curated model against its provider's live
  catalog and exits non-zero when one does not exist. Providers with a public
  catalog are checked without credentials; the others use a configured key and are
  reported as unverifiable when there is none. The audit across all 30 providers
  found exactly one wrong entry, the one above; chutes, opencode-go and
  opencode-zen check out fully, and twelve providers ship no curated list at all.

## [1.4.0] - 2026-08-12

### Added

- A progress line during startup. Querying the providers takes about a second when
  they all answer and up to the timeout when one does not, and with no sign of life
  that pause reads as a hang — it happens before Copilot has drawn anything:

  ```
  ⠹ copilot-byok  [██░] 2/3 providers  alibaba-token-plan
  ```

  It counts exactly the providers being queried, names the ones still pending, and
  wipes itself before the summary line. Written to stderr only when stderr is a
  terminal, so piped output and CI logs stay clean; `COPILOT_BYOK_PROGRESS=off`
  disables it and `COPILOT_BYOK_ASCII=1` swaps the Braille spinner for ASCII where
  the console cannot render it.

### Fixed

- **A failed discovery no longer offers models the key cannot use.** Reported from
  use: an Alibaba Token Plan showed `kimi-k2.6`, which that plan does not include,
  while `deepseek-v4-flash-0731`, which it does, was missing. The cause was the
  fallback: the shipped list is generic, but a provider's catalog belongs to the
  plan behind the key, so falling back to it invents models and hides real ones.

  The list a key actually returned is now kept on disk and preferred over the
  shipped one when a request fails, with the reason recorded:

  ```
  notice: alibaba-token-plan: model discovery failed (401 Unauthorized);
          using the list this key returned last time
  ```

  Entries older than thirty days are ignored, an empty response never overwrites a
  good list, and the file is written atomically. It lives in
  `~/.cache/copilot-byok/models.json` (`%LOCALAPPDATA%` on Windows) and can be
  moved with `COPILOT_BYOK_MODEL_CACHE`.

## [1.3.0] - 2026-08-12

### Added

- **`reasoningEffortPicker`**, off by default, declares reasoning-effort support so
  Copilot shows its effort selector for a model. It is off because on CLI 1.0.79
  the chosen level never reaches a BYOK provider: payloads sent with `low` and with
  `high` are byte-identical, in both the chat-completions and the responses wire
  formats. This is a known CLI bug, not a design decision — see
  github/copilot-cli#4012 (same model family as ours, still open), #3119 and #3135,
  the last of which records that the level *was* being sent in 1.0.41.
- `reasoningEffortLevels` overrides which levels the selector offers, since models
  differ: Claude Sonnet 4.6 has no `xhigh`, Gemini stops at `high`.

Everything is in place for the day the CLI forwards it again: the router already
prefers an incoming `reasoning_effort` over the configured one, so a user's pick
will take effect with no further change. Turning on `reasoningEffortPicker` is then
the only step — and until then `reasoningEffort` in the config remains the setting
that actually reaches the provider.

## [1.2.0] - 2026-08-12

### Added

- **Reasoning effort per model.** Copilot never forwards its own effort setting to
  a BYOK provider — requests made with `low` and with `high` are byte-identical on
  the wire — so `reasoningEffort` on a model (or provider) is what actually takes
  effect: the router adds it to the outgoing request.
- Levels differ per model and providers do not fall back on their own: GLM-5.2
  accepts `max` yet answers `400` to `xhigh`. The router steps the level down until
  one is accepted, logs the adjustment, and remembers it for the rest of the
  session so no round trip is wasted twice.
- Discovery now records whether a model reasons, from the provider's own metadata.

- **`copilot-byok shim install`** makes plain `copilot` go through the router in
  every shell and on all three platforms, instead of an alias that only works in
  the shell whose profile was edited. The shim passes the real CLI's path through
  `COPILOT_BIN`, which is what keeps it from calling itself, and `shim status`
  reports whether its directory is actually on PATH.

### Fixed

- A provider that ships no curated models could never activate: the check for
  usable providers ran before discovery, discarding exactly the providers that
  gain their models from it. This undid part of what 1.1.0 promised.

## [1.1.0] - 2026-08-12

### Added

- **The model list now comes from the providers themselves.** At startup each
  configured provider is asked what it currently serves, so the picker reflects
  today's line-up instead of a list curated at release time. All 30 catalog
  providers were verified to expose an OpenAI-style `GET /models`; those that also
  publish capabilities supply the real context window, output limit and
  tool-calling flag with it.
- Only providers you hold a key for are queried, in parallel, with a bounded
  timeout — about a second for three configured providers. Successful results are
  cached for ten minutes, failures for one, so a momentary outage is retried soon
  while a healthy catalog is not re-fetched on every rebuild.
- Providers that ship without a curated list (OpenRouter, Cerebras, Together,
  SiliconFlow and the rest) become usable the moment you add their key.
- `--no-discovery` keeps the shipped lists for anyone who prefers a fixed set.

Discovery never empties the picker: an unreachable provider, a rejected key or an
empty response all fall back to the shipped catalog, and the router log records
which provider fell back and why. Models that cannot call tools are still
excluded, and each provider contributes at most twelve entries so a 400-model
catalog cannot swamp the list.

### Fixed

- **Installing `/byok` emptied the `/model` picker.** The extension declared
  `onPermissionRequest`, which makes Copilot ask the user to grant it elevated
  permissions ("this extension wants to: handle permission requests") before
  loading it. Until that prompt is answered the CLI sits on "still waiting on
  extensions" and the model list never arrives, so the picker shows nothing — a
  command meant to help configure models was hiding them instead. `/byok` never
  needed that capability: it only reads its own configuration and asks for a key.
  Removing the declaration fixes it, with no prompt and no flags required.
- The extension imports the package's modules lazily instead of before joining the
  session, so it no longer delays the handshake the CLI waits for.

The troubleshooting guide now explains the symptom, since any third-party
extension declaring `onPermissionRequest` will cause it.

## [1.0.0] - 2026-08-12

Your provider models now appear inside the Copilot `/model` picker, in the same
session as the GitHub ones, instead of replacing them.

### Added

- A local router (`src/router.mjs`) placed in front of the Copilot API through the
  `COPILOT_API_URL` variable. It appends the configured models to `GET /models`,
  forwards `byok-*` requests to the matching provider, and passes everything else
  through to GitHub untouched. No TLS interception is involved.
- Automatic detection of the Copilot API tier (individual, business, enterprise),
  overridable with `--upstream` or `COPILOT_BYOK_UPSTREAM`.
- A generated provider catalog covering 30 providers: OpenAI, Anthropic, Google
  Gemini, xAI, Mistral, Groq, Cerebras, Together, DeepInfra, Fireworks,
  OpenRouter, DeepSeek, Alibaba Qwen (international and China), Z.AI, Zhipu,
  Moonshot Kimi, MiniMax, StepFun, ByteDance Doubao, Tencent Hunyuan, Baidu
  Qianfan, SiliconFlow, ModelScope, Chutes, OpenCode Zen and Go, Alibaba Token
  Plan, plus local Ollama and LM Studio.
- `npm run catalog:update`, which rebuilds the catalog from models.dev so context
  windows and capabilities stay accurate. Models without tool-calling support are
  excluded rather than published with wrong metadata.
- `--list-providers`, showing which providers are usable now and which
  environment variable unlocks each of the others.
- A `models` array on providers, with per-model label, context window and output
  limit, and an `enabled` flag for entries that ship disabled.
- A `/byok` slash command for use inside a Copilot session, installed with
  `copilot-byok extension install`. It lists the providers with their state and
  asks for the key of the one you pick. Copilot CLI extensions are gated behind
  `--experimental`. Note that Copilot caches its model list per session, so models
  unlocked this way appear the next time copilot-byok starts.
- Tests for the catalog, the router (including provider forwarding and model-name
  translation), the upstream resolver, the key store and the launcher.

### Fixed

- A provider or GitHub connection that broke mid-stream left the session waiting
  forever: `pipe()` does not end the destination on a source error, and an
  `IncomingMessage` with no error listener discards the error. Both are handled,
  and the response is closed.
- Cancelling a generation now aborts the provider request instead of letting it
  stream to completion — paid providers were still billing for abandoned answers.
- A single-string `apiKeyEnv` or `bearerTokenEnv`, which the schema allows,
  crashed `--list-providers`, `keys list`, and the router itself after startup.
  Environment names are always normalized to an array now.
- Advertised prompt and output limits could exceed the model's own context window
  (Grok 4.5 claimed 500k prompt plus 500k output of a 500k window), which made
  providers reject requests once Copilot filled the prompt to the stated limit.
- Custom `headers` were spread after the computed ones, so a gateway config could
  override `host` and `content-length` and corrupt the request. They are also
  checked for inline secrets now, like `modelsHeaders` already were.
- A network blip during the first upstream probe pinned Business and Enterprise
  accounts to the individual API host for the rest of the session.
- `--upstream` accepted anything, then failed every request with `Invalid URL`.
- Single-provider flags (`--provider`, `--list-models`, `--offline`, `--wire-api`,
  `--no-model-prompt`) were parsed and silently ignored in router mode; they now
  say they need `--legacy`.
- `keys` and `extension` ignored `--config`, so a provider defined only in a
  custom catalog could not be given a key.
- The key store was written in place, so an interrupted write truncated it and
  concurrent writers lost updates. It is written to a temp file and renamed.
- Model names that slugify to the same id silently dropped one model from the
  picker; the collision is reported.
- Restored `process.exitCode` in place of `process.exit()`, which could truncate
  piped stdout on POSIX.

### Changed

- Running `copilot-byok` with no arguments now starts the router; providers
  activate only when their key is present, so the picker stays short.
- Providers default to the OpenAI-compatible wire format: `type` is only needed
  for the Anthropic and Azure shapes used by the legacy mode.
- The published example is now a customization sample rather than a copy of the
  built-in catalog.

### Kept

- The original single-provider behaviour, now behind `--legacy`, including
  `--offline`, `--wire-api`, `--list-models` and model ranking.
- `--native` for a stock Copilot session with no router.

## [0.3.0] - 2026-08-08

### Added

- Built-in presets for OpenAI, Anthropic, local Ollama, Groq, xAI, Mistral AI, the Z.ai pay-as-you-go API, and the OpenAI-compatible OpenCode Go endpoint.
- Optional provider authentication through `authRequired: false`, catalog authentication modes for bearer, `x-api-key`, and `api-key`, model include/exclude prefixes, transport selection, and Azure API version forwarding.
- A 5 MiB model-catalog response limit and model-id validation against terminal control characters and excessive lengths.
- A troubleshooting guide covering Copilot discovery, provider credentials, Ollama, catalog timeouts, and model compatibility.
- A 1280×640 repository social-preview asset.

### Changed

- OpenCode Go now keeps Messages-compatible MiniMax/Qwen models separate from Chat Completions models; all existing `opencode-go`, `go`, and `opencode` identifiers remain valid.
- A configured `defaultModel` is now the actual automatic default, ahead of ranked catalog alternatives.
- Model ranking filters non-chat output modalities and additional image, video, moderation, realtime, transcription, speech, and safety model families, and understands nested capability/context metadata.
- Updated Z.ai Coding Plan to `glm-5.2`, MiniMax to `MiniMax-M3`, ESLint to 10.8.1, globals to 17.9.0, and the fixed `brace-expansion` transitive release.
- Reworked the top of the README around installation, native/cloud/local quick starts, and the project's security-focused purpose.
- Aligned security, contribution, pull-request, and agent guidance with explicit catalog authentication modes and intentionally authless providers.

### Security

- Native and BYOK launches strip stale `COPILOT_MODEL`, `COPILOT_OFFLINE`, all `COPILOT_PROVIDER_*` variables, and built-in or custom provider credential sources from the Copilot child environment.
- Inline credential fields are rejected even when empty; credential-like URL query parameters and broader secret-bearing catalog headers are also rejected.
- Bearer credentials now take precedence over API keys instead of emitting both to the child process.
- CI audits both production and development dependencies at high severity.

### Fixed

- Authless local providers such as Ollama no longer require a dummy API key.
- Native mode still ignores malformed provider configuration for startup, while valid custom configuration is used to sanitize secret-source variables.
- Non-`ENOENT` configuration discovery errors are no longer silently treated as a missing file.

## [0.2.0] - 2026-08-01

### Added

- `-v` / `--version` prints the installed `copilot-byok` version. The flag is consumed by the switcher and is
  no longer forwarded to GitHub Copilot CLI; use `-- --version` to pass it through.
- A `Command-Line Options` table, a `Project Structure` section, and explicit `Release Process`,
  `Contributing`, `Security`, `Changelog`, and `License` sections in `README.md`.
- `AGENTS.md` with the project-specific stack, commands, security rules, provider checklist, validation gate,
  and release process for contributors and AI agents.
- Node.js engine and license badges in `README.md`.
- Tests for `--help`, `--version`, interactive provider selection, interactive model selection, and the
  missing-binary error path (39 tests to 45; line coverage 87.3% to 93.0%).

### Changed

- A missing or unreachable Copilot executable now fails with an actionable message naming the resolved path
  and the install command, instead of a raw `spawn ... ENOENT`.
- CI runs on pushes to `main` and to `v*` tags, on pull requests, and on manual dispatch, removing the
  duplicate workflow run that every pull-request branch previously triggered.
- The security contact link in the issue-template chooser points to `SECURITY.md` instead of a generic site URL.

### Fixed

- Removed a dead `platform` argument passed to `buildCopilotSpawnOptions`, which does not accept it.

### Internal

- ESLint ignores `coverage/`, so `npm run lint` after `npm run test:coverage` no longer depends on cleanup.
- `.gitignore` covers `*.tgz` (`npm pack` output) and `Thumbs.db`.
- Consolidated the duplicated `src/cli.mjs` import in `test/cli.test.mjs`.

## [0.1.0] - 2026-08-01

- Published the first stable package to npm and created the matching GitHub
  release and version tag.
- Added a standard `.gitattributes` file to normalize line endings across platforms (`* text=auto eol=lf`, with binary markers for image/vsix assets).
- Added documented built-in presets for OpenRouter, Moonshot AI/Kimi, Alibaba Model Studio Token Plan, and Tencent Cloud Token Plan.
- Updated the Z.ai Coding Plan fallback to `glm-5.1`.
- Added `--offline` and `--wire-api completions|responses` support for current Copilot CLI BYOK capabilities.
- Set the required `COPILOT_MODEL` catalog value separately from `COPILOT_PROVIDER_WIRE_MODEL`.
- Hardened process launching against Windows shell injection by using shell-free cross-platform spawning.
- Added standalone Copilot binary discovery that skips the stale VS Code shim when an npm installation is available.
- Documented a reproducible provider verification matrix with explicit evidence levels.
- Added strict provider-config validation, model-catalog timeouts, safe same-origin authentication defaults, and case-insensitive secret sanitization.
- Added a distributable JSON Schema for provider configuration editor support.
- Improved model ranking for OpenRouter metadata and provider catalogs returned as arrays.
- Expanded tests, package checks, security documentation, and CI coverage for Node.js 22/24 on Windows, macOS, and Linux.
- Pinned GitHub Actions to immutable commits and removed the inactive Dependabot auto-merge workflow.
- Initial release: cross-platform launcher for GitHub Copilot CLI custom model
  providers (BYOK), with interactive provider selection, automatic model
  defaults, and isolated provider environment handling.
