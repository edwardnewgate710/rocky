# تقرير مراجعة مستودع Gambit / Chess

**المستودع:** `hessiun710/chess`
**النسخة التي تمت مراجعتها:** `47f8f79ea14d2e6e5f3df92e2e964e34032f7b16` (`origin/main`)
**تاريخ المراجعة:** 2026-07-17
**نوع المراجعة:** بناء، TypeScript، اختبارات، تدقيق اعتماديات، ومراجعة يدوية للأمان والمنطق والإنتاج وCI.

## الخلاصة التنفيذية

البناء وTypeScript والاختبارات الجذرية نجحت، كما لم يعثر `npm audit` على ثغرات معروفة في الاعتماديات المثبتة. لكن المراجعة اليدوية كشفت عيوبًا لا تغطيها الاختبارات الحالية، منها ثلاث مشكلات حرجة:

1. رسالة WebSocket مصاغة بشكل خبيث يمكنها إسقاط عملية الـgateway.
2. Helm ينشئ افتراضيًا سر HMAC معروفًا علنًا، ما يسمح بتزوير access tokens—including دور `admin`—إذا نُشر القالب دون override.
3. مسار الإنتاج للبطولات يستخدم `InMemoryGameLauncher` لا ينشئ مباراة حقيقية؛ مع نسختين من API يفقد كذلك خاصية idempotency بين النسخ.

**التقييم العام:** غير جاهز لنشر إنتاجي عام قبل إغلاق P0 وP1.

## نتائج التحقق الآلي

| الفحص | النتيجة |
|---|---|
| `npm ci` في الجذر | نجح؛ 0 vulnerabilities |
| `npm run build` | نجح لكل الـworkspaces |
| `npm run lint` | نجح؛ TypeScript بلا أخطاء |
| `npm test` | نجح بلا فشل في اختبارات الجذر |
| gateway: build + lint + test | نجح، لكن اختبارات Redis الأربعة كلها متخطاة |
| PostgreSQL integration | 5 اختبارات متخطاة لأن `DATABASE_URL` غير متاح |
| اختبارات LLM الحقيقية | متخطاة لغياب المفاتيح/علامة integration |
| `npm audit` | 0 vulnerabilities في الجذر وفي gateway |
| Playwright/Lighthouse محليًا | لم يُشغلا؛ Docker daemon غير متاح، ومتصفح Playwright غير مُثبت محليًا |
| `npm run test:counts` | فشل بسبب عيب في السكربت نفسه؛ موثق أدناه |

> ملاحظة: تعذر فحص الحالة الفعلية لـGitHub Actions؛ تطبيق GitHub المتصل أعاد 404 للمستودع، وGitHub CLI (`gh`) غير مثبت. لذلك لا ينبغي تفسير نجاح الفحوصات المحلية على أنه تأكيد أن آخر Actions run أخضر.

## P0 — أخطاء حرجة

### P0-1: إسقاط gateway برسالة WebSocket غير صحيحة

**الدليل:**

- `packages/realtime-gateway/src/protocol.ts:298-318` يتحقق من الحقل `t` فقط ثم يعمل cast لكامل الجسم إلى `ClientMessage` دون التحقق من `gameId` أو `token` أو `clientSeq` أو أنواعها.
- `services/gateway/src/serve.ts:187-189` يمرر الناتج مباشرة إلى المعالج.
- `packages/realtime-gateway/src/gateway.ts:90-94` لا يضع `try/catch` حول معالج الرسالة.
- `packages/realtime-gateway/src/gateway.ts:137-160` يمرر `token` إلى verifier.
- `packages/api/src/auth/tokens.ts:91-93` يستدعي `token.split('.')` على افتراض أنه string.

**سيناريو:** بعد أن تصبح لعبة معروفة resident في authority، يرسل عميل غير مصادق:

```json
{"t":"join","gameId":"<valid-game-id>","token":{}}
```

يمر `decode`، ثم يصل object إلى `token.split` وينتج `TypeError` متزامن خارج أي catch. في Node يمكن لهذا الاستثناء غير المعالج إنهاء العملية، أي DoS عن بعد قبل المصادقة.

