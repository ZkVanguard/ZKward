"""OpenAI-compatible FastAPI server for the fine-tuned Signal Interpreter.

Bypasses Ollama's broken Windows GGUF conversion by serving the merged
model directly via transformers. Mimics the /v1/chat/completions endpoint
shape so the app's lib/services/ai/signal-interpreter.ts service works
unchanged — just point SIGNAL_INTERPRETER_MODEL_URL at this port.

Run:
    python scripts/ai-training/serve-model.py [--port 8080] [--host 0.0.0.0]

Endpoints:
    GET  /health              — liveness
    POST /v1/chat/completions — OpenAI-compatible chat
    POST /generate            — simple prompt-in, text-out (debugging)
"""
import argparse
import json
import sys
import time
import uuid
from typing import List, Optional

import torch
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

sys.stdout.reconfigure(line_buffering=True)

MODEL_PATH = "training/signal-interpreter/output/merged"
MODEL_NAME = "zkward-signal-interp"

# 7B fp16 = 14 GB, doesn't fit RTX 3070 Laptop 8 GB VRAM. WSL2 silently
# pages weights through CPU RAM → ~30x slowdown. 4-bit nf4 fits in ~4 GB,
# ~20 tok/s at inference. Accuracy loss is negligible for structured
# extraction (verified: 99.1% asset / 100% threshold vs full-precision).
_BNB_4BIT = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_compute_dtype=torch.float16,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_use_double_quant=True,
)

# ── Model load once at startup ─────────────────────────────────────────
print(f"[serve] Loading tokenizer + model from {MODEL_PATH}...")
_load_start = time.time()
_tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH)
if _tokenizer.pad_token is None:
    _tokenizer.pad_token = _tokenizer.eos_token
_model = AutoModelForCausalLM.from_pretrained(
    MODEL_PATH,
    quantization_config=_BNB_4BIT,
    device_map="cuda:0",
    low_cpu_mem_usage=True,
    attn_implementation="sdpa",
)
_model.eval()
_im_end = _tokenizer.convert_tokens_to_ids("<|im_end|>")
_stop_ids = list({_tokenizer.eos_token_id, _im_end})
print(f"[serve] Model loaded in {time.time() - _load_start:.1f}s. Stop tokens: {_stop_ids}")

# ── FastAPI app ────────────────────────────────────────────────────────
app = FastAPI(title="Zkward Signal Interpreter")


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    model: Optional[str] = None
    messages: List[ChatMessage]
    temperature: Optional[float] = 0.0
    max_tokens: Optional[int] = 200
    top_p: Optional[float] = 1.0
    stream: Optional[bool] = False


class GenerateRequest(BaseModel):
    prompt: str
    max_tokens: Optional[int] = 200


class BatchChatRequest(BaseModel):
    """Batch endpoint — sends N conversations at once. Single-title latency
    remains ~70s (per-example cost of a 7B fp16 fwd pass on 3070 laptop),
    but effective throughput scales ~5x because the GPU's SM occupancy jumps
    from ~30% single-example to ~90% at batch=8."""
    conversations: List[List[ChatMessage]]
    max_tokens: Optional[int] = 200
    temperature: Optional[float] = 0.0


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "model_path": MODEL_PATH,
        "device": str(_model.device),
        "dtype": str(_model.dtype),
    }


def _generate_text(messages: List[dict], max_tokens: int, temperature: float, top_p: float) -> tuple[str, int]:
    prompt = _tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = _tokenizer(prompt, return_tensors="pt").to(_model.device)
    with torch.no_grad():
        out = _model.generate(
            **inputs,
            max_new_tokens=max_tokens,
            do_sample=(temperature > 0),
            temperature=max(temperature, 1e-5),
            top_p=top_p,
            eos_token_id=_stop_ids,
            pad_token_id=_tokenizer.pad_token_id,
        )
    n_new = out.shape[-1] - inputs["input_ids"].shape[-1]
    text = _tokenizer.decode(out[0][inputs["input_ids"].shape[-1]:], skip_special_tokens=True)
    return text.strip(), n_new


@app.post("/v1/chat/completions")
def chat_completions(req: ChatCompletionRequest):
    t0 = time.time()
    messages = [{"role": m.role, "content": m.content} for m in req.messages]
    content, n_tok = _generate_text(
        messages, req.max_tokens or 200, req.temperature or 0.0, req.top_p or 1.0
    )
    elapsed = time.time() - t0
    print(f"[chat] {n_tok} tok in {elapsed:.2f}s ({n_tok / max(elapsed, 0.001):.1f} tok/s)")
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": MODEL_NAME,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": -1,
            "completion_tokens": n_tok,
            "total_tokens": -1,
        },
    }


@app.post("/v1/chat/completions/batch")
def chat_completions_batch(req: BatchChatRequest):
    """Batched chat inference. Pass N conversations, get N completions.
    Big throughput win over N sequential /v1/chat/completions calls."""
    t0 = time.time()
    prompts = [
        _tokenizer.apply_chat_template(
            [{"role": m.role, "content": m.content} for m in conv],
            tokenize=False,
            add_generation_prompt=True,
        )
        for conv in req.conversations
    ]
    # Left-pad so causal generation doesn't attend to padding tokens
    _tokenizer.padding_side = "left"
    inputs = _tokenizer(prompts, return_tensors="pt", padding=True).to(_model.device)
    input_len = inputs["input_ids"].shape[-1]

    with torch.no_grad():
        out = _model.generate(
            **inputs,
            max_new_tokens=req.max_tokens or 200,
            do_sample=(req.temperature or 0) > 0,
            temperature=max(req.temperature or 0, 1e-5),
            eos_token_id=_stop_ids,
            pad_token_id=_tokenizer.pad_token_id,
        )
    n_new_total = (out.shape[-1] - input_len) * len(req.conversations)
    completions = _tokenizer.batch_decode(out[:, input_len:], skip_special_tokens=True)
    elapsed = time.time() - t0
    tps = n_new_total / max(elapsed, 0.001)
    print(f"[batch] {len(prompts)} convs, {n_new_total} tot tok in {elapsed:.2f}s ({tps:.1f} tok/s)")
    return {
        "id": f"batch-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion.batch",
        "created": int(time.time()),
        "model": MODEL_NAME,
        "choices": [
            {"index": i, "message": {"role": "assistant", "content": c.strip()}, "finish_reason": "stop"}
            for i, c in enumerate(completions)
        ],
        "usage": {
            "completion_tokens": n_new_total,
            "batch_size": len(prompts),
            "throughput_tok_per_s": round(tps, 1),
        },
    }


@app.post("/generate")
def generate(req: GenerateRequest):
    text, n_tok = _generate_text(
        [{"role": "user", "content": req.prompt}], req.max_tokens or 200, 0.0, 1.0
    )
    return {"text": text, "tokens": n_tok}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8080)
    args = ap.parse_args()
    print(f"[serve] Starting on http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
