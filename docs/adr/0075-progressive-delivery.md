# ADR-0075 — Blue/green and canary delivery, and the web proxy that could never have worked

| Field      | Value                                                                    |
|------------|--------------------------------------------------------------------------|
| **Status** | Accepted                                                                 |
| **Date**   | 2026-08-03                                                               |
| **Scope**  | `deploy/helm/gambit`, `docker/web`, `Dockerfile.web`, `scripts`, `docs`   |

---

## Context

Every Gambit release so far has been a human merging to `main`, and every deployment strategy the
chart could express was "replace the pods and hope". Kubernetes' rolling update is a real strategy —
it is health-gated and it does not drop all the pods at once — but it has two properties that matter
when something goes wrong:

- **Rollback is another rollout.** Reverting means pulling the previous image and cycling pods
  again, at exactly the moment the operator most wants an instantaneous, boring action.
- **The blast radius is everyone.** A rolling update moves 100% of traffic to the new version as the
  pods come up. The only signal that it was a bad version is production breaking.

M14 listed "blue/green + canary deployment strategy" as deferred. This increment implements it for
the HTTP tier.

### A prerequisite bug: the web tier has never worked in Kubernetes

While tracing where traffic actually enters the release, the web proxy turned out to be broken —
not subtly, and not recently.

The web proxy config — then named `nginx.conf`, today
[`docker/web/nginx.conf.template`](../../docker/web/nginx.conf.template) — hardcoded its upstreams as
the **compose** service names:

```nginx
location /v1/ { proxy_pass http://api:8080; }
location /ws  { proxy_pass http://gateway:4175; }
```

The Helm chart names its Services after the release: `release-name-gambit-api`. Nothing in the
cluster answers to `api`. nginx resolves an upstream literal **when it loads its configuration**, not
per request, so this is not a 502 under load — the container exits before it ever listens:

```
[emerg] host not found in upstream "api" in /etc/nginx/conf.d/default.conf:33
```

The web pod would have entered `CrashLoopBackOff` on the first `helm install`, and with it the entire
public entrypoint: the SPA, `/v1` and `/ws` all arrive through this proxy. Every gate the repo has
was blind to it for the same reason M14 inc 8's build-order rot went unnoticed — CI validates that
the manifests are schema-valid and that the image builds, and neither of those runs the image against
the manifests. It is the third instance of the same failure mode: **a hand-maintained copy of a name
that lives somewhere else.**

This had to be fixed here regardless of progressive delivery, because a traffic-splitting mechanism
in front of a tier that cannot start is theatre. It also turns out to be the mechanism the rest of
this ADR depends on.

## Decision

### 1. The web proxy's upstreams become configuration

That `nginx.conf` becomes `docker/web/nginx.conf.template`, copied to
`/etc/nginx/templates/default.conf.template`. The nginx image's entrypoint runs `envsubst` over that
directory before starting, so `${API_UPSTREAM}` and `${GATEWAY_UPSTREAM}` are resolved per
environment. `Dockerfile.web` sets the compose names as ENV defaults, so `docker compose up` behaves
exactly as before, and the chart injects the release-prefixed Service names.

`NGINX_ENVSUBST_FILTER` restricts substitution to those two variables. Without it envsubst expands
anything in the file matching an environment variable name, which would quietly rewrite nginx's own
`$host` / `$uri` / `$scheme`.

The alternative — rendering an nginx config from a Helm ConfigMap — was rejected because it creates a
second copy of the proxy rules that must be kept in step with the one in the image. That is precisely
the class of bug being fixed.

### 2. Progressive delivery covers the HTTP tier only

`rollout.strategy` is `rolling` (unchanged behaviour, and still the default), `blueGreen`, or
`canary`. It applies to **api** and **web**. The gateway is deliberately excluded, and so is the
search indexer:

- **The gateway holds long-lived WebSocket connections.** A blue/green flip is instantaneous by
  design, which for the gateway means severing every connected game at once. Worse, game-command
  ownership is coordinated across replicas through a Redis registry (ADR-0010) that is keyed by game,
  not by version — two versions would both be legitimate owners, which is not a traffic split but a
  split brain. A rolling update, which drains pods one at a time and lets clients reconnect, is the
  correct strategy here and remains in place.
- **The search indexer is pinned to one replica** (ADR-0057) because it dedups in process. Rendering
  a second track would double-index every finished game.

The consequence is a constraint, stated rather than hidden: a change that alters the gateway's wire
contract must be compatible with the API version on both sides of a rollout.

### 3. Blue/green flips a Service selector, not a fleet

Both colors are rendered as separate Deployments (`-api-blue`, `-api-green`). The primary Service
selects `gambit.dev/color: <activeColor>`. The cutover is one value:

```bash
helm upgrade gambit deploy/helm/gambit --set rollout.blueGreen.activeColor=green
```

Nothing restarts. No image is pulled. The rollback is the same command with `blue`, and it is as fast
as the cutover was — which is the whole point of paying for two fleets.

