#!/usr/bin/env python3
"""
LFM tool-calling runtime for HA Tax (work-order §5).

Model (exact HF repo id from the work order):
  LiquidAI/LFM2-1.2B-Tool

Runtime (from the model card "How to run" for that repo):
  Hugging Face transformers  — BF16 safetensors shipped in the repo.
  (llama.cpp / GGUF is a separate Hub repo; LEAP is an alternate. This
  script uses transformers against LiquidAI/LFM2-1.2B-Tool as specified.)

Reads one JSON object from stdin:
  {
    "model_dir": "<local path>",
    "user_message": "<evidence / instruction>",
    "tools": [ { "name", "description", "parameters" }, ... ],
    "max_new_tokens": 128   # optional
  }

Writes one JSON object to stdout (never prints secrets):
  { "ok": true, "raw": "...", "calls": [ { "tool": "...", "args": {...} } ] }
  or { "ok": false, "error": "..." }

The model must only propose schema-validated tool names. Tax math stays
in the deterministic engine. UNKNOWN must not become zero.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any


TOOL_CALL_RE = re.compile(
    r"<\|tool_call_start\|>(.*?)<\|tool_call_end\|>",
    re.DOTALL,
)
CALL_RE = re.compile(
    r"([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*$",
    re.DOTALL,
)


def _parse_scalar(raw: str) -> Any:
    s = raw.strip()
    if not s:
        return None
    if s in ("None", "null"):
        return None
    if s in ("True", "true"):
        return True
    if s in ("False", "false"):
        return False
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        return s[1:-1]
    try:
        if "." in s or "e" in s.lower():
            return float(s)
        return int(s)
    except ValueError:
        return s


def _split_kwargs(body: str) -> list[str]:
    parts: list[str] = []
    buf: list[str] = []
    depth = 0
    quote: str | None = None
    escape = False
    for ch in body:
        if escape:
            buf.append(ch)
            escape = False
            continue
        if quote:
            buf.append(ch)
            if ch == "\\":
                escape = True
            elif ch == quote:
                quote = None
            continue
        if ch in ('"', "'"):
            quote = ch
            buf.append(ch)
            continue
        if ch in "([{":
            depth += 1
            buf.append(ch)
            continue
        if ch in ")]}":
            depth = max(0, depth - 1)
            buf.append(ch)
            continue
        if ch == "," and depth == 0:
            parts.append("".join(buf).strip())
            buf = []
            continue
        buf.append(ch)
    tail = "".join(buf).strip()
    if tail:
        parts.append(tail)
    return parts


def parse_pythonic_calls(fragment: str) -> list[dict[str, Any]]:
    """Parse LFM Pythonic tool-call list bodies into {tool, args} dicts."""
    text = fragment.strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1].strip()
    if not text:
        return []

    # Split top-level comma-separated calls: name(...), name(...)
    calls_raw: list[str] = []
    buf: list[str] = []
    depth = 0
    quote: str | None = None
    escape = False
    for ch in text:
        if escape:
            buf.append(ch)
            escape = False
            continue
        if quote:
            buf.append(ch)
            if ch == "\\":
                escape = True
            elif ch == quote:
                quote = None
            continue
        if ch in ('"', "'"):
            quote = ch
            buf.append(ch)
            continue
        if ch == "(":
            depth += 1
            buf.append(ch)
            continue
        if ch == ")":
            depth = max(0, depth - 1)
            buf.append(ch)
            continue
        if ch == "," and depth == 0:
            piece = "".join(buf).strip()
            if piece:
                calls_raw.append(piece)
            buf = []
            continue
        buf.append(ch)
    piece = "".join(buf).strip()
    if piece:
        calls_raw.append(piece)

    out: list[dict[str, Any]] = []
    for raw_call in calls_raw:
        m = CALL_RE.match(raw_call.strip())
        if not m:
            continue
        name, body = m.group(1), m.group(2)
        args: dict[str, Any] = {}
        for part in _split_kwargs(body):
            if not part or "=" not in part:
                continue
            key, val = part.split("=", 1)
            key = key.strip()
            parsed = _parse_scalar(val)
            # Preserve real numeric 0; drop None / null so UNKNOWN stays omitted.
            if parsed is None:
                continue
            args[key] = parsed
        out.append({"tool": name, "args": args})
    return out


def extract_tool_calls(generated: str) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    for match in TOOL_CALL_RE.finditer(generated):
        calls.extend(parse_pythonic_calls(match.group(1)))
    if calls:
        return calls
    # Fallback: whole string is a bare [call(...)] without markers.
    return parse_pythonic_calls(generated)


def build_messages(user_message: str, tools: list[dict[str, Any]]) -> list[dict[str, str]]:
    tool_json = json.dumps(tools, separators=(",", ":"))
    system = (
        "You are HA Tax's local tool-calling controller. "
        "Propose exactly one approved tax-engine tool call from the evidence. "
        "Do not calculate tax. Do not invent amounts that are not in the evidence. "
        "Omit fields that are unknown — never replace unknown with 0. "
        "A real numeric 0 in the evidence must be kept as 0. "
        f"List of tools: <|tool_list_start|>{tool_json}<|tool_list_end|>"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user_message},
    ]


def run_inference(model_dir: str, user_message: str, tools: list[dict[str, Any]], max_new_tokens: int) -> dict[str, Any]:
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True)
    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    model = AutoModelForCausalLM.from_pretrained(
        model_dir,
        local_files_only=True,
        torch_dtype=dtype,
    )
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = model.to(device)
    model.eval()

    messages = build_messages(user_message, tools)
    input_ids = tokenizer.apply_chat_template(
        messages,
        add_generation_prompt=True,
        return_tensors="pt",
    ).to(device)

    with torch.inference_mode():
        output = model.generate(
            input_ids,
            max_new_tokens=max_new_tokens,
            do_sample=False,  # model card: greedy / temperature=0
        )

    generated = tokenizer.decode(output[0][input_ids.shape[1] :], skip_special_tokens=False)
    calls = extract_tool_calls(generated)
    return {"ok": True, "raw": generated, "calls": calls}


def main() -> int:
    parser = argparse.ArgumentParser(description="LFM2-1.2B-Tool transformers runtime")
    parser.add_argument(
        "--smoke",
        action="store_true",
        help="Load tokenizer+config only (no generate) and exit",
    )
    parser.add_argument("--model-dir", default="", help="Local model directory")
    args = parser.parse_args()

    if args.smoke:
        model_dir = args.model_dir.strip()
        if not model_dir:
            print(json.dumps({"ok": False, "error": "model_dir required for --smoke"}))
            return 2
        try:
            from transformers import AutoConfig, AutoTokenizer

            cfg = AutoConfig.from_pretrained(model_dir, local_files_only=True)
            tok = AutoTokenizer.from_pretrained(model_dir, local_files_only=True)
            print(
                json.dumps(
                    {
                        "ok": True,
                        "smoke": "load",
                        "model_type": getattr(cfg, "model_type", None),
                        "architectures": getattr(cfg, "architectures", None),
                        "tokenizer": tok.__class__.__name__,
                    }
                )
            )
            return 0
        except Exception as exc:  # noqa: BLE001 — surface load errors to caller
            print(json.dumps({"ok": False, "error": f"smoke load failed: {exc}"}))
            return 1

    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"invalid stdin JSON: {exc}"}))
        return 2

    model_dir = str(payload.get("model_dir") or "").strip()
    user_message = str(payload.get("user_message") or "").strip()
    tools = payload.get("tools") or []
    max_new_tokens = int(payload.get("max_new_tokens") or 128)

    if not model_dir:
        print(json.dumps({"ok": False, "error": "model_dir is required"}))
        return 2
    if not user_message:
        print(json.dumps({"ok": False, "error": "user_message is required"}))
        return 2
    if not isinstance(tools, list) or not tools:
        print(json.dumps({"ok": False, "error": "tools must be a non-empty list"}))
        return 2

    try:
        result = run_inference(model_dir, user_message, tools, max_new_tokens)
        print(json.dumps(result))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"inference failed: {exc}"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
