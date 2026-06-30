# AI LEGAL ARMENIA — Архитектурный аудит как юридической экспертной системы

**Дата:** 2026-06-28
**Объект:** D:\1V\ailegalarmenia-main (Supabase project `avmgtsonawtzebvazgcr`)
**Фокус:** не «работает ли RAG-чат», а «является ли система профессиональной юридической экспертной системой РА».
**Метод:** чтение исходного кода (frontend, edge functions, migrations, prompts, RAG-модули). Каждое утверждение привязано к файлу/строке. Где подтверждения нет — указано «не найдено в проекте».

---

## ЭТАП 1. Что изучено (ключевые файлы)

| Слой | Ключевые файлы |
|---|---|
| Chat-пайплайн | `supabase/functions/legal-chat/index.ts` (524 стр.) |
| Анализ по ролям | `supabase/functions/ai-analyze/index.ts` (1410 стр.) + `ai-analyze/prompts/*` (21 промт) |
| Мульти-агент | `supabase/functions/multi-agent-analyze/index.ts` (1124 стр., 9 агентов) |
| Retrieval | `supabase/functions/vector-search/index.ts`, `_shared/rag-search.ts` (667 стр.) |
| Гибридный поиск (БД) | `migrations/20260627030000_baseline_live_dual_rpc_and_indexes.sql` (RPC `search_legal_corpus_dual`) |
| Генерация документов | `generate-document/` (prompts: criminal/civil/administrative/echr/general/fallback/role), `generate-complaint/` |
| Промты | `legal-chat` inline, `multi-agent` inline, `ai-analyze/prompts/index.ts`+`system.ts`, `src/data/initialPrompts.ts` (517 стр.), документация `ALL_PROMPTS.md`/`SYSTEM_PROMPTS.md` |
| Ingestion | `_shared/chunker.ts` (2258 стр.), `embeddings-generate`, `practice-*` воркеры, `pipeline-tick`, `kb-import/scrape`, `ocr-process`, `_shared/table-extractor.ts` |
| Безопасность | `_shared/prompt-armor.ts`, `_shared/edge-security.ts`, `_shared/pii-redactor.ts`, `_shared/rate-limiter.ts` |
| Прочее | 52 edge functions, 204 миграции, `app`-схема с RLS (per-case) |

Не разбирались построчно (но идентифицированы): админ-функции, telegram-webhook, audio-transcribe, dictionary-*, export-data — они не относятся к юридическому ядру.

---

## ЭТАП 2. Фактическая архитектура

```
React/Vite SPA  ──hooks──►  Supabase Edge Functions (Deno) ──►  Postgres (public/app/internal) + pgvector
   │  useAIAnalysis            legal-chat ───┐                       search_chunks ~1.49M
   │  useMultiAgentAnalysis    ai-analyze ───┼─► _shared/rag-search ─► vector-search ─► RPC search_legal_corpus_dual
   │  useKnowledgeBase         multi-agent ──┘        │                                   (metric ANN + BM25, RRF)
   │  LegalChatBot             generate-document      │                                   embeddings vector(1024)
   │  MultiAgentPanel          generate-complaint     └─► openai-router (OpenRouter/OpenAI gateway)
   │                           + 45 прочих fn
   └─ ingestion: chunker → embeddings-generate → practice-* workers → pipeline-tick
                                                  │
                                       внешний VPS embedding endpoint (EMBEDDING_ENDPOINT)
```

Ключевое наблюдение по топологии: **существуют три независимые «поверхности ответа»** — `legal-chat` (стриминговый чат), `ai-analyze` (анализ кейса по 15+ ролям/модулям), `multi-agent-analyze` (9 специализированных агентов) — каждая со своим промтом, своей логикой грунтинга и **разным уровнем зрелости**. Оркестрация между шагами выполняется не сервером, а клиентом и состоянием БД (`agent_analysis_runs`).

Безопасность зрелая: auth-guard на каждой функции, rate-limiter, prompt-armor (анти-инъекции + sandbox блоков `RAG_*`/`USER_MESSAGE`), PII-редактор (fail-closed), RLS per-case в `app` (подтверждено в памяти проекта).