**الإصلاح:** تطبيق schema validation كامل لكل message variant (يدويًا أو بـZod/Ajv)، إحاطة callback الأعلى بـ`try/catch`، إغلاق الاتصال بكود 1008 على الرسائل غير الصحيحة، وإضافة اختبار integration يرسل أنواعًا خاطئة لكل حقل.

### P0-2: سر توقيع access token معروف افتراضيًا في Helm

**الدليل:**

- `deploy/helm/gambit/values.yaml:150-154` يترك السر فارغًا.
- `deploy/helm/gambit/templates/secret.yaml:20` يستبدله تلقائيًا بالقيمة العامة `dev-secret-change-me-in-production-at-least-32-bytes!!`.
- `packages/api/src/auth/tokens.ts:21-30` يضع الأدوار داخل token.
- `packages/api/src/http/router.ts:180-182` يثق بالأدوار الموقعة لتنفيذ authorization.

**الأثر:** أي شخص يعرف المستودع يستطيع توقيع HS256 token يتضمن `roles:["admin"]` والوصول لمسارات الإدارة إذا تم نشر Helm بالقيم الافتراضية. القيمة تتجاوز شرط 32 byte، لذلك التطبيق لن يرفضها عند startup.

**الإصلاح:** استخدام `required` في Helm وعدم إنشاء Secret افتراضي معروف، أو قبول `existingSecret` فقط في production. أضف CI test يؤكد أن `helm template` يفشل عند غياب السر، مع secret عشوائي منفصل لبيئات التطوير.

### P0-3: مباريات البطولات في الإنتاج لا تُنشأ فعليًا

**الدليل:**

- `packages/api/src/bootstrap.ts:115-127` يختار افتراضيًا `new InMemoryGameLauncher(ids)` وlive view فارغًا في production bootstrap.
- `packages/api/src/tournament/launcher.ts:41-56` لا ينشئ حدث `GameCreated` ولا يكتب إلى event store؛ يولد ID ويحفظه في `Map` داخل العملية فقط.
- الـlauncher الوحيد الذي ينشئ لعبة حقيقية هو `packages/e2e-harness/src/launcher.ts`، وهو خاص بالـE2E وليس production.
- `deploy/helm/gambit/values.yaml:44` يشغل نسختين من API افتراضيًا؛ كل نسخة لديها `Map` مختلف.

**الأثر:** tournament snapshot قد يرتبط بـgameId غير موجود في gateway أو event store، وبالتالي تكون المباراة غير قابلة للانضمام أو اللعب. عند retry على pod آخر قد يولَّد gameId ثانٍ لنفس `(tournamentId, matchId, attempt)`، مخالفًا لعقد idempotency الموثق في `launcher.ts:21-30`.

**الإصلاح:** إنشاء adapter إنتاجي durable ينشئ اللعبة ويفرض unique key على `(tournament_id, match_id, attempt)` داخل PostgreSQL transaction، ثم حقنه إجباريًا في production bootstrap. لا تسمح بالـin-memory fallback عندما `NODE_ENV=production`.

## P1 — أخطاء عالية الخطورة

### P1-1: سباق في تدوير refresh token يسمح بنجاح استعماله مرتين

**الدليل:** `packages/api/src/auth/service.ts:133-160` ينفذ: قراءة session، فحص `revokedAt`، إنشاء child session، ثم revoke للأصل. `packages/persistence/src/pg/repositories.ts:268-284` ينفذ القراءة والإلغاء باستعلامات مستقلة، بلا transaction أو row lock أو conditional update.

**الأثر:** طلبا refresh متزامنان لنفس token يمكنهما رؤية الأصل غير ملغى، وإنشاء childين صالحين، ثم ينجح كلاهما. هذا يكسر single-use/theft detection، وهو مهم خصوصًا عند سباق مهاجم مع المستخدم أو refresh من تبويبين.

**الإصلاح:** عملية ذرّية واحدة في repository: transaction + `SELECT ... FOR UPDATE` أو `UPDATE ... WHERE revoked_at IS NULL RETURNING ...`، وإنشاء child وربط rotation داخل نفس transaction. يجب أن ينجح فائز واحد فقط.

