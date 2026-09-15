#!/usr/bin/env bash
# Full training pipeline for the Signal Interpreter.
#
# Runs autonomously. Waits for any labeler that's already going, then
# chains: extract (if needed) → label (if needed) → format → free VRAM
# → train → merge → build Ollama model → evaluate.
#
# Idempotent: skips any step whose output already exists. Safe to re-run.
#
# Usage:
#   bash scripts/ai-training/run-training-pipeline.sh
#   # or via package.json:
#   bun run ai:train:full
#
# All output goes to data/signal-interpreter/pipeline.log (also stdout).

set -euo pipefail

# Repo root
cd "$(dirname "$0")/../.."

LOG="data/signal-interpreter/pipeline.log"
mkdir -p "$(dirname "$LOG")"

log() {
  local msg="[$(date '+%H:%M:%S')] $*"
  echo "$msg" | tee -a "$LOG"
}

log "=========================================="
log " Signal Interpreter training pipeline"
log "=========================================="

# ── STEP 0 ────────────────────────────────────────────────────────────
# Wait for any labeler currently running. Detects via output file: the
# labeler writes labeled.jsonl only at the very end, so its absence
# means either the labeler is still running OR hasn't started yet.
if [ ! -f data/signal-interpreter/labeled.jsonl ]; then
  # Check if the labeler process is alive
  if tasklist //FI "IMAGENAME eq bun.exe" 2>/dev/null | grep -qi bun.exe; then
    # There's a bun process — could be our labeler. Wait for it or timeout.
    log "STEP 0: labeler still running, waiting for labeled.jsonl..."
    START=$SECONDS
    MAX_WAIT=$((4 * 60 * 60))  # 4h upper bound
    while [ ! -f data/signal-interpreter/labeled.jsonl ]; do
      elapsed=$((SECONDS - START))
      if [ $elapsed -gt $MAX_WAIT ]; then
        log "STEP 0: TIMED OUT waiting for labeler after ${MAX_WAIT}s"
        exit 1
      fi
      if [ $((elapsed % 300)) -eq 0 ]; then
        log "  ...still waiting (${elapsed}s elapsed, GPU still active)"
      fi
      sleep 30
    done
    log "STEP 0: labeled.jsonl appeared after $((SECONDS - START))s"
  else
    log "STEP 0: no labeler process, will start one below"
  fi
else
  log "STEP 0: labeled.jsonl exists, skipping wait"
fi

# ── STEP 1: extract raw titles ────────────────────────────────────────
if [ ! -f data/signal-interpreter/raw.jsonl ]; then
  log "STEP 1: extracting raw titles..."
  bun run scripts/ai-training/build-signal-interpreter-dataset.ts --limit=2000 2>&1 | tee -a "$LOG"
else
  log "STEP 1: raw.jsonl exists ($(wc -l < data/signal-interpreter/raw.jsonl) lines), skipping"
fi

# ── STEP 2: auto-label ────────────────────────────────────────────────
if [ ! -f data/signal-interpreter/labeled.jsonl ]; then
  log "STEP 2: auto-labeling with Ollama Qwen 2.5 7B..."
  bun run scripts/ai-training/label-with-llm.ts --concurrency=4 2>&1 | tee -a "$LOG"
else
  log "STEP 2: labeled.jsonl exists ($(wc -l < data/signal-interpreter/labeled.jsonl) lines), skipping"
fi

# ── STEP 3: convert to Soup format ────────────────────────────────────
if [ ! -f training/signal-interpreter/train.jsonl ]; then
  log "STEP 3: converting to Soup sharegpt format..."
  bun run scripts/ai-training/to-soup-format.ts 2>&1 | tee -a "$LOG"
else
  log "STEP 3: train.jsonl exists ($(wc -l < training/signal-interpreter/train.jsonl) lines), skipping"
fi

# ── STEP 4: free VRAM ─────────────────────────────────────────────────
# Ollama keeps qwen2.5:7b loaded in ~4.7 GB VRAM. Soup needs the same
# GPU to load its own copy for training. Stop Ollama service.
log "STEP 4: freeing VRAM (stopping Ollama)..."
taskkill //F //IM ollama.exe 2>&1 | tee -a "$LOG" || log "  ollama.exe not running (ok)"
sleep 8

