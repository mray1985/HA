#!/usr/bin/env python3
"""
OCR invoke for work-order Q4_K_M GGUF models (Granite Docling / LightOnOCR).

Runtime: llama-cpp-python (same as LFM / gguf_invoke.py).
Quantization policy: loader requires a Q4_K_M filename.

Reads one JSON object from stdin:
  {
    "model_path": "<path to *.Q4_K_M.gguf>",
    "image_path": "<optional local image>",
    "prompt": "Extract all readable text from this tax document.",
    "max_tokens": 512
  }

Writes one JSON object to stdout:
  { "ok": true, "text": "...", "runtime": "llama-cpp-python", "quantization": "Q4_K_M" }
  or { "ok": false, "error": "..." }

Does not calculate tax. Empty / failed OCR must stay empty (caller treats as unclassified).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def _require_q4(model_path: str) -> str | None:
    norm = model_path.replace("\\", "/")
    name = norm.rsplit("/", 1)[-1]
    upper = name.upper().replace("-", "_")
    if "Q4_K_M" not in upper:
        return f"loader requires a Q4_K_M GGUF filename, got {name}"
    return None


def _generate(llm: Any, prompt: str, max_tokens: int) -> str:
    result = llm(prompt, max_tokens=max_tokens, temperature=0.0)
    try:
        return str(result["choices"][0]["text"] or "")
    except (KeyError, IndexError, TypeError):
        return str(result)


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"invalid stdin JSON: {exc}"}))
        return 2

    model_path = str(payload.get("model_path") or "").strip()
    image_path = str(payload.get("image_path") or "").strip()
    mmproj_path = str(payload.get("mmproj_path") or "").strip()
    prompt = str(
        payload.get("prompt")
        or "Extract all readable text from this tax document. Output plain text only."
    ).strip()
    max_tokens = int(payload.get("max_tokens") or 512)

    if not model_path:
        print(json.dumps({"ok": False, "error": "model_path is required"}))
        return 2

    bad = _require_q4(model_path)
    if bad:
        print(json.dumps({"ok": False, "error": bad}))
        return 2

    if not Path(model_path).is_file():
        print(json.dumps({"ok": False, "error": f"GGUF missing: {model_path}"}))
        return 2

    if image_path and not Path(image_path).is_file():
        print(json.dumps({"ok": False, "error": f"image missing: {image_path}"}))
        return 2

    if mmproj_path and not Path(mmproj_path).is_file():
        print(json.dumps({"ok": False, "error": f"mmproj missing: {mmproj_path}"}))
        return 2

    try:
        from llama_cpp import Llama
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"llama-cpp-python unavailable: {exc}"}))
        return 1

    try:
        # Vision OCR models may accept chat completions with an image; when the
        # GGUF lacks a projector, fall back to a text prompt so cascade can try
        # the next tier rather than crashing the caller.
        load_kwargs: dict[str, Any] = {"model_path": model_path, "n_ctx": 4096, "verbose": False}
        if mmproj_path:
            # llama-cpp-python: clip_model_path attaches a multimodal projector.
            load_kwargs["clip_model_path"] = mmproj_path
        llm = Llama(**load_kwargs)
        text = ""

        if image_path:
            try:
                # Best-effort multimodal path (llama-cpp-python chat + image).
                completion = llm.create_chat_completion(
                    messages=[
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": prompt},
                                {"type": "image_url", "image_url": {"url": f"file://{image_path}"}},
                            ],
                        }
                    ],
                    max_tokens=max_tokens,
                    temperature=0.0,
                )
                text = str(
                    completion.get("choices", [{}])[0]
                    .get("message", {})
                    .get("content")
                    or ""
                )
            except Exception:
                # Some OCR GGUFs still respond to an explicit OCR instruction.
                text = _generate(
                    llm,
                    f"{prompt}\nImage path: {image_path}\n",
                    max_tokens,
                )
        else:
            text = _generate(llm, prompt, max_tokens)

        print(
            json.dumps(
                {
                    "ok": True,
                    "text": text,
                    "runtime": "llama-cpp-python",
                    "quantization": "Q4_K_M",
                    "model_path": model_path,
                }
            )
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"ocr invoke failed: {exc}"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
