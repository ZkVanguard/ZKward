# AI training workflow

End-to-end procedure for training our own AI models on our own data,
starting with the **Signal Interpreter** (Phase 1) and building up toward
a fully agentic, self-improving system.

> **Learning stays local.** Every step here reads/writes only the Aiven
> Postgres DB, the local Ollama server, and files in `data/` +
> `training/`. Zero third-party ML APIs, zero telemetry endpoints.

---

## The trajectory (why we're doing this)

We are not aiming for "AGI" in the philosophical sense — that's not a
real engineering target. We ARE aiming for the properties people mean
when they say it: **adaptive, self-improving, tool-using, meta-reasoning
systems that get better with every interaction**.

Concrete milestones toward that:

| Phase | What the AI does | Data source | Status |
|---|---|---|---|
| **1 · Signal Interpreter** | Parses prediction-market titles into structured `{asset, direction, threshold, horizon}` | Polymarket + Manifold titles auto-labeled by base LLM | **This PR** |
| **2 · Source Calibrator** | Learns per-source Bayesian hit rates from actual outcomes | Paper-trader closed trades | Shipped (PR #104) |
| **3 · Trade Explainer** | Natural-language post-hoc reasoning on closed trades | Paper + real closed hedges + signal snapshots | Planned |
| **4 · Strategy Discovery** | Proposes new signal combinations to backtest | Full DB history + calibrator weights | Planned |
| **5 · Agentic Trader** | Selects strategy, sizes trade, reviews own decisions, self-improves | End-to-end with tool use | Long-horizon |

Each phase writes labeled data for the next. Phase 1's parser makes
Phase 2's data cleaner. Phase 2's calibrator feeds Phase 3's explainer
with WHY-signals. And so on. Compounding capability from local data.

---

## Phase 1: Signal Interpreter — full workflow

### Prerequisites

- Local Ollama running with `qwen2.5:7b` (`ollama pull qwen2.5:7b`) — used for auto-labeling
- Python 3.10-3.12 for Soup + PyTorch
- ~6 GB free disk for the Qwen 2.5 7B base weights
- RTX 3070 (8 GB) or better for training. CPU-only works but slow.

Install:
```bash
pip install "soup-cli[train]"
# Verify:
soup --version
```

### Step 1 — extract raw titles

Pulls titles from Polymarket topByRelevance (already-scored), Polymarket
Gamma API (full universe), and Manifold crypto markets. Deduplicates by
slug.

```bash
bun run scripts/ai-training/build-signal-interpreter-dataset.ts \
  --limit=2000 \
  --out=data/signal-interpreter/raw.jsonl
```

Output: `data/signal-interpreter/raw.jsonl` — one JSON object per line
with `{source, slug, title, category, endDate?, liquidity?}`.

Runs against your `.env.local` (Aiven DB + Polymarket public API + Manifold public API). No prod state written.

### Step 2 — auto-label with local LLM

Uses local Ollama (via OpenAI-compatible endpoint at
`OLLAMA_BASE_URL`, default `http://localhost:11434`) to prompt Qwen
2.5 7B for structured extraction. Writes labels + confidence, splits
out low-confidence rows to a review queue.

```bash
bun run scripts/ai-training/label-with-llm.ts \
  --in=data/signal-interpreter/raw.jsonl \
  --out=data/signal-interpreter/labeled.jsonl \
  --review-out=data/signal-interpreter/review-queue.jsonl \
  --concurrency=4
```

Confidence threshold is 0.7 (see `label-with-llm.ts`). Anything below goes
to `review-queue.jsonl` — human eyes should skim it before training.

**Time estimate:** 2000 titles × ~2s per call ÷ 4 concurrency ≈ 17 min
on a warm Ollama. First run is slower (weights load).

### Step 3 — human-verify the review queue

Open `data/signal-interpreter/review-queue.jsonl` and skim the low-conf
rows. For anything obviously wrong, edit the `label` fields in place.
Save. These rows will be included on the next pass through Step 4 if
you pass `--include-review`.

**Rule of thumb:** verify ~200 rows (10% of the corpus). Focus on:
- Rows where `asset` is `null` — did the model miss a ticker?
- Non-standard directions (BINARY_YES / NEUTRAL) — is the model over-using them?
- Threshold parsing — did "$100K" get parsed as 100 vs 100_000?

### Step 4 — convert to Soup training format

Splits deterministically into train/val/test (80/10/10 by slug hash).
Excludes low-confidence rows by default.

```bash
bun run scripts/ai-training/to-soup-format.ts \
  --in=data/signal-interpreter/labeled.jsonl \
  --out-dir=training/signal-interpreter
```

Produces:
- `training/signal-interpreter/train.jsonl`
- `training/signal-interpreter/val.jsonl`
- `training/signal-interpreter/test.jsonl`

Each file is one JSON object per line, in sharegpt format
`{messages: [system, user, assistant]}` that Soup natively ingests.

### Step 5 — sanity check the dataset

```bash
cd training/signal-interpreter
soup data validate ./train.jsonl
soup data stats    ./train.jsonl
```

`validate` fails loudly if rows are malformed. `stats` shows length
distribution + token counts — helpful to confirm `max_length: 1024` in
`soup.yaml` is enough.

### Step 6 — train

```bash
cd training/signal-interpreter
soup train  # honors soup.yaml
```

**On RTX 3070 (8 GB):** ~2-4 hours for 3 epochs on 2K examples with
Qwen 2.5 7B + QLoRA 4-bit + layer streaming. Watch stdout for eval loss
at each epoch — if it stops improving after epoch 2, kill the run
(`Ctrl+C`) and start with `--epochs=2` next time.

**Alternate: rent a 4090** ($0.35/hr on RunPod ~2h = <$1). Copy the
training dir up, run `soup train`, copy `output/` down.

Output goes to `training/signal-interpreter/output/`.

### Step 7 — merge adapter into base for Ollama

```bash
cd training/signal-interpreter
soup merge ./output/adapter --to ./output/merged
```

This produces a full model (base + LoRA weights folded in) that Ollama
can serve.

### Step 8 — build an Ollama model

Uses the `Modelfile` in `training/signal-interpreter/`.

```bash
cd training/signal-interpreter
ollama create zkward-signal-interp:qwen2.5-7b -f ./Modelfile
```

Verify it loads:
```bash
ollama run zkward-signal-interp:qwen2.5-7b 'Title: Will BTC be above $68K on Sep 15?'
```

Should respond with clean JSON.

### Step 9 — evaluate on the test set

Manual for now (open `test.jsonl`, feed titles to the model, compare
outputs). A dedicated eval script is a future PR — it should compute
per-field accuracy (asset, direction, threshold, horizon).

**Target metrics before deploying to prod:**
- `asset` accuracy: **≥ 95%** (this is easy — pattern matching)
- `direction` accuracy: **≥ 90%** (harder — subjunctive phrasing)
- `threshold` extraction accuracy: **≥ 85%** (harder still — unit parsing)

### Step 10 — deploy

Set env in Vercel prod:
```bash
vercel env add SIGNAL_INTERPRETER_MODEL_NAME production
# value: zkward-signal-interp:qwen2.5-7b

vercel env add SIGNAL_INTERPRETER_MODEL_URL production
# value: http://<your-ollama-host>:11434  (if not localhost)

vercel env add SIGNAL_INTERPRETER_ENABLED production
# value: 1
```

Redeploy. The `lib/services/ai/signal-interpreter.ts` service now
routes to your fine-tuned model. Regex fallback stays in place — if
Ollama becomes unreachable, ingestion never breaks.

---

## What each shipped file does

| File | Role |
|---|---|
| `scripts/ai-training/build-signal-interpreter-dataset.ts` | Step 1 — extract raw titles |
| `scripts/ai-training/label-with-llm.ts` | Step 2 — auto-label with Ollama |
| `scripts/ai-training/to-soup-format.ts` | Step 4 — convert to Soup sharegpt |
| `training/signal-interpreter/soup.yaml` | Steps 5-6 — Soup training config |
| `training/signal-interpreter/Modelfile` | Step 8 — Ollama model definition |
| `lib/services/ai/signal-interpreter.ts` | Step 10 — runtime service (model + regex fallback) |
| `test/unit/signal-interpreter.test.ts` | 11 tests — regex fallback + model coercion + failure modes |

---

## Phase 2+ — where this goes

Once Phase 1 is producing high-quality parses in prod:

**Phase 3 (Trade Explainer)** — same pipeline, different dataset:
input = `{signals_at_open, position, realized_pnl}`, output = a
natural-language paragraph explaining what happened. Fine-tunes the
same base. Dataset comes from closed hedges. Sits behind an admin API
that generates a weekly digest.

**Phase 4 (Strategy Discovery)** — treat the fine-tuned model as an
agent with tool access to the DB. Prompt: "look at last 30 days of
closes. What signal combinations predicted best?" Model calls
`query()` on the hedges table, returns a proposed new signal weight.
Human-reviewed before deployment.

**Phase 5 (Agentic Trader)** — fully self-directed loop where the model
picks the strategy, sizes the trade, reviews its own decisions daily,
and generates new training data from its mistakes. Runs on paper first
for months. Only touches real capital after passing a strict eval bar.

Each phase's training data is generated by the previous phase's outputs.
That's the compounding-capability loop — not AGI, but the same shape.
