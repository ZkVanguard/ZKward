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
import os
import re
import sys
import time
import uuid
from typing import List, Optional


# Qwen 2.5's tool-call token markers. Model was trained to emit these
# inline when it decides to call a tool. We parse them out of the raw
# content string here and convert to OpenAI's structured tool_calls
# shape — that's what the OpenAI SDK (and our tool-runner) expects.
_TOOL_CALL_RE = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.DOTALL)


def _inject_tools(messages: List[dict], tools: Optional[List[dict]]) -> List[dict]:
    """When the caller passed OpenAI-shape `tools`, prepend a description
    block to the system message in the exact format the model was trained
    on. Without this, the model doesn't know the tool names are TOOLS."""
    if not tools:
        return messages
    lines = ["You reason about Zkward's live state. Available tools:"]
    for t in tools:
        fn = t.get("function") if t.get("type") == "function" else t
        if not fn:
            continue
        name = fn.get("name") or ""
        desc = fn.get("description") or ""
        if name:
            lines.append(f"- {name}: {desc}")
    lines.append(
        '\nCall a tool with <tool_call>{"name":"...","arguments":{...}}</tool_call>. '
        "If a tool errors, be honest — never fabricate results. "
        "If the answer is in the prompt, respond directly without a tool call."
    )
    tool_block = "\n".join(lines)
    # Prepend/merge into system message
    out = []
    injected = False
    for m in messages:
        if m["role"] == "system" and not injected:
            merged = f"{tool_block}\n\n{m['content']}" if m.get("content") else tool_block
            out.append({"role": "system", "content": merged})
            injected = True
        else:
            out.append(m)
    if not injected:
        out.insert(0, {"role": "system", "content": tool_block})
    return out


def _extract_tool_calls(content: str):
    """Return (cleaned_content, tool_calls_list). If the content has any
    <tool_call>{json}</tool_call> markers, they're extracted into an
    OpenAI-shaped tool_calls list. Content is stripped of the markers."""
    tool_calls = []
    for m in _TOOL_CALL_RE.finditer(content):
        try:
            payload = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        name = payload.get("name") or ""
        args = payload.get("arguments") or {}
        if not name:
            continue
        tool_calls.append({
            "id": f"call_{uuid.uuid4().hex[:16]}",
            "type": "function",
            "function": {"name": name, "arguments": json.dumps(args)},
        })
    if not tool_calls:
        return content, None
    cleaned = _TOOL_CALL_RE.sub("", content).strip()
    return cleaned, tool_calls

import torch
import uvicorn
from fastapi import FastAPI, Header, HTTPException
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

# Shared-secret header. Empty env → auth disabled (local dev). Required
# once the server is behind a public tunnel — /health stays open so
# monitoring can probe without the secret.
_AUTH_SECRET = (os.environ.get("SIGNAL_INTERPRETER_AUTH_HEADER") or "").strip()


def _require_auth(x_api_key: Optional[str]):
    if not _AUTH_SECRET:
        return
    if x_api_key != _AUTH_SECRET:
        raise HTTPException(status_code=401, detail="invalid or missing X-Api-Key")


class ChatMessage(BaseModel):
    role: str
    content: Optional[str] = None
    # OpenAI-shape assistant turns carrying tool calls, plus tool-return
    # observations that come back to the model.
    tool_calls: Optional[List[dict]] = None
    tool_call_id: Optional[str] = None
    name: Optional[str] = None


class ChatCompletionRequest(BaseModel):
    model: Optional[str] = None
    messages: List[ChatMessage]
    temperature: Optional[float] = 0.0
    max_tokens: Optional[int] = 200
    top_p: Optional[float] = 1.0
    stream: Optional[bool] = False
    # OpenAI-shape tool schemas. When present, we inject their descriptions
    # into the system prompt in the exact format the model was trained on,
    # so it recognizes them as available tools and emits <tool_call> XML.
    tools: Optional[List[dict]] = None
    tool_choice: Optional[str] = None


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
def chat_completions(req: ChatCompletionRequest, x_api_key: Optional[str] = Header(default=None)):
    _require_auth(x_api_key)
    t0 = time.time()
    # Reconstruct messages in the format the tokenizer's chat_template expects.
    # OpenAI-shape assistant turns carry `tool_calls` structured; we re-emit
    # them as inline <tool_call>{...}</tool_call> markers so the model sees
    # the same format it was trained on.
    messages = []
    for m in req.messages:
        if m.role == "assistant" and m.tool_calls:
            parts = []
            if m.content:
                parts.append(m.content)
            for tc in m.tool_calls:
                fn = tc.get("function", {})
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = fn.get("arguments") or {}
                parts.append(f'<tool_call>{{"name":"{fn.get("name","")}","arguments":{json.dumps(args)}}}</tool_call>')
            messages.append({"role": "assistant", "content": "".join(parts)})
        else:
            messages.append({"role": m.role, "content": m.content or ""})
    messages = _inject_tools(messages, req.tools)
    content, n_tok = _generate_text(
        messages, req.max_tokens or 200, req.temperature or 0.0, req.top_p or 1.0
    )
    elapsed = time.time() - t0
    cleaned_content, tool_calls = _extract_tool_calls(content)
    print(f"[chat] {n_tok} tok in {elapsed:.2f}s ({n_tok / max(elapsed, 0.001):.1f} tok/s) tool_calls={len(tool_calls or [])}")
    message = {"role": "assistant", "content": cleaned_content or None}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": MODEL_NAME,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": "tool_calls" if tool_calls else "stop",
            }
        ],
        "usage": {
            "prompt_tokens": -1,
            "completion_tokens": n_tok,
            "total_tokens": -1,
        },
    }


@app.post("/v1/chat/completions/batch")
def chat_completions_batch(req: BatchChatRequest, x_api_key: Optional[str] = Header(default=None)):
    _require_auth(x_api_key)
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
def generate(req: GenerateRequest, x_api_key: Optional[str] = Header(default=None)):
    _require_auth(x_api_key)
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