### P1-2: التسجيل غير ذري ويمكن أن يترك حسابًا نصف مُنشأ

**الدليل:** `packages/api/src/auth/service.ts:90-105` ينفذ `findByHandle → create user → setPassword → addRole → startSession → audit` كعمليات مستقلة. `packages/persistence/src/pg/repositories.ts:180-186` لا يحوّل unique violation إلى 409.

**الأثر:** فشل مؤقت بعد إنشاء user قد يترك handle محجوزًا بلا credential/role/session، ثم أي retry يعيد 409. طلبا تسجيل متزامنان لنفس handle يؤدي أحدهما غالبًا إلى PostgreSQL unique error يُرجع 500 بدل 409.

**الإصلاح:** transaction واحدة لإنشاء user/credential/role، مع mapping صريح لـPostgres `23505` إلى conflict. يمكن جعل إنشاء session/audit جزءًا من نفس transaction أو اعتماد outbox/تعويض واضح.

### P1-3: `REDIS_URL`—بما فيه كلمة المرور—يُكتب كاملًا في السجل

**الدليل:** `services/gateway/src/serve.ts:106-112` يطبع `url=${redisUrl}`.

**الأثر:** URL شائع أن يحتوي `redis://user:password@host`. سيظهر السر في stdout، log aggregation، وincident exports.

**الإصلاح:** لا تسجل URL، أو سجل host/port فقط بعد parsing مع حذف username/password/query.

### P1-4: WebSocket بلا حد آمن للـpayload أو rate/connections limits

**الدليل:** `services/gateway/src/serve.ts:178` ينشئ `WebSocketServer({port,host})` دون `maxPayload` أو origin policy، و`serve.ts:187-189` يحول frame كاملًا إلى string ثم `JSON.parse`. الانضمام كمشاهد مجهول مسموح.

**الأثر:** القيمة الافتراضية لمكتبة `ws` كبيرة جدًا مقارنة بحجم رسائل الشطرنج؛ اتصالات مجهولة متزامنة ورسائل JSON ضخمة يمكن أن تستهلك الذاكرة وCPU. لا توجد مهلة join ولا heartbeat server-side ولا سقف rooms لكل connection.

**الإصلاح:** `maxPayload` صغير (مثل 16–64 KiB)، connection/message rate limiting، idle/join timeout، heartbeat terminate، سقف memberships، والتحقق من Origin عند استخدام browser clients.

### P1-5: حماية brute force قابلة للتجاوز بالـcase وبالتوسع الأفقي

**الدليل:**

- `packages/api/src/routes.ts:147-159` يبني `login:handle:${handle}` دون lowercase، بينما عمود handle هو `CITEXT` في `packages/persistence/migrations/0001_init.sql:81-84`؛ `Alice` و`ALICE` حساب واحد لكن buckets مختلفة.
- `packages/api/src/bootstrap.ts:114` يستخدم `InMemoryRateLimiter` في الإنتاج.
- `deploy/helm/gambit/values.yaml:44` يشغل API replicas=2 افتراضيًا.

**الأثر:** تغيير حالة الأحرف يتجاوز الحد per-handle. ومع كل pod توجد عدادات منفصلة، فيتضاعف الحد مع replicas ويمكن تجاوزه عبر توزيع الطلبات.

**الإصلاح:** canonicalize handle قبل بناء المفتاح، واستخدام Redis/قاعدة مشتركة بعملية ذرية، مع اختبارات multi-instance وحالات أحرف مختلفة.

### P1-6: cache الذكاء الاصطناعي يستخدم hash ‏32-bit قابلًا للتصادم

**الدليل:** `packages/ai-orchestrator/src/cache.ts:35-42` يستخدم FNV-1a 32-bit للرسائل، ثم `cache.ts:46-60` يخزن hash فقط في المفتاح.

**الأثر:** 32-bit ليس collision-resistant؛ تصادم طبيعي يصبح مرجحًا قرب عشرات الآلاف من المدخلات، ويمكن صنع تصادم متعمد. قد يحصل مستخدم على response خاص بطلب مختلف/مستخدم آخر، ما يسبب تسريبًا منطقيًا ونتائج خاطئة.

