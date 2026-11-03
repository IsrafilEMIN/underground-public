# Model logins stay on the host behind the omp auth gateway

Date: 2026-10-30. Updated 2026-10-31 by owner decision.

Holds under the redesign (2026-11-02), with three changes from `0011-one-agent-arena.md`: the auth broker keeps its logins in `~/.ug/host/auth`, not in `~/.omp`; no session is a broker client; and the usage broker stays on `127.0.0.1:18765` (amendment 2026-11-03 in `0004-no-local-binding.md`). The role isolation named below is gone.

The sandbox could read the model logins in omp's store (U15). A leaked login is irreversible: a revoke stops later use, but it does not undo calls, spending, or data access before it.

Decision: `omp auth-broker serve` and `omp auth-gateway serve` run on the host. The auth broker holds the provider logins and does every OAuth refresh. Its bearer stays host-only. Every role shares the gateway bearer from `~/.omp/auth-gateway.token`, rendered into its owner-part `models.yml` by `admin.ts gateway-setup`. The gateway runs without `--clients`; no per-role model grants or account configuration remain.

The owner authorizes every role to use all models and accounts served by the gateway, plus usage and credential health. Role model selections are defaults, not authorization limits. The gateway does not expose provider secrets, auth-broker snapshots, or credential management routes. This decision does not expose the auth-broker bearer.

The role's `models.yml` defines gateway providers with `transport: pi-native`. That transport applies only to models under those providers. The wrapper still requires every selected model to use a gateway provider (the keyless inference engine left on 2026-11-01, amendment below). A model outside those providers has no provider login in the sandbox.

Usage authorization does not integrate omp's native `/usage` command with the gateway. That command lacks gateway client wiring; permissions alone do not fix it.

Rejected: srt egress masking. On macOS it masks env vars only and denies credential files (srt README, `credentials`). omp keeps its logins in a file.

Cost: two host services, and the gateway's tailscale address on the srt allowlist (`0004-no-local-binding.md`). The gateway listens on the tailscale address of this mac, from the owner's addresses file; the inference engine is on `v100-server`. The gateway bearer is readable in every sandbox, so a leak to an allowlisted destination (U14) can carry it out. A holder with tailnet access can use every served model and account and read usage. The owner accepts this shared access instead of per-role restrictions. Role isolation, network restrictions, and GitHub reviewer restrictions remain unchanged.

## Amendment 2026-10-31: native /usage through a usage-only broker

omp's native `/usage` asks only an auth broker (`packages/ai/src/auth-broker/client.ts`, `GET /v1/usage`) or the session's own logins. A role has neither, so `/usage` was empty.

Decision: a host service, `com.underground.usage-broker` (`host/broker/usage-broker.ts`, `127.0.0.1:18765`), speaks the broker client protocol with no logins. It answers the snapshot with an empty credential list, passes `GET /v1/usage` through to the gateway with the gateway token, accepts `POST /v1/usage/observed`, and answers 404 to the stream and every credential route. The wrapper exports `OMP_AUTH_BROKER_URL` and `OMP_AUTH_BROKER_TOKEN` for every role. omp picks broker mode from that variable, or else from `auth.broker.url` in the agent's own `config.yml`, never from a `PI_CONFIG_FILES` overlay (omp docs, `auth-broker-gateway.md:325`, `:339`, read 2026-10-31). The variable wins over `config.yml`, and a role cannot change the environment of its next session. omp then runs as a broker client with zero credentials: native `/usage` works, and model calls still go through the gateway. The owner checked both on 2026-10-31 with a prototype: `omp usage` showed every account, and a prompt returned.

Cost: one more host service. A role gets usage numbers, which it could already read from the gateway. The real auth broker's token never leaves the host.

## Amendment 2026-11-01: the inference engine behind the gateway

The engine on `v100-server` now refuses a request without its API key (`curl http://100.64.0.99:8081/v1/models` from a role sandbox: `401 {"error": {"type": "authentication_error", "message": "missing or wrong API key"}}`, 2026-11-01). The role's `strata` provider had `auth: none`, and the wrapper accepted only that form for a non-gateway provider, so a role could not call the engine.

Decision: the auth broker holds the engine key under omp's built-in `lm-studio` provider, and the gateway serves the engine as that provider. The gateway plist sets `LM_STUDIO_BASE_URL=http://@ENGINE@/v1`, which `install.sh` fills from the `engine=` line of the addresses file. The gateway skips `models.yml` (`ignoreLocalModelConfig: true` in `auth-gateway serve`, pinned omp 18.13.2), but it still registers the built-in local providers from their base URL variables, and it serves each provider that the broker holds a credential for. Each role's `models.yml` lists `lm-studio` as one more gateway provider, with the engine model and its thinking settings. The engine leaves every network allowlist, so a role reaches it only through the gateway.

Evidence: a run of the pinned omp 18.13.2 `auth-broker serve` and `auth-gateway serve` against a stub engine that wants `Bearer <key>` (2026-11-01). The gateway listed `lm-studio/qwen3.8-flash-next-ud-q4_k_xl`; `/v1/chat/completions`, `/v1/pi/stream`, and an `omp -p` client with `lm-studio` as a `pi-native` provider all reached the stub with the key from the broker, and the client held only the gateway bearer.

Rejected: the key in each role's `models.yml`. Every role could read it. Rejected: srt credential masking. It needs `allowPlaintextInject` for the `http://` engine and a second secret path beside the broker. Rejected: a new host proxy. The gateway already does the job.

Cost: the gateway bearer now also unlocks the engine. The engine is called `lm-studio/<model>`, not `strata/<model>`. The owner stores the key once on the host: `omp auth-broker login lm-studio`. Model discovery calls `/api/v0/models`, `/api/v1/models`, and `/v1/models` on the engine with the key.
