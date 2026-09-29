#!/usr/bin/env python3
"""
Donut IRS document classifier (work-order classifier model).

Exact Hub repo: hsarfraz/donut-irs-tax-docs-classifier
Architecture: Donut / DonutSwin vision classifier (transformers), NOT a GGUF.

Q4_K_M does not exist for this architecture — no official GGUF is published.
Do not substitute a community GGUF. Load native safetensors via transformers.

Reads one JSON object from stdin:
  {
    "model_dir": "<local models/hsarfraz/donut-irs-tax-docs-classifier>",
    "image_path": "<local image>"
  }

Writes:
  { "ok": true, "label": "w2", "score": 0.91, "runtime": "transformers-donut" }
  or { "ok": false, "error": "..." }

The model only proposes a document label. Tax tools / validation still decide
what is written. Unrecognized labels must stay unclassified (caller maps).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"invalid stdin JSON: {exc}"}))
        return 2

    model_dir = str(payload.get("model_dir") or "").strip()
    image_path = str(payload.get("image_path") or "").strip()

    if not model_dir:
        print(json.dumps({"ok": False, "error": "model_dir is required"}))
        return 2
    if not image_path:
        print(json.dumps({"ok": False, "error": "image_path is required"}))
        return 2

    model_path = Path(model_dir)
    image_file = Path(image_path)
    if not model_path.is_dir():
        print(json.dumps({"ok": False, "error": f"Donut model dir missing: {model_dir}"}))
        return 2
    weights = model_path / "model.safetensors"
    if not weights.is_file():
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"Donut weights missing (expected model.safetensors under {model_dir})",
                }
            )
        )
        return 2
    if not image_file.is_file():
        print(json.dumps({"ok": False, "error": f"image missing: {image_path}"}))
        return 2

    try:
        import torch
        from PIL import Image
        from transformers import AutoImageProcessor, AutoModelForImageClassification
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"transformers/Donut runtime unavailable: {exc}"}))
        return 1

    try:
        # Native vision runtime — Donut is not a llama.cpp / Q4_K_M GGUF target.
        processor = AutoImageProcessor.from_pretrained(model_dir, local_files_only=True)
        model = AutoModelForImageClassification.from_pretrained(
            model_dir, local_files_only=True
        )
        model.eval()

        image = Image.open(image_file).convert("RGB")
        # Finetune used ~1920×2560; keep aspect with a bounded resize.
        image = image.resize((1920, 2560), Image.Resampling.LANCZOS)

        inputs = processor(image, return_tensors="pt")
        with torch.no_grad():
            outputs = model(**inputs)
            logits = outputs.logits if hasattr(outputs, "logits") else outputs
            if not hasattr(logits, "argmax"):
                logits = torch.as_tensor(logits)
            probs = torch.softmax(logits, dim=-1)[0]
            pred = int(torch.argmax(probs).item())
            score = float(probs[pred].item())
            label = str(model.config.id2label[pred])

        print(
            json.dumps(
                {
                    "ok": True,
                    "label": label,
                    "score": score,
                    "runtime": "transformers-donut",
                    "repo_id": "hsarfraz/donut-irs-tax-docs-classifier",
                    # Q4_K_M does not exist for this Donut vision architecture.
                    "quantization": None,
                }
            )
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"Donut classify failed: {exc}"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