Embeddings: единый рабочий путь — `armenian-text-embeddings-2-large` (1024-dim, IVFFlat partial index lists=900). Запросный вектор берётся с внешнего VPS (`vector-search/index.ts:203 embedMetricQuery`). При недоступном/неправильном `EMBEDDING_ENDPOINT` семантика **тихо деградирует в BM25** (есть детектор нероутируемого URL `:199 isUnroutableEndpoint`, телеметрия `semantic_ok`).

---

## ЭТАП 3. Юридическая логика (по пунктам)

Легенда: ✅ реализовано · 🟡 частично · ❌ отсутствует.

| # | Способность | Статус | Где / почему |
|---|---|---|---|
| Юрисдикция РА | 🟡 | Только промтом (`legal-chat/index.ts:30`, `multi-agent:26`), не кодом. Система моно-юрисдикционна, фильтра по jurisdiction нет (его и не нужно), но «отказ от не-РА вопросов» держится исключительно на дисциплине модели. |
| Отрасль права (case_type) | ✅/🟡 | `case_type` управляет allowlist категорий (`ai-analyze:60 getCategoryAllowlist`) и STOP-условием у агентов (`multi-agent:29`). Но определяется не системой, а вводом пользователя; авто-классификации спора нет. |
| Предмет спора | ❌ | Нет модуля issue-spotting. Запрос идёт как есть в RAG. |
| Факты ↔ правовые вопросы | 🟡 | Промт-мандат («LEGAL LOGIC A–E» `legal-chat:84`; роли агентов). Кодом не верифицируется. |
| Выбор применимого закона | 🟡 | RAG + allowlist + извлечение якорей норм (`ai-analyze:667 extractNormRefs` → `lookupByAnchors`). В `ai-analyze` — прилично; в `legal-chat`/`multi-agent` — только семантика. |
| Проверка редакции / действие во времени | 🟡 | RPC фильтрует `effective_from/effective_to` vs `p_effective_at` **только в dense-арме** (`metric_candidates`); BM25-арм и qwen-арм даты НЕ фильтруют. Так как семантика часто выключена → BM25 fallback → темпоральная фильтрация фактически обходится. `is_current=true` оставляет только текущую версию. Есть `temporalDisclaimer`/`temporal_warning`/`strict_temporal` (`legal-chat:288`, `ai-analyze:388`). |
| Иерархия источников | 🟡 | `authorityRank()` (`ai-analyze:75`): Конституция 100 > ЕКПЧ 95 > кодексы 85 > законы 75 > кассация 70 > практика 65 > правительство/муниципальные 55 > подзаконные 45. **Только в `ai-analyze`.** В `legal-chat` и `multi-agent` ранжирования по юр.силе нет; RPC ранжирует RRF-скором, без учёта силы источника. |
| lex specialis | ❌ | Не найдено в проекте. |
| lex posterior | ❌ | Не найдено (есть только `norm_status='active'` отсечение замещённых версий и `is_current`). |
| Конституция РА | 🟡 | Категория `constitution` существует и имеет высший ранг; отдельной обработки нет. |
| Кодексы и законы РА | ✅ | Основной корпус (arlis), типизация источника в RPC. |
| Подзаконные акты | 🟡 | Только как строка категории в `authorityRank`; отдельной типизации в корпусе не подтверждено. |
| Решения Правительства | 🟡 | Аналогично — ветка ранга есть, типизации корпуса нет. |
| Решения мэрии Еревана / Совета старейшин | ❌ | Ветка `municipal` в `authorityRank` есть, но в типизации корпуса (`echr/venice/arlis/armenian_legal`) муниципальные акты не выделены. Не найдено. |
| Практика Конституционного суда | ❌ | Отдельной обработки/типа не найдено. |
| Практика Кассационного суда | 🟡 | Через `content_domain='practice'`; промты маркируют BINDING. Но семантика практики тоже зависит от dense-арма. |
| Практика Апелляционных судов | ❌ | Отдельно не выделена. |
| Практика ЕСПЧ | 🟡 | Корпус ~162k ECHR (qwen), но **семантический ECHR-арм отключён жёстко** (`vector-search:77 qwenEmbedding=null`, `p_qwen_limit=0`). ЕСПЧ обслуживается только BM25/FTS. |
| Венецианская комиссия | 🟡 | Типизация `venice:` в корпусе есть (RPC), отдельной логики применения нет. |
| Анализ доказательств | ✅ | `evidence_collector` + `evidence_admissibility` (multi-agent), `evidence`/`evidence-weakness` (ai-analyze). |
| Процессуальные нарушения | ✅ | `procedural_violations` агент + `procedural.ts`. |
| Материальное право | ✅ | `substantive_violations` агент + `substantive.ts`. |
| Юридическая аргументация | ✅/🟡 | `defense_strategy`, `prosecution_weaknesses`, `strategy-builder`, `cross-exam`. Сильная промт-структура, но в single-file/synthesis-режимах `multi-agent` **RAG не вызывается вообще** → нормы не верифицируются. |
| Мотивированный вывод | 🟡 | `aggregator` синтезирует, но «без новых ссылок»; вывод = сумма ролей, не отдельный reasoned-conclusion слой. |
| Риски и альтернативные позиции | ✅/🟡 | `risk-factors`, `legal-position-comparator`. Контр-аргументация как обязательный шаг пайплайна не закреплена. |