**الإصلاح:** SHA-256 على serialization canonical، أو المفتاح الكامل إذا كان cache محليًا، مع namespace للtenant/user عندما تكون الاستجابة شخصية.

### P1-7: العرض الحي للبطولات stub دائمًا في production

**الدليل:** `packages/api/src/bootstrap.ts:127` يحقن `{ activeGames: () => [] }`. التطبيق الحقيقي الوحيد `TournamentBroadcaster` موجود في `packages/e2e-harness/src/broadcaster.ts`.

**الأثر:** endpoint/live tournament payload يعرض قائمة ألعاب فارغة في الإنتاج حتى عند وجود مباريات نشطة.

**الإصلاح:** adapter إنتاجي يقرأ الحالة الحية من gateway/event store أو Redis، ويكون مطلوبًا عند تفعيل البطولات.

## P2 — أخطاء متوسطة

### P2-1: cache key لا يشمل خصائص تغيّر شكل/موفّر الاستجابة

`packages/ai-orchestrator/src/cache.ts:46-60` يهمل `structured`, `schema`, `providerPreference`, و`modality`. نفس الرسائل قد تعيد response عاديًا لطلب structured أو response من provider مخالف للتفضيل. أضف كل المدخلات الدلالية إلى المفتاح واختبارات تعاقب normal/structured.

### P2-2: timeout للـAI لا يلغي الطلب الأصلي

`packages/ai-orchestrator/src/orchestrator.ts:264-269` يبدأ promise، ثم `withTimeout` في `291-308` يعمل `Promise.race` فقط. بعد timeout يستمر fetch ويستهلك موارد/تكلفة، بينما failover قد يرسل الطلب ذاته إلى provider ثانٍ. استخدم `AbortController` مركبًا ومرر signal الناتج قبل بدء provider call.

### P2-3: استعادة الواجهة تثق بهوية localStorage بدل نتيجة refresh

`packages/web/src/app/auth-controller.ts:117-125` يستدعي refresh لكنه يتجاهل `result.user` ويعيد `handle/userId` من localStorage. إذا كانت القيمة قديمة أو معدلة، يصبح token لمستخدم B بينما UI تعتقد أنه A. استخدم هوية response الموقعة من الخادم ثم حدّث التخزين.

### P2-4: readiness endpoints لا تختبر الاعتماديات

- API `/v1/health` في `packages/api/src/routes.ts:83-87` يعيد `ok` ثابتًا دون PostgreSQL.
- gateway `/health` في `services/gateway/src/serve.ts:159-170` يعيد 200 دون ping لـRedis/PostgreSQL.
- Helm يستخدم نفس المسارات كـreadiness في `templates/api.yaml:119-125` و`templates/gateway.yaml:155-161`.

ستبقى pods Ready وتستقبل traffic أثناء انقطاع قاعدة البيانات أو Redis. افصل liveness عن readiness وأضف checks قصيرة بمهلات واضحة.

### P2-5: `healthPort` في Helm مستقل، بينما التطبيق يفرض `PORT+1`

`services/gateway/src/serve.ts:205-208` يستمع على `port + 1`. في المقابل `values.yaml:65-66` يعرّف `gateway.port` و`gateway.healthPort` مستقلين، والقالب يستخدم الثاني في `templates/gateway.yaml:78-81`. أي override لا يحافظ على العلاقة يكسر probes. اجعل التطبيق يقبل `HEALTH_PORT` أو احسبه في template مع validation.

### P2-6: صور Helm تستخدم `latest` مع `IfNotPresent`

`deploy/helm/gambit/values.yaml:27-40` يستخدم `latest` و`IfNotPresent` لكل الصور. قد تشغل عقد مختلفة صورًا مختلفة أو قد لا تسحب النسخة الجديدة عند rollout. استخدم digest أو immutable semver/SHA tags؛ لا تجمع mutable tag مع `IfNotPresent`.

### P2-7: بوابة Lighthouse تفشل بشكل مفتوح

