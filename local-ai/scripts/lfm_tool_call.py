#!/usr/bin/env python3
"""
LFM tool-calling runtime for HA Tax (work-order §5).

Model (exact HF repo id from the work order):
  LiquidAI/LFM2-1.2B-Tool

Weights / quantization (user policy — every model uses GGUF Q4_K_M):
  LiquidAI/LFM2-1.2B-Tool-GGUF / LFM2-1.2B-Tool-Q4_K_M.gguf

Runtime: llama-cpp-python (llama.cpp GGUF loader). CPU is enough.
BF16 safetensors / Hugging Face transformers are NOT used on this path.

Reads one JSON object from stdin:
  {
    "model_path": "<path to LFM2-1.2B-Tool-Q4_K_M.gguf>",
    "user_message": "<evidence / instruction>",
    "tools": [ { "name", "description", "parameters" }, ... ],
    "max_new_tokens": 128   # optional
  }

Writes one JSON object to stdout:
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

Q4_K_M_FILENAME = "LFM2-1.2B-Tool-Q4_K_M.gguf"

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
    text = fragment.strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1].strip()
    if not text:
        return []

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
    return parse_pythonic_calls(generated)


def build_prompt(user_message: str, tools: list[dict[str, Any]]) -> str:
    tool_json = json.dumps(tools, separators=(",", ":"))
    system = (
        "You are HA Tax's local tool-calling controller. "
        "Propose exactly one approved tax-engine tool call from the evidence. "
        "Do not calculate tax. Do not invent amounts that are not in the evidence. "
        "Omit fields that are unknown — never replace unknown with 0. "
        "A real numeric 0 in the evidence must be kept as 0. "
        f"List of tools: <|tool_list_start|>{tool_json}<|tool_list_end|>"
    )
    # LFM chat template (simplified ChatML + tool list in system).
    return (
        f"<|im_start|>system\n{system}<|im_end|>\n"
        f"<|im_start|>user\n{user_message}<|im_end|>\n"
        f"<|im_start|>assistant\n"
    )


def _load_llama(model_path: str):
    try:
        from llama_cpp import Llama
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "llama-cpp-python is required for Q4_K_M GGUF inference"
        ) from exc
    return Llama(
        model_path=model_path,
        n_ctx=4096,
        n_threads=None,
        verbose=False,
    )


def run_inference(
    model_path: str,
    user_message: str,
    tools: list[dict[str, Any]],
    max_new_tokens: int,
) -> dict[str, Any]:
    if Q4_K_M_FILENAME not in model_path.replace("\\", "/"):
        return {
            "ok": False,
            "error": f"loader requires filename containing {Q4_K_M_FILENAME}",
        }

    llm = _load_llama(model_path)
    prompt = build_prompt(user_message, tools)
    result = llm(
        prompt,
        max_tokens=max_new_tokens,
        temperature=0.0,
        stop=["<|im_end|>", "<|im_start|>"],
    )
    generated = ""
    try:
        generated = result["choices"][0]["text"]
    except (KeyError, IndexError, TypeError):
        generated = str(result)
    calls = extract_tool_calls(generated)
    return {"ok": True, "raw": generated, "calls": calls}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="LFM2-1.2B-Tool Q4_K_M llama-cpp-python runtime"
    )
    parser.add_argument(
        "--smoke",
        action="store_true",
        help="Load Q4_K_M GGUF only (no generate) and exit",
    )
    parser.add_argument("--model-path", default="", help="Path to Q4_K_M GGUF")
    args = parser.parse_args()

    if args.smoke:
        model_path = args.model_path.strip()
        if not model_path:
            print(json.dumps({"ok": False, "error": "model_path required for --smoke"}))
            return 2
        if Q4_K_M_FILENAME not in model_path.replace("\\", "/"):
            print(
                json.dumps(
                    {
                        "ok": False,
                        "error": f"smoke expects {Q4_K_M_FILENAME}",
                    }
                )
            )
            return 2
        try:
            llm = _load_llama(model_path)
            meta = {
                "ok": True,
                "smoke": "load",
                "runtime": "llama-cpp-python",
                "quantization": "Q4_K_M",
                "model_path": model_path,
                "n_vocab": getattr(llm, "n_vocab", lambda: None)(),
            }
            print(json.dumps(meta))
            return 0
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": f"smoke load failed: {exc}"}))
            return 1

    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"invalid stdin JSON: {exc}"}))
        return 2

    model_path = str(payload.get("model_path") or payload.get("model_dir") or "").strip()
    user_message = str(payload.get("user_message") or "").strip()
    tools = payload.get("tools") or []
    max_new_tokens = int(payload.get("max_new_tokens") or 128)

    if not model_path:
        print(json.dumps({"ok": False, "error": "model_path is required"}))
        return 2
    if not user_message:
        print(json.dumps({"ok": False, "error": "user_message is required"}))
        return 2
    if not isinstance(tools, list) or not tools:
        print(json.dumps({"ok": False, "error": "tools must be a non-empty list"}))
        return 2

    try:
        result = run_inference(model_path, user_message, tools, max_new_tokens)
        print(json.dumps(result))
        return 0 if result.get("ok") else 1
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"inference failed: {exc}"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