**Главная опасность по этапу 3:** методология «правового мышления» задана **в промтах, а не в коде**. Там, где код её поддерживает (anchor-lookup, authorityRank, citation-guard, temporal) — это `ai-analyze`. Две другие поверхности (`legal-chat`, `multi-agent`) работают по принципу «retrieve → перескажи и процитируй», а в части режимов `multi-agent` — даже без retrieval.

---

## ЭТАП 4. База знаний и источники

Что архитектура **умеет**:
- различать `content_domain` (`knowledge_base` / `practice`) и `source` (`echr` / `venice` / `arlis` / `armenian_legal`) — RPC `metric_candidates`/`bm25_candidates`;
- отсекать недействующие версии: `norm_status='active'` + `document_versions.is_current=true`;
- учитывать даты вступления/утраты силы (`effective_from/to`) — **но только в dense-арме**;
- дедуплицировать по `chunk_id` (RRF `best`), не смешивать KB/practice (фильтр `content_domain`).

Что **не умеет** (не найдено в проекте):
- ранжировать источники по юридической силе **на уровне retrieval** (сила учитывается лишь пост-фактум и лишь в `ai-analyze`);
- связывать норму ↔ судебную практику, закон ↔ подзаконный акт, муниципальный акт ↔ закон;
- проверять релевантность/точность цитаты: citation-guard проверяет лишь **существование `document_id`** в таблице `documents` (`ai-analyze:1351`), но не то, что норма/цитата реально содержится в этом документе;
- отделять обязательные источники от вспомогательных как формальный атрибут.

⚠️ **Дефект**: в `multi-agent-analyze:1066-1072` citation-guard обращается к таблицам `"unified corpus knowledge records"` (с пробелами!) и `legal_documents`, которых в реальной схеме нет (реальные — `documents`/`search_chunks`, см. RPC и `live_schema_public.sql`). Следствие: guard всегда падает в `verification_query_failed` → проверка цитат у мульти-агента де-факто не работает. В `ai-analyze` это уже исправлено на `documents`. Те же строки-плейсхолдеры «unified corpus …» разбросаны по промтам `generate-document`/`generate-complaint` как инструкции модели — безвредно, но это след незавершённого переименования.

---

## ЭТАП 5. RAG и поиск

**Ядро (БД, RPC `search_legal_corpus_dual`):** материализованные CTE → `metric_ann` (dense, armenian-text-embeddings-2-large) + `bm25_candidates` (FTS `websearch_to_tsquery('simple')`, `ts_rank_cd`) → объединение → **Reciprocal Rank Fusion** (`rrf_score = Σ 1/(60+rank)`) → top-N. Это настоящий гибрид dense+lexical.

