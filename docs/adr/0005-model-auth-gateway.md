# Model logins stay on the host behind the omp auth gateway

Date: 2026-10-30. Updated 2026-10-31 by owner decision. Updated 2026-11-03 to the one-agent arena (`0011-one-agent-arena.md`): this text names the current files, and says session where it said role. The older text is in git history.

## Context

The sandbox could read the model logins in omp's store (U15). A leaked login is irreversible: a revoke stops later use, but it does not undo calls, spending, or data access before it.

## Decision

- **The auth broker** (`omp auth-broker serve`, launchd `com.underground.auth-broker`, `127.0.0.1:8765`) holds the provider logins and does every OAuth refresh. It runs with `PI_CONFIG_DIR=.ug/host/auth`, so its store, `~/.ug/host/auth/agent/agent.db`, and its bearer, `~/.ug/host/auth/auth-broker.token`, sit in the host zone, which the sandbox cannot read (`host/launchd/com.underground.auth-broker.plist`; `../SPEC.md`, B6). Only the auth gateway talks to it. No session is a broker client, because a broker client receives access tokens and API keys (omp `docs/auth-broker-gateway.md:3`, read 2026-11-02).
- **The auth gateway** (`omp auth-gateway serve`, launchd `com.underground.auth-gateway`) listens on the tailscale address of this mac, from the `gateway=` line of `~/.ug/host/addresses`, and asks the auth broker for each credential (`OMP_AUTH_BROKER_URL` in its plist). It runs without `--clients`, so it has no per-session model grants or account limits. It does not expose provider secrets, broker snapshots, or credential write routes.
- **Sessions** reach models only through the gateway. Its bearer, `~/.ug/host/auth/auth-gateway.token`, is the one secret that a session holds: at each start the wrapper fills `@GATEWAY@` and `@GATEWAY_TOKEN@` in the config repo's `models.yml`, and the start step copies the file into the arena's `~/.omp/agent` (`host/bin/omp-arena`, `host/arena/init`, both removed in #90; the file is now written by `host/bin/ug-agent-setup`, see `0016-agent-user.md`, Open; `../SPEC.md`, B3). That `models.yml` defines the gateway providers with `transport: pi-native`. The wrapper does not check which providers it names: a provider outside the gateway has no login in the sandbox, and srt's allowlist (`host/network-allowlist`, removed in step 4 of `0016-agent-user.md`, line 75) blocked its host.
- **The owner** adds or renews a login, or rotates a bearer, with `ug-auth` (`host/bin/ug-auth`): the pinned omp with the auth root, limited to `auth-broker` and `auth-gateway`. Examples: `ug-auth auth-broker login <provider>`, `ug-auth auth-broker logout <provider>`, `ug-auth auth-gateway token --regenerate`.

The owner authorizes every session to use all models and accounts that the gateway serves, plus usage and credential health. Model selections in `models.yml` are defaults, not limits.

## Rejected

- srt egress masking. On macOS it masks env vars only and denies credential files (srt README, `credentials`). omp keeps its logins in a file.
- Sessions as clients of the real auth broker. Its one bearer also reads the snapshot, with every access token and API key (omp `docs/auth-broker-gateway.md:3`, `:72` to `:88`).

## Cost

- Two host services, and the gateway's tailscale address with its port on the srt allowlist (`0004-no-local-binding.md`).
- The gateway bearer is readable in every session (U30), so a leak to an allowlisted destination (U14) can carry it out. A holder with tailnet access can use every model and account that the gateway serves, and read usage. The owner accepts this shared access instead of per-session limits.
- `allowLocalBinding: true` lets the sandbox connect to the auth broker's port, `127.0.0.1:8765` (`../SPEC.md`, B5; the probe's `localhost` line). The broker answers only with its bearer, which the sandbox cannot read. Accepted for now (U7).
- A logout (`ug-auth auth-broker logout`) turns off every row of that provider, and keeps the secret in the row (omp `sqlite-credential-store.ts:486`, `:501`, omp 18.13.2). To make a key useless, the owner also revokes it with the provider.

## Amendment 2026-10-31: native /usage through a usage-only broker

omp's native `/usage` asks only an auth broker (`packages/ai/src/auth-broker/client.ts`, `GET /v1/usage`) or the session's own logins. A session has neither, so `/usage` was empty.

