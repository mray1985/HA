#!/usr/bin/env python3
"""
Minimal Q4_K_M GGUF invoke helper for HA Tax work-order models.

Runtime: llama-cpp-python. Modes: smoke | generate | embed.
Never calculates tax. Missing/invalid paths return ok:false JSON.
"""

from __future__ import annotations

import json
import sys
from typing import Any


def _require_q4(model_path: str) -> str | None:
    norm = model_path.replace("\\", "/")
    name = norm.rsplit("/", 1)[-1]
    upper = name.upper().replace("-", "_")
    if "Q4_K_M" not in upper:
        return f"loader requires a Q4_K_M GGUF filename, got {name}"
    return None


def _load(model_path: str, embedding: bool = False):
    from llama_cpp import Llama

    return Llama(
        model_path=model_path,
        n_ctx=2048 if not embedding else 512,
        embedding=embedding,
        verbose=False,
    )


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"invalid stdin JSON: {exc}"}))
        return 2

    model_path = str(payload.get("model_path") or "").strip()
    mode = str(payload.get("mode") or "smoke").strip()
    prompt = str(payload.get("prompt") or "").strip()
    max_tokens = int(payload.get("max_tokens") or 64)

    if not model_path:
        print(json.dumps({"ok": False, "error": "model_path is required"}))
        return 2

    bad = _require_q4(model_path)
    if bad:
        print(json.dumps({"ok": False, "error": bad}))
        return 2

    try:
        if mode == "smoke":
            llm = _load(model_path, embedding=False)
            print(
                json.dumps(
                    {
                        "ok": True,
                        "smoke": "load",
                        "runtime": "llama-cpp-python",
                        "quantization": "Q4_K_M",
                        "model_path": model_path,
                        "n_vocab": getattr(llm, "n_vocab", lambda: None)(),
                    }
                )
            )
            return 0

        if mode == "embed":
            llm = _load(model_path, embedding=True)
            text = prompt or " "
            emb = llm.embed(text)
            # llama-cpp may return list[float] or list[list[float]]
            vector: list[float]
            if emb and isinstance(emb[0], (list, tuple)):
                vector = list(emb[0])  # type: ignore[index]
            else:
                vector = list(emb)  # type: ignore[arg-type]
            print(json.dumps({"ok": True, "embedding": vector[:16], "dims": len(vector)}))
            return 0

        if mode == "generate":
            llm = _load(model_path, embedding=False)
            result = llm(
                prompt or "Say OK.",
                max_tokens=max_tokens,
                temperature=0.0,
            )
            text = ""
            try:
                text = result["choices"][0]["text"]
            except (KeyError, IndexError, TypeError):
                text = str(result)
            print(json.dumps({"ok": True, "text": text}))
            return 0

        print(json.dumps({"ok": False, "error": f"unknown mode: {mode}"}))
        return 2
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"invoke failed: {exc}"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