| Возможность | Статус |
|---|---|
| dense search | ✅ (IVFFlat, lists=900) |
| BM25/FTS | ✅ (tsvector `fts_vector`) |
| hybrid (fusion) | ✅ (RRF) |
| rerank | ❌ (явно `@deprecated`, AI-reranker отсутствует) |
| query expansion | ❌ |
| legal query decomposition | ❌ |
| фильтр по source_type | 🟡 (через `content_domain`, не по source) |
| фильтр по дате/актуальности | 🟡 (только dense-арм) |
| действующая редакция | 🟡 (`is_current` + `norm_status`) |
| дедупликация | ✅ |
| keyword/ILIKE и case-number ветки в `rag-search.ts` | ❌ **мёртвый код**: `keywordPromise`/`caseNumberPromise = Promise.resolve([])` (`rag-search.ts:270,354,355`) — комментарии обещают «hybrid + case-number boost», но они закорочены; весь гибрид фактически делает только RPC |
| source confidence | 🟡 (`vector_score`/`fts_score`/`rrf` есть, но не выражены как доверие) |
| citation grounding | 🟡 (ID-existence; `ai-analyze` ок, `multi-agent` сломан) |
| hallucination guard | 🟡 (`hallucination-audit` промт/роль в `ai-analyze`; citation-guard) |

Отдельно:
- **Армянские эмбеддинги**: специализированная модель — сильное решение для языка.
- **ЕСПЧ**: семантика мертва (qwen отключён) → только BM25 по en/fr.
- **Венеция/таблицы/PDF**: `table-extractor.ts`, `docx-parser.ts`, `ocr-process` есть; чанкер крупный (2258 стр.).
- **Риск деградации**: при неверном `EMBEDDING_ENDPOINT` система молча уходит в BM25-only (детектор и телеметрия есть, но это рантайм-конфиг, не гарантия).

---

## ЭТАП 6. Prompt System

**Единого Legal Core нет.** Минимум 5 независимых «ядер»:
1. `legal-chat` — `LEGAL_AI_SYSTEM_PROMPT` (inline, ~190 строк, методология A–E, citation-rules);
2. `multi-agent` — `BASE_HEADER` + 9 агентских промтов (inline);
3. `ai-analyze` — `system.ts BASE_SYSTEM_PROMPT` + реестр `prompts/index.ts` (~21 файл: defense/prosecution/judge/aggregator/evidence/procedural/substantive/rights/qualification + precedent-citation/deadline-rules/hallucination-audit/strategy-builder/evidence-weakness/risk-factors/law-update/cross-exam/legal-position-comparator);
4. `generate-document` — матрица system × role × jurisdiction (`prompts/criminal|civil|administrative|echr|general|fallback|role-prompts`);
5. `generate-complaint` — собственный `system-prompt.ts`.

Плюс `src/data/initialPrompts.ts` (517 стр., сид БД) и документация `ALL_PROMPTS.md`/`SYSTEM_PROMPTS*.md` — **дублируют** промты в третьем месте (риск дрейфа).

Оценка по требованиям этапа:
1. Единый Legal Core — ❌. 2. Единая методология — 🟡 (есть локально, не общая). 3. Конфликтующие роли — 🟡 (адвокат/прокурор/судья намеренно противоположны — это ок, но нет арбитра поверх). 4. Дублирование — ✅ выявлено (5 кодовых ядер + 2 набора документации). 5–7. Нарушение последовательности / «пересказ» / отсутствие правового мышления — ❌ риск высок в `multi-agent` без RAG и в `legal-chat`. 8–9. Проверка источников/актуальности — 🟡 (есть в `ai-analyze`). 10. Обязательная структура вывода — ✅ (JSON-схемы у агентов и structured-ролей).

Категоризация и рекомендация (детали в разделе 12): объединить (1)+(2)+(3) под один **Legal Core**; `Citation Verification` и `Risk` оставить специализированными; документационные дубли (`ALL_PROMPTS.md` и пр.) сделать **генерируемыми** из кода, а не ручными.

---

## ЭТАП 7. Архитектура принятия решений

Полноценного **legal-reasoning pipeline** (intake → clarify → issues → jurisdiction → domain → primary law → subordinate acts → practice → ECHR/Venice → hierarchy-validate → temporal-validate → apply → risks → counter-arguments → reasoned conclusion → citation-verify → answer) в системе **нет**.