Decision: a host service, `com.underground.usage-broker` (`host/gh-broker/usage-broker.ts`, `127.0.0.1:18765`), speaks the broker client protocol with no logins. It answers the snapshot with an empty credential list, passes `GET /v1/usage` through to the gateway with the gateway token, accepts `POST /v1/usage/observed`, and answers 404 to the stream and every credential route. The session start script exports `OMP_AUTH_BROKER_URL` and `OMP_AUTH_BROKER_TOKEN` for every session (`host/agent/agent-start:6`). omp picks broker mode from that variable, or else from `auth.broker.url` in the agent's own `config.yml`, never from a `PI_CONFIG_FILES` overlay (omp docs, `auth-broker-gateway.md:325`, `:339`, read 2026-10-31). The variable wins over `config.yml`, and a session cannot change the environment of the next one. omp then runs as a broker client with zero credentials: native `/usage` works, and model calls still go through the gateway. The owner checked both on 2026-10-31 with a prototype: `omp usage` showed every account, and a prompt returned.

Cost: one more host service. A session gets usage numbers, which it could already read from the gateway. The real auth broker's token never leaves the host.

## Amendment 2026-11-01: the inference engine behind the gateway

The engine now refuses a request without its API key (`curl http://<engine>/v1/models` from a role sandbox: `401 {"error": {"type": "authentication_error", "message": "missing or wrong API key"}}`, 2026-11-01). The role's `strata` provider had `auth: none`, and the wrapper accepted only that form for a non-gateway provider, so a role could not call the engine.

Decision: the auth broker holds the engine key under omp's built-in `lm-studio` provider, and the gateway serves the engine as that provider. The gateway plist sets `LM_STUDIO_BASE_URL=http://@ENGINE@/v1`, which setup fills from the `engine=` line of the addresses file (`host/bin/ug-setup`; `install.sh` was removed, `../SPEC.md`, B9). The gateway skips `models.yml` (`ignoreLocalModelConfig: true` in `auth-gateway serve`, pinned omp 18.13.2), but it still registers the built-in local providers from their base URL variables, and it serves each provider that the broker holds a credential for. The config repo's `models.yml` lists `lm-studio` as one more gateway provider, with the engine model and its thinking settings. The engine is on no network allowlist, so a session reaches it only through the gateway.

Evidence: a run of the pinned omp 18.13.2 `auth-broker serve` and `auth-gateway serve` against a stub engine that wants `Bearer <key>` (2026-11-01). The gateway listed `lm-studio/qwen3.8-flash-next-ud-q4_k_xl`; `/v1/chat/completions`, `/v1/pi/stream`, and an `omp -p` client with `lm-studio` as a `pi-native` provider all reached the stub with the key from the broker, and the client held only the gateway bearer.

Rejected: the key in `models.yml`. Every session could read it. Rejected: srt credential masking. It needs `allowPlaintextInject` for the `http://` engine and a second secret path beside the broker. Rejected: a new host proxy. The gateway already does the job.

Cost: the gateway bearer now also unlocks the engine. The engine is called `lm-studio/<model>`, not `strata/<model>`. The owner stores the key once on the host: `ug-auth auth-broker login lm-studio`. Model discovery calls `/api/v0/models`, `/api/v1/models`, and `/v1/models` on the engine with the key.

## Amendment 2026-11-07: the agent box (proposed)

`0013-agent-box.md` is proposed, not built. Until it is built, this ADR describes the system. Once built, two parts change. The gateway bearer leaves the session: the box's `models.yml` points at the egress door, and the host adds the bearer to allowed model calls there, so the "one secret that a session holds" (Decision) becomes none. The box names the gateway and the usage broker by reserved names that only the egress proxy maps, such as `gateway.internal` and `usage.internal`, never by `127.0.0.1`: omp sends loopback and private-range addresses past the proxy (`0013-agent-box.md`, "Host services by name" and Evidence). omp stops when its auth broker does not answer, so the usage broker must be up before a box starts. The gateway stays on the tailscale address (owner decision, 2026-11-07): the tailnet holds only the owner's devices, so the tailnet access accepted above stays accepted. The auth broker and its host-zone root stay as they are.

2026-11-07: built as a trial. The box's `models.yml` holds the placeholder `ug-placeholder`, and the egress door adds the bearer (`host/bin/ug-box:84`, `host/egress/rules.ts:46`). The wrapper and `host/arena/init` that filled `models.yml` were removed in #90 (commit 54a418a1).

## Amendment 2026-11-08: paths

The model logins, `auth-broker.token`, and `auth-gateway.token` are in `/Users/ugauth/.omp`, omp's default profile (`docs/adr/0018-login-user.md:14`). Setup sets no `PI_CONFIG_DIR` and no `OMP_PROFILE` for them (`host/bin/ug-agent-setup:276-283`; `host/bin/ug-auth:31,38`; `host/agent/com.underground.auth-broker.plist:26-32`). This replaces the `~/.ug/host/auth` paths above.
