#!/usr/bin/env python3
"""
Quantize a source GGUF to Q4_K_M via llama-quantize (llama.cpp).

Usage:
  python local-ai/scripts/quantize_q4_k_m.py --input path/to/f16.gguf --output path/to/Q4_K_M.gguf
  python local-ai/scripts/quantize_q4_k_m.py --input in.gguf --output out.gguf --llama-quantize path/to/llama-quantize.exe
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def find_quantize(explicit: str) -> str | None:
    if explicit:
        return explicit if Path(explicit).exists() else None
    env = os.environ.get("HA_LLAMA_QUANTIZE", "").strip()
    if env and Path(env).exists():
        return env
    which = shutil.which("llama-quantize") or shutil.which("llama-quantize.exe")
    if which:
        return which
    # Common local unpack path under the repo.
    root = Path(__file__).resolve().parents[2]
    for pattern in (
        "tools/llama-cpp/bin/**/llama-quantize.exe",
        "tools/llama-cpp/bin/**/llama-quantize",
    ):
        matches = list(root.glob(pattern))
        if matches:
            return str(matches[0])
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Quantize GGUF to Q4_K_M")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--llama-quantize", default="")
    args = parser.parse_args()

    src = Path(args.input)
    dst = Path(args.output)
    if not src.exists():
        print(json.dumps({"ok": False, "error": f"input missing: {src}"}))
        return 2

    quant = find_quantize(args.llama_quantize)
    if not quant:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "llama-quantize not found (set HA_LLAMA_QUANTIZE or unpack llama.cpp tools/)",
                }
            )
        )
        return 2

    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [quant, str(src), str(dst), "Q4_K_M"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    except OSError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1

    if proc.returncode != 0 or not dst.exists():
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}",
                    "cmd": cmd,
                }
            )
        )
        return 1

    print(
        json.dumps(
            {
                "ok": True,
                "input": str(src),
                "output": str(dst),
                "quantization": "Q4_K_M",
                "bytes": dst.stat().st_size,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