Что есть на самом деле:
- `legal-chat`: **один** вызов LLM поверх dual-RAG. Шаги A–E — инструкция, не машина состояний.
- `ai-analyze`: ближе всего к reasoning — `extractNormRefs → lookupByAnchors → dualSearch → mergeAndDeduplicate(authorityRank) → role-prompt → citation-guard → temporal-warning`. Но это всё ещё **один** вызов на роль; clarify/lex-specialis/lex-posterior/контр-аргументы как шаги отсутствуют.
- `multi-agent`: 9 агентов как **отдельные stateless-вызовы**, последовательность задаёт **клиент** + таблица `agent_analysis_runs` (aggregator читает `previousRuns`). Это оркестрация состоянием, а не детерминированный движок; в single-file/synthesis-режимах RAG не вызывается.

**Вывод этапа:** система **retrieval-first**, а не **legal-reasoning-first**. `ai-analyze` — зачаток reasoning-движка, но не доведён до сквозного пайплайна и не распространён на остальные поверхности.

---

## ЭТАП 8. Архитектурный аудит (концептуальные проблемы)

- **Три расходящиеся поверхности ответа** с несовместимым уровнем грунтинга → один и тот же вопрос в чате, в анализе и в мульти-агенте даёт разное качество/иерархию/верификацию.
- **Темпоральная валидность негерметична**: дата фильтруется только в dense-арме; в самом частом (BM25-fallback) режиме — нет. Для юр.системы это критично (применение неактуальной редакции).
- **Грунтинг слабый**: citation-guard проверяет лишь существование ID, не соответствие цитаты; у `multi-agent` сломан (несуществующие таблицы).
- **ЕСПЧ-семантика мертва** при наличии 162k векторов — деньги/данные вложены, ценность не извлекается.
- **Мёртвый «гибрид» в `rag-search.ts`** (keyword/case-number закорочены) вводит в заблуждение и снижает recall по точным номерам дел/статьям.
- **Нет иерархического retrieval** (lex specialis/posterior, сила источника на уровне выборки) — ядро профессиональной правовой логики.
- **Нет issue-spotting / clarify-loop** — система не уточняет недостающие факты до анализа (только помечает DATA_GAP в ответе).
- **Prompt governance**: 5 кодовых ядер + 2 набора документации, ручная синхронизация → дрейф.
- **Дрейф миграций**: подтверждён самим репозиторием (baseline-миграция реконсилиации, `live_schema_public.sql` — плейсхолдер).
- **Observability**: есть `ai-metrics`/`rag-retrieval` телеметрия и `semantic_ok`, но нет сквозного трейсинга «какие источники → какой вывод» для аудита решения.
- **Масштабируемость/поддержка**: ingestion крупный и рабочий, но логика анализа размазана по функциям без общего ядра — дорого менять методологию.

---

## ЭТАП 9. ФИНАЛЬНЫЙ ОТЧЁТ

### 1. Executive Summary
AI Legal Armenia — это **технически зрелый, безопасный, юридически-тематический RAG-комплекс** с сильным каркасом специализированных промтов (9 агентов + ~21 роль/модуль), настоящим гибридным поиском (dense + BM25 + RRF) и **частичными** элементами экспертной системы (иерархия источников и anchor-lookup в `ai-analyze`, темпоральные предупреждения, citation-guard, hallucination-audit). Однако правовая методология держится преимущественно на промтах, а не на коде; ключевые механизмы профессиональной правовой логики (сквозной reasoning-пайплайн, иерархический и темпоральный retrieval во всех путях, связывание норм и практики, надёжный грунтинг, живой ЕСПЧ-семантический поиск) либо частичны, либо отсутствуют. **Готовность как «экспертной системы» — средняя; как продвинутого юридического RAG — высокая.**

### 2. Фактическая архитектура
См. этап 2. SPA → 52 edge-функции → Postgres+pgvector; ответ формируют три независимые поверхности; retrieval централизован в RPC `search_legal_corpus_dual`; эмбеддинги — внешний VPS.

### 3. Архитектура юридического анализа
См. этап 3/7. `ai-analyze`: anchor → dual-RAG → authority-ranked merge → role-prompt → citation/temporal. `legal-chat`: одношаговый RAG-ответ. `multi-agent`: 9 агентов, оркестрация клиентом/БД, частично без RAG. Иерархия и lex-правила реализованы фрагментарно.

