"""Direct-model evaluation bypassing Ollama (which mangles our merged model
on Windows). Loads the fine-tuned merged model + base Qwen 2.5 7B via
transformers, runs both on the 106 test examples, reports per-field
accuracy delta.

This is the honest measure of what the fine-tune actually learned.

Batched inference: EVAL_BATCH_SIZE env var (default 8). Set to 1 for the
old single-example loop. Greedy decoding is deterministic — batch vs
serial produces identical outputs.
"""
import json
import os
import time
from pathlib import Path
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig

# 7B fp16 = 14 GB, doesn't fit RTX 3070 Laptop 8 GB VRAM. WSL2 unified memory
# silently pages weights through CPU RAM → ~30x slowdown (measured 0.5 tok/s).
# 4-bit nf4 fits in ~4 GB, ~20 tok/s.
_BNB_4BIT = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_compute_dtype=torch.bfloat16,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_use_double_quant=True,
)

TEST_PATH = "training/signal-interpreter/test.jsonl"
FINE_TUNED_PATH = "training/signal-interpreter/output/merged"
BASE_ID = "Qwen/Qwen2.5-7B-Instruct"
REPORT_PATH = "data/signal-interpreter/eval-report-direct.json"

FIELDS = ("asset", "direction", "threshold", "horizon")


def try_parse_label(raw: str):
    """Extract JSON from model output; return dict or None."""
    if not raw:
        return None
    # Find first { ... } block
    start = raw.find("{")
    if start < 0:
        return None
    depth = 0
    for i, ch in enumerate(raw[start:], start):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                blob = raw[start : i + 1]
                try:
                    d = json.loads(blob)
                except json.JSONDecodeError:
                    return None
                return {
                    "asset": (d.get("asset") or "").upper() if d.get("asset") else None,
                    "direction": d.get("direction") or "NEUTRAL",
                    "threshold": d.get("threshold"),
                    "horizon": d.get("horizon") or "unknown",
                }
    return None


def field_eq(a, b, field):
    va, vb = a.get(field), b.get(field)
    if va is None and vb is None:
        return True
    if isinstance(va, (int, float)) and isinstance(vb, (int, float)):
        return abs(va - vb) < 1e-6
    return va == vb


def generate_batch(model, tokenizer, prompts, max_new_tokens: int = 200):
    """Batched greedy generation. Left-padding is mandatory for causal LMs —
    right-pad breaks the "last token" continuation. Each sequence stops
    independently on eos_token_id."""
    enc = tokenizer(
        prompts, return_tensors="pt", padding=True, truncation=True, max_length=2048
    ).to(model.device)
    im_end = tokenizer.convert_tokens_to_ids("<|im_end|>")
    stop_ids = list({tokenizer.eos_token_id, im_end})
    with torch.no_grad():
        out = model.generate(
            **enc,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            eos_token_id=stop_ids,
            pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id,
        )
    padded_len = enc["input_ids"].shape[-1]
    return [tokenizer.decode(o[padded_len:], skip_special_tokens=True) for o in out]


def _preflight_vram(min_free_gib: float = 4.5):
    """Fail loud if VRAM is short. Root cause of the 30x paging slowdown is
    another process (usually Ollama) holding weights — the driver silently
    pages ours through CPU RAM. Better to abort than run 100 min instead of
    2 min. Skip via EVAL_SKIP_VRAM_CHECK=1."""
    if os.environ.get("EVAL_SKIP_VRAM_CHECK") == "1":
        return
    free_b, _total_b = torch.cuda.mem_get_info(0)
    free_gib = free_b / (1024 ** 3)
    if free_gib < min_free_gib:
        raise RuntimeError(
            f"Only {free_gib:.1f} GiB free on GPU 0 (need ≥{min_free_gib} GiB). "
            f"Likely culprit: Ollama or a prior Python process is holding VRAM. "
            f"Run: powershell -c \"Stop-Process -Name ollama -Force\"  "
            f"or set EVAL_SKIP_VRAM_CHECK=1 to override."
        )
    print(f"  [preflight] {free_gib:.1f} GiB free on GPU 0 — ok", flush=True)