`.github/workflows/ci.yml:217-250` يحول فشل Lighthouse أو غياب score إلى warning ثم `exit 0`. بالتالي job باسم acceptance قد يصبح أخضر دون تنفيذ accessibility gate. افصل فشل البنية التحتية كفشل قابل لإعادة التشغيل، لكن لا تعتبره نجاحًا.

### P2-8: body أكبر من الحد يُوقَف ولا يُصرَّف

`packages/api/src/http/body.ts:30-40` يستدعي `req.pause()` ثم يزيل listeners ويرفض، رغم أن التعليق يقول إنه سيصرف بقية الجسم. هذا يمكن أن يترك اتصال keep-alive مع body غير مقروء ويزيد قابلية connection-exhaustion. إما `req.resume()` للتصريف مع حد/مهلة أو أرسل `Connection: close` ودمّر الطلب بأمان بعد 413.

### P2-9: خريطة rate limiter للـAI تنمو بلا eviction

`packages/ai-orchestrator/src/rate-limiter.ts:21` يحتفظ bucket لكل `userId`، و`35-60` لا يحذف المستخدمين القدامى. تدفق IDs كثيرة يسبب نموًا غير محدود. أضف TTL/sweep أو store مشتركًا محدودًا.

## P3 — أخطاء منخفضة/أدوات

### P3-1: path parameter ذو percent encoding غير صالح يُرجع 500

`packages/api/src/http/router.ts:117-119` يستدعي `decodeURIComponent` مباشرة. قيمة مثل `%` ترمي `URIError` وتصل إلى مسار internal 500 بدل 400. التقط `URIError` وأعد bad request.

### P3-2: `npm run test:counts` معطّل

`scripts/test-counts.mjs:16` يبحث عن `packages/core` بينما اسم الحزمة الفعلي `packages/chess-core`. وفي `33-36` يستخدم أوامر POSIX (`/dev/null`, `find`, command substitution, `grep`) عبر `execSync`، لذلك يفشل على Windows. كذلك `npm run build` وحده لا ينشئ `dist-test` كما يدعي التعليق. استخدم Node filesystem/test runner APIs أو نفذ npm scripts مباشرة دون shell-specific pipelines.

### P3-3: runtime images تنقل dev dependencies والمصدر الكامل

`Dockerfile.api:24-28` و`Dockerfile.gateway:28-31` ينسخان `node_modules` وجميع packages من builder بعد `npm ci` الكامل. هذا يزيد حجم الصورة وسطح الهجوم ويضم ملفات test/source غير لازمة. نفّذ production prune أو output bundle/minimal workspace copy.

## فجوات التحقق المتبقية

1. لم يمكن قراءة GitHub Actions runs/logs بسبب صلاحية GitHub app وغياب `gh`.
2. اختبارات PostgreSQL وRedis الحقيقية لم تُشغل محليًا لأن Docker daemon غير متاح؛ وهي بالذات تغطي مسارات concurrency/ownership الأعلى خطورة.
3. Playwright E2E وLighthouse لم يُشغلا محليًا.
4. اختبارات OpenAI/Anthropic الحقيقية متخطاة؛ لم يتم إرسال أي بيانات أو طلبات خارجية.
5. المراجعة لا تدّعي إثبات غياب أخطاء أخرى؛ البنود أعلاه هي الأخطاء المؤكدة أو القابلة للإثبات من النسخة المحددة.

## ترتيب الإصلاح المقترح

1. أغلق P0-1 وP0-2 فورًا قبل أي نشر عام.
2. استبدل production tournament stubs وأضف transaction/idempotency durable.
3. اجعل refresh rotation ذرية وسجّل test لتزامن طلبين.
4. أصلح rate limiting المشترك وتطبيع handle.
5. ضع حدودًا صارمة على WebSocket وأضف fuzz/property tests للـdecoder.
6. أصلح AI cache hashing/key semantics وإلغاء الطلبات عند timeout.
7. اجعل readiness وCI gates fail-closed، ثم شغّل PostgreSQL/Redis/Playwright في بيئة CI قابلة للمشاهدة.