### 4. Архитектура RAG
См. этап 5. Гибрид dense+BM25+RRF (✅), без rerank/expansion/decomposition (❌), темпоральный фильтр только dense (🟡), ECHR-семантика отключена (🟡), keyword/case-number ветки мертвы (❌), citation-grounding частичный (🟡).

### 5. Архитектура Prompt System
См. этап 6. Нет единого Core; 5 кодовых ядер + дублирующая документация; структура вывода (JSON-схемы) — сильная сторона.

### 6. Архитектура принятия решений
Retrieval-first, не reasoning-first. `ai-analyze` — ближайший прототип движка, не доведён до сквозного пайплайна и не унифицирован.

### 7. Сильные стороны
- Гибридный retrieval с RRF на уровне БД (`search_legal_corpus_dual`).
- Специализированная армянская embedding-модель (1024-dim) с IVFFlat.
- Зрелая безопасность: auth-guard, rate-limit, prompt-armor (sandbox + анти-инъекции), PII fail-closed, RLS per-case.
- Богатый, дисциплинированный набор промтов с обязательными JSON-схемами и STOP-условиями (анти-галлюцинация по дизайну).
- `ai-analyze`: `authorityRank` (иерархия), `lookupByAnchors` (точный поиск по статьям), citation-guard (исправный), temporal-warning/strict_temporal, allowlist по case_type.
- Телеметрия деградации семантики (`semantic_ok`), детектор нероутируемого endpoint.
- Honest-инжиниринг: дрейф и «известные дыры» (H1/H3) задокументированы в самих миграциях.

### 8. Критические проблемы (мешают профессиональному юр.качеству)
- **C1.** Нет сквозного legal-reasoning движка; методология — в промтах. (этап 7)
- **C2.** Темпоральная валидность негерметична: BM25/qwen-армы не фильтруют по дате; в fallback-режиме применяется потенциально неактуальная редакция. (RPC `bm25_candidates`)
- **C3.** Грунтинг недостаточен: citation-guard = только существование ID; у `multi-agent` сломан (таблицы `"unified corpus knowledge records"`/`legal_documents` не существуют). (`multi-agent:1066`)
- **C4.** Иерархия источников и lex specialis/posterior не реализованы на уровне retrieval и отсутствуют в `legal-chat`/`multi-agent`. (этап 4)
- **C5.** `multi-agent` single-file/synthesis работают **без RAG** — нормы и практика не верифицируются вопреки промтам. (`multi-agent:788-858, 728-785`)
- **C6.** ЕСПЧ-семантика отключена (qwen=null), 162k векторов простаивают; ЕСПЧ-практика только по BM25. (`vector-search:77`)

### 9. Средние проблемы
- **M1.** Мёртвый «гибрид» в `rag-search.ts` (keyword/case-number закорочены) → потеря recall по номерам дел/статьям. (`rag-search.ts:270,355`)
- **M2.** Нет rerank / query expansion / legal decomposition.
- **M3.** Prompt governance: 5 кодовых ядер + ручная документация → дрейф.
- **M4.** Зависимость семантики от рантайм-конфига `EMBEDDING_ENDPOINT` (тихая деградация).
- **M5.** Нет issue-spotting / clarify-loop до анализа.
- **M6.** Дрейф миграций/схемы (частично закрыт baseline-миграцией).
- **M7.** Муниципальные акты (мэрия Еревана/Совет старейшин), практика КС и апелляции отдельно не типизированы в корпусе.

### 10. Низкоприоритетные
- **L1.** Плейсхолдеры «unified corpus …» в промтах `generate-*` (косметика/чистка).
- **L2.** `live_schema_public.sql` — плейсхолдер (регенерировать дампом).
- **L3.** Устаревшие отчёты (`EMBEDDINGS_QUALITY_REPORT.md` — 1536-dim) помечены как stale, но лежат в корне.
- **L4.** Дублирование `formatPracticeContext`/rag-логики в `generate-document/rag-search.ts` и `generate-complaint/rag-search.ts`.