def evaluate_model(name: str, model_path: str, examples):
    print(f"\n== Loading {name} ({model_path}) ==", flush=True)
    _preflight_vram()
    tok = AutoTokenizer.from_pretrained(model_path)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    tok.padding_side = "left"  # causal-LM batched generation requires left-pad
    model = AutoModelForCausalLM.from_pretrained(
        model_path,
        quantization_config=_BNB_4BIT,
        device_map="cuda:0",
        low_cpu_mem_usage=True,
        attn_implementation="sdpa",
    )
    model.eval()

    # Filter to examples with parseable truth, then render prompts once.
    valid = []
    for ex in examples:
        msgs = ex["messages"]
        truth_turn = next((m["content"] for m in msgs if m["role"] == "assistant"), "")
        truth = try_parse_label(truth_turn)
        if not truth:
            continue
        user_turn = next((m["content"] for m in msgs if m["role"] == "user"), "")
        chat = [m for m in msgs if m["role"] in ("system", "user")]
        prompt = tok.apply_chat_template(chat, tokenize=False, add_generation_prompt=True)
        valid.append({"prompt": prompt, "user": user_turn, "truth": truth})

    batch_size = int(os.environ.get("EVAL_BATCH_SIZE", "8"))
    rows = []
    parse_fail = 0
    field_correct = {f: 0 for f in FIELDS}
    t0 = time.time()

    for start in range(0, len(valid), batch_size):
        batch = valid[start : start + batch_size]
        prompts = [b["prompt"] for b in batch]
        try:
            raws = generate_batch(model, tok, prompts)
        except Exception as e:
            raws = [f"ERR: {e}"] * len(batch)

        for b, raw in zip(batch, raws):
            pred = try_parse_label(raw)
            if pred is None:
                parse_fail += 1
            else:
                for f in FIELDS:
                    if field_eq(pred, b["truth"], f):
                        field_correct[f] += 1
            rows.append({"user": b["user"][:120], "truth": b["truth"], "pred": pred, "raw": raw[:200]})

        done = start + len(batch)
        elapsed = time.time() - t0
        rate = done / max(elapsed, 0.001)
        remaining = (len(valid) - done) / max(rate, 0.001)
        print(f"  [{name}] {done}/{len(valid)}  {rate:.2f} ex/s  eta {remaining:.0f}s  parse_fail={parse_fail}", flush=True)
        Path("data/signal-interpreter").mkdir(parents=True, exist_ok=True)
        with open(f"data/signal-interpreter/eval-progress-{name.lower().replace(' ', '-')}.json", "w") as pf:
            json.dump({"i": done, "n": len(valid), "field_correct": field_correct, "parse_fail": parse_fail}, pf, indent=2)

    # Free VRAM before loading the next model
    import gc
    del model
    gc.collect()
    try:
        torch.cuda.empty_cache()
        torch.cuda.synchronize()
    except Exception as e:
        print(f"[warn] cuda cleanup: {e}")

    return {"rows": rows, "parse_fail": parse_fail, "field_correct": field_correct}


def _save_partial(ft, bl, n):
    """Write whatever we have, even if the run partially failed."""
    Path(REPORT_PATH).parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "n": n,
        "fine_tuned": (
            {**ft["field_correct"], "parse_fail": ft["parse_fail"]} if ft else None
        ),
        "baseline": (
            {**bl["field_correct"], "parse_fail": bl["parse_fail"]} if bl else None
        ),
    }
    if ft:
        payload["mismatches_sample"] = [
            r
            for r in ft["rows"]
            if r["pred"] and not field_eq(r["pred"], r["truth"], "asset")
        ][:10]
    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)


def main():
    import gc
    examples = []
    with open(TEST_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                examples.append(json.loads(line))
    print(f"Loaded {len(examples)} test examples")

    ft = evaluate_model("Fine-tuned", FINE_TUNED_PATH, examples)
    n = len(ft["rows"])
    # Save fine-tuned results immediately — the baseline load may OOM, but
    # our fine-tuned numbers are what we most care about.
    _save_partial(ft, None, n)
    print(f"\n[intermediate] Fine-tuned report written to {REPORT_PATH}")

    # Aggressive VRAM clean between models
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.synchronize()

    bl = None
    try:
        bl = evaluate_model("Baseline (base Qwen 2.5 7B)", BASE_ID, examples)
        _save_partial(ft, bl, n)
    except Exception as e:
        print(f"\n[warn] Baseline eval failed: {type(e).__name__}: {e}")
        print("       Fine-tuned results already saved.")

    def pct(x):
        return f"{(x / n) * 100:5.1f}%"

    print()
    print("=" * 60)
    print(f"EVAL RESULTS — {n} test examples")
    print("=" * 60)
    if bl:
        print(f"{'Field':<12}{'Fine-tuned':<20}{'Baseline':<20}{'Δ'}")
        for f in FIELDS:
            ft_v = ft["field_correct"][f]
            bl_v = bl["field_correct"][f]
            d = ft_v - bl_v
            arrow = "↑" if d > 0 else "↓" if d < 0 else "="
            print(f"  {f:<10}{pct(ft_v)} ({ft_v:>3}){'':<7}{pct(bl_v)} ({bl_v:>3}){'':<7}{arrow} {d:+d}")
        print()
        print(f"Parse failures  Fine-tuned: {ft['parse_fail']} / {n}  |  Baseline: {bl['parse_fail']} / {n}")
    else:
        print(f"{'Field':<12}{'Fine-tuned'}")
        for f in FIELDS:
            ft_v = ft["field_correct"][f]
            print(f"  {f:<10}{pct(ft_v)} ({ft_v:>3})")
        print()
        print(f"Parse failures  Fine-tuned: {ft['parse_fail']} / {n}")
        print("(Baseline comparison skipped — VRAM constrained on 8 GB)")
    print()
    print(f"Report: {REPORT_PATH}")


if __name__ == "__main__":
    main()