# Check VRAM is actually free
if command -v nvidia-smi >/dev/null 2>&1; then
  vram_used=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | head -1)
  log "  VRAM used after Ollama stop: ${vram_used} MiB"
fi

# ── STEP 5: soup train ────────────────────────────────────────────────
if [ ! -d training/signal-interpreter/output/adapter ] && [ ! -d training/signal-interpreter/output ]; then
  log "STEP 5: soup train (Qwen 2.5 7B QLoRA, ~3h on RTX 3070)..."
  pushd training/signal-interpreter > /dev/null
  soup --no-telemetry train 2>&1 | tee -a "../../$LOG"
  popd > /dev/null
else
  log "STEP 5: training output exists, skipping"
fi

# ── STEP 6: merge adapter into full model ─────────────────────────────
if [ ! -d training/signal-interpreter/output/merged ]; then
  log "STEP 6: merging LoRA adapter into base weights..."
  pushd training/signal-interpreter > /dev/null
  # Soup's merge subcommand: check its exact syntax at runtime
  if soup --help 2>&1 | grep -q 'merge'; then
    soup --no-telemetry merge ./output/adapter --to ./output/merged 2>&1 | tee -a "../../$LOG"
  else
    log "  (soup merge not available, expected under 'soup export' or python peft.merge_and_unload)"
    log "  attempting python fallback merge..."
    python -c "
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer
base = AutoModelForCausalLM.from_pretrained('Qwen/Qwen2.5-7B-Instruct', torch_dtype='auto', device_map='cpu')
peft = PeftModel.from_pretrained(base, './output/adapter')
merged = peft.merge_and_unload()
merged.save_pretrained('./output/merged')
AutoTokenizer.from_pretrained('Qwen/Qwen2.5-7B-Instruct').save_pretrained('./output/merged')
print('merge done')
" 2>&1 | tee -a "../../$LOG"
  fi
  popd > /dev/null
else
  log "STEP 6: merged output exists, skipping"
fi

# ── STEP 7: restart Ollama + build model ──────────────────────────────
log "STEP 7: restarting Ollama and building fine-tuned model..."
# Windows Ollama location
OLLAMA_EXE="$LOCALAPPDATA/Programs/Ollama/ollama.exe"
if [ ! -x "$OLLAMA_EXE" ]; then
  OLLAMA_EXE="$(command -v ollama 2>/dev/null || true)"
fi
if [ -z "$OLLAMA_EXE" ] || [ ! -x "$OLLAMA_EXE" ]; then
  log "  ERROR: ollama.exe not found"
  exit 1
fi
# Kick off Ollama serve in background
"$OLLAMA_EXE" serve > /dev/null 2>&1 &
OLLAMA_PID=$!
log "  Ollama serve started (PID $OLLAMA_PID), waiting for health..."
for i in {1..20}; do
  if curl -s -m 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
    log "  Ollama ready"
    break
  fi
  sleep 2
done

pushd training/signal-interpreter > /dev/null
ollama create zkward-signal-interp:qwen2.5-7b -f ./Modelfile 2>&1 | tee -a "../../$LOG"
popd > /dev/null

# ── STEP 8: evaluate ──────────────────────────────────────────────────
log "STEP 8: evaluating fine-tuned model vs base qwen2.5:7b..."
bun run scripts/ai-training/evaluate-model.ts 2>&1 | tee -a "$LOG"

log ""
log "=========================================="
log " PIPELINE COMPLETE"
log "=========================================="
log " Fine-tuned model: zkward-signal-interp:qwen2.5-7b"
log " Report: data/signal-interpreter/eval-report.json"
log " Log:    $LOG"
log ""
log " To enable in prod:"
log "   vercel env add SIGNAL_INTERPRETER_MODEL_NAME production  # zkward-signal-interp:qwen2.5-7b"
log "   vercel env add SIGNAL_INTERPRETER_ENABLED production      # 1"
