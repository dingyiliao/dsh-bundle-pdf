#!/usr/bin/env python3
"""Embedding-only loopback server using an existing MLX Python environment.

Run with mlx-lm-local-demo/.venv/bin/python; no vector database, ingestion, VLM,
model downloads, or source-repository changes. Model weights must be cached.
"""
import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import json
import time

DEFAULT_MODEL = "mlx-community/Qwen3-Embedding-0.6B-8bit"
DEFAULT_REVISION = "b8d7100604f51da6d14eab4dd1805f596fa1ce3f"
MAX_INPUT_CHARACTERS = 16000
MAX_INPUT_TOKENS = 8192
MAX_BATCH_SIZE = 8
MAX_PADDED_TOKENS = 16384


def create_app(model_name=DEFAULT_MODEL, revision=DEFAULT_REVISION):
    # Imports stay inside the factory so --help and stdlib contract tests need no MLX.
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.responses import JSONResponse

    state = {}
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="pdf-embedding")

    def load_model():
        from huggingface_hub import snapshot_download
        from mlx_embeddings import load

        path = snapshot_download(repo_id=model_name, revision=revision, local_files_only=True)
        model, tokenizer = load(path)
        state["model"], state["tokenizer"] = model, tokenizer
        # Eagerly exercise the same validated path before advertising readiness.
        infer(["readiness"])

    def infer(texts):
        import mlx.core as mx
        import numpy as np

        tokenizer = state["tokenizer"]
        # Build exactly the token sequence used by inference, with truncation off.
        tokens = tokenizer(texts, padding=True, truncation=False, return_tensors="mlx")
        input_ids = tokens["input_ids"]
        if input_ids.shape[1] > MAX_INPUT_TOKENS or input_ids.size > MAX_PADDED_TOKENS:
            raise ValueError("Input exceeds the token budget; split the input or batch.")
        started = time.perf_counter()
        output = state["model"](**tokens)
        vectors = np.asarray(output.text_embeds, dtype=np.float32)
        if vectors.shape != (len(texts), 1024) or not np.isfinite(vectors).all():
            raise RuntimeError("Embedding model returned invalid vectors.")
        norms = np.linalg.norm(vectors, axis=1)
        if np.any(norms < 1e-12):
            raise RuntimeError("Embedding model returned empty vectors.")
        values = (vectors / norms[:, None]).tolist()
        count = int(np.asarray(tokens["attention_mask"]).sum())
        metrics = {"inferenceMs": round((time.perf_counter() - started) * 1000, 3),
                   "activeMemoryBytes": int(mx.get_active_memory()),
                   "peakMemoryBytes": int(mx.get_peak_memory())}
        del output, tokens, input_ids, vectors
        mx.clear_cache()
        return values, count, metrics

    @asynccontextmanager
    async def lifespan(app):
        await asyncio.get_running_loop().run_in_executor(executor, load_model)
        state["pending"] = 0
        state["lock"] = asyncio.Lock()
        yield
        # An HTTP cancellation cannot preempt an active Metal kernel. Shutdown
        # waits for its bounded batch, then releases weights/cache in this process.
        executor.shutdown(wait=True, cancel_futures=True)
        state.clear()

    app = FastAPI(title="PDF local embeddings", lifespan=lifespan, docs_url=None, redoc_url=None)

    @app.get("/v1/models")
    async def models():
        return {"object": "list", "data": [{"id": model_name, "object": "model", "embedding": {
            "revision": revision, "dimensions": 1024, "maxInputCharacters": MAX_INPUT_CHARACTERS,
            "maxInputTokens": MAX_INPUT_TOKENS, "maxBatchSize": MAX_BATCH_SIZE,
            "maxPaddedTokens": MAX_PADDED_TOKENS, "truncation": False,
            "queryEncoding": "client-instruction", "pooling": "last-token-l2"}}]}

    @app.post("/v1/embeddings")
    async def embeddings(request: Request):
        # Bound bytes before JSON parsing, including chunked HTTP requests.
        raw = bytearray()
        async for block in request.stream():
            raw.extend(block)
            if len(raw) > 800000:
                raise HTTPException(413, "Embedding request exceeds the byte limit.")
        try:
            body = json.loads(raw)
            texts = body.get("input")
            if isinstance(texts, str):
                texts = [texts]
            if (body.get("model", model_name) != model_name or not isinstance(texts, list)
                    or not 1 <= len(texts) <= MAX_BATCH_SIZE
                    or any(not isinstance(text, str) or not text.strip()
                           or len(text.encode("utf-16-le")) // 2 > MAX_INPUT_CHARACTERS + 1024 for text in texts)
                    or body.get("encoding_format", "float") != "float"):
                raise ValueError()
        except (ValueError, AttributeError, UnicodeError):
            raise HTTPException(422, "Invalid embedding model, batch, or text length.") from None
        if state["pending"] >= 4:
            raise HTTPException(429, "The embedding queue is full.")
        state["pending"] += 1
        try:
            async with state["lock"]:
                if await request.is_disconnected():
                    raise HTTPException(499, "Embedding request was cancelled.")
                future = asyncio.get_running_loop().run_in_executor(executor, infer, texts)
                try:
                    values, count, metrics = await asyncio.shield(future)
                except asyncio.CancelledError:
                    # Keep ownership until the kernel completes; cancelled jobs
                    # must not allow an unbounded queue of still-running kernels.
                    await future
                    raise
                except ValueError:
                    raise HTTPException(422, "Input exceeds token budget; split input or batch.") from None
                return JSONResponse({"object": "list", "model": model_name, "model_revision": revision,
                    "data": [{"object": "embedding", "index": i, "embedding": vector} for i, vector in enumerate(values)],
                    "usage": {"prompt_tokens": count, "total_tokens": count}, "metrics": metrics})
        finally:
            state["pending"] -= 1

    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--revision", default=DEFAULT_REVISION)
    args = parser.parse_args()
    import uvicorn
    uvicorn.run(create_app(args.model, args.revision), host="127.0.0.1", port=args.port, access_log=False)