Two details make that true rather than nearly true:

- **The variant label is in the Deployment's `matchLabels`, not just the pod template.** Without it,
  each color's ReplicaSet selects the other color's pods and the two fight over one fleet.
- **The standby runs at the active color's replica count by default.** An earlier draft sized it at
  `preview.replicas: 1` to save cost, which would have made the flip move all production traffic onto
  a single pod and *then* scale up. The snapshot assertion that a flip changes no image, name, or
  replica count is what caught it. `preview.replicas` still exists for deliberately cheap standbys,
  and the runbook says to scale up in a separate upgrade before flipping.

The standby is reachable at its own hostname (`preview.<host>`) through its own Service and Ingress,
so the incoming version can be exercised against production dependencies before it takes traffic.

### 4. Canary weights at the ingress, not by replica count

The canary track is a second Deployment labelled `gambit.dev/track: canary` behind its own Service,
fronted by a second Ingress carrying ingress-nginx's canary annotations:

```yaml
nginx.ingress.kubernetes.io/canary: "true"
nginx.ingress.kubernetes.io/canary-weight: "10"
```

The obvious controller-free alternative is to put both tracks behind one Service and let the replica
ratio do the splitting. It was rejected: the granularity is then a function of pod count (with 2
stable pods the smallest possible canary is 33%), and changing the weight means rescaling, which
couples the traffic decision to the capacity decision. The annotation gives real percentage routing
that is independent of both.

This makes the canary strategy ingress-nginx-specific, which is why the chart refuses to render it
without an Ingress rather than producing a canary track that silently receives nothing.

`canary.header` additionally enables `canary-by-header`, so the canary can be tested on purpose
instead of by waiting to be sampled into it. A weight of `0` is explicitly valid: the canary is
staged and reachable only by that header.

### 5. Each web variant addresses the api variant of its own version

The api and web variant lists are parallel — a variant's Service suffix is the same on both — so the
web pod's `API_UPSTREAM` points at `…-api`, `…-api-preview` or `…-api-canary` to match itself. A
canary cohort gets the canary frontend **and** the canary API; a preview session exercises both new
halves together. Without this, a canary would be a new SPA calling the old API, which tests a pairing
that will never exist in production.

This is only expressible because of decision 1. The bug fix is what makes the feature coherent.

### 6. Every misconfiguration fails the render

`gambit.rollout.validate` rejects: an unknown strategy; an `activeColor` that is not `blue` or
`green`; a preview whose two colors resolve to the **same image** (the standby would be a copy of what
is already live, making both the preview and the rollback meaningless); a canary with no tag (a canary
of the running version tests nothing); a canary with no Ingress; and a weight outside 0–100.

Note what that first guard is *not*: an earlier draft required the standby color to carry a tag of its
own while the active color fell back to `images.<component>.tag`. Qodo pointed out the asymmetry —
an operator who set only the incoming color's tag had a release that rendered fine and then failed to
render **at the moment they flipped**, because the newly-inactive color had no tag. A cutover and the
rollback after it are the two worst moments to meet a validation error. Both colors now fall back to
`images.<component>.tag`, and what is rejected is the condition that actually makes a preview
pointless: the two resolving to the same image.

## Consequences

**Two versions of the API now run against one database.** Blue/green and canary both mean the old and
new schema-consumers are live simultaneously, so **every migration carried by a progressively
delivered release must be backward compatible with the version still serving** — expand/contract:
add columns, backfill, and only drop in a later release. This is the real cost of the feature and it
is not enforced by the chart; it is a review obligation on any PR that adds a migration.

Concurrent migrations themselves are safe: `migrate()` takes a database-wide advisory lock
(`packages/persistence/src/pg/migrate.ts`), so the second color's init container waits and then finds
nothing to apply.

**Blue/green doubles the cost of the HTTP tier** while both colors are up. That is inherent, not an
implementation artifact.

**Switching strategy on a live release replaces Deployments, by design.** A Deployment's
`spec.selector` is immutable in `apps/v1`, and each strategy puts different variant labels in it — so
a strategy switch that kept the same Deployment name would try to mutate an immutable field and
Kubernetes would reject the upgrade outright. Every strategy therefore owns a distinct set of names
(`…-api`, `…-api-blue`/`-green`, `…-api-stable`/`-canary`), which turns each switch into a delete and
create. That is why the canary's stable track is `…-api-stable` rather than reusing the unsuffixed
name: the shorter name would have made `rolling` → `canary` un-upgradable. Do the switch during a
window, or install with the strategy already chosen. Flips *within* blue/green have no such effect,
and neither does changing a canary weight.

**`kubeconform` cannot see any of this.** Schema validity says nothing about which pods a selector
matches. The properties above are asserted in `scripts/helm-snapshot-test.sh` — 32 new assertions,
including the flip-invariance check that found the standby-capacity defect, the name-disjointness
check that keeps strategy switches upgradable, and a regression guard that the web upstream is the
release-prefixed Service name and never `api:8080` again.