### 11. Приоритетность исправлений
- **P0 (критично):** C2 (темпоральный фильтр во все армы RPC), C3 (починить citation-guard мульти-агента + усилить до проверки совпадения цитаты), C5 (включить RAG в single-file/synthesis).
- **P1 (важно):** C1/C4 — вынести reasoning + иерархию/lex-правила в общий слой; C6 (включить ЕСПЧ-семантику: индекс qwen + запросный эмбеддинг); M1 (восстановить case-number/anchor-ветки).
- **P2 (желательно):** M2 (rerank/decomposition), M3 (единый Prompt Core + генерация документации), M5 (clarify-loop), M7 (типизация муниципальных/КС/апелляции).
- **P3 (позже):** M4/M6 (конфиг-гард, регенерация схемы), L1–L4.

### 12. План перехода RAG-чат → профессиональная Legal Expert System
- **Legal Core (Prompt Governance Layer):** единый методологический промт (факты→вопросы→юрисдикция→отрасль→нормы→практика→иерархия→время→применение→риски→контр-аргументы→вывод→цитаты); роли `legal-chat`/`multi-agent`/`ai-analyze` наследуют его; документация генерируется из кода.
- **Legal Reasoning Engine:** детерминированный сервер-оркестратор шагов (а не клиент): intake → clarify-loop → issue-spotting → retrieval по слоям → apply → risk/counter → reasoned conclusion. `ai-analyze` — стартовая база.
- **Source Hierarchy Engine:** ранжирование по юр.силе на уровне retrieval + lex specialis/posterior как правила, единый `authorityRank` для всех путей.
- **Temporal Validity Engine:** `effective_at` во **все** армы RPC; обязательный reference_date для кейс-анализа; явная пометка редакции в каждой цитате.
- **Citation Verification Engine:** проверка не только ID, но и наличия цитируемой нормы/абзаца в источнике; общий для всех функций.
- **Court Practice Engine:** связывание нормы↔практики, типизация КС/Кассация/Апелляция, маркировка обязательности.
- **ECHR / Venice Engine:** включить qwen-индекс + запросный эмбеддинг (H1); правила применимости ЕСПЧ/Венеции.
- **Document Generation Engine:** переиспользует Reasoning + Citation слои (а не свои копии rag-search).
- **Evaluation / Test Framework:** расширить существующий `eval-runner`/`eval-rag.test.ts` золотыми наборами по темпоральности, иерархии, грунтингу, ЕСПЧ.

### 13. Что НЕ менять (сохранить)
- RPC `search_legal_corpus_dual` (RRF-гибрид) — хорошая основа, дополнить фильтрами, не переписывать.
- Армянская embedding-модель + IVFFlat (lists=900).
- Слой безопасности (`prompt-armor`, `edge-security`, `pii-redactor`, `rate-limiter`, RLS per-case).
- JSON-схемы вывода и STOP-условия агентов.
- `ai-analyze`: `authorityRank` + `lookupByAnchors` + citation-guard (на `documents`) — расширять на всю систему, а не выбрасывать.
- Ingestion-конвейер (chunker/table-extractor/ocr) — рабочий.

---

## ГЛАВНЫЙ ВЫВОД

**На сегодня AI Legal Armenia — это продвинутый, безопасный юридический RAG-комплекс с сильным каркасом промтов и зачатками экспертной системы (иерархия источников, anchor-lookup, темпоральные предупреждения, citation/hallucination-guard в `ai-analyze`), но НЕ полноценная профессиональная юридическая экспертная система РА.**

Обоснование: правовая методология реализована преимущественно декларативно (в промтах), а не как детерминированный движок; ключевые столпы профессиональной правовой логики — сквозной reasoning-пайплайн, иерархический и **темпоральный retrieval во всех путях**, связывание норм и практики, надёжный грунтинг и живой ЕСПЧ-семантический поиск — либо частичны, либо отсутствуют, а три поверхности ответа дают **несогласованное** качество. Это «RAG-first с очень хорошими юридическими промтами», которому до уровня экспертной системы не хватает именно **Reasoning / Hierarchy / Temporal / Grounding** слоёв, описанных в разделе 12. Ближайший к цели компонент — `ai-analyze`; стратегия — поднять его механики в общий Legal Core и распространить на `legal-chat` и `multi-agent`.
