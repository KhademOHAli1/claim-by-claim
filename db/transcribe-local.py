"""Transcribe a local 16 kHz mono PCM derivative with an installed Whisper model."""

import contextlib
import json
import math
import os
import sys
import wave
from pathlib import Path

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

import numpy as np


def run_model(audio, model_path, backend):
    options = {
        "word_timestamps": True,
        "temperature": 0.0,
        "condition_on_previous_text": True,
        "hallucination_silence_threshold": 2.0,
    }
    if backend == "mlx":
        import mlx_whisper

        result = mlx_whisper.transcribe(audio, path_or_hf_repo=model_path, verbose=None, **options)
        return result["language"], result["segments"]

    if backend == "faster-whisper":
        from faster_whisper import WhisperModel

        # A missing tokenizer would otherwise fall back to the model hub.
        if not (Path(model_path) / "tokenizer.json").is_file():
            raise ValueError("The local CTranslate2 model must include tokenizer.json.")
        model = WhisperModel(model_path, device="cpu", compute_type="int8",
                             cpu_threads=2, num_workers=1, local_files_only=True)
        raw_segments, info = model.transcribe(audio, beam_size=1, **options)
        # Consume the lazy generator while model diagnostics are redirected to stderr.
        return info.language, [{
            "start": segment.start,
            "end": segment.end,
            "text": segment.text,
            "words": [{"start": word.start, "end": word.end, "word": word.word}
                      for word in segment.words or []],
        } for segment in raw_segments]

    raise ValueError("Choose the mlx or faster-whisper backend.")


def main(audio_path, model_path, duration, backend):
    if not Path(model_path).is_dir():
        raise ValueError("A local Whisper model directory is required.")
    with wave.open(audio_path, "rb") as wave_file:
        if (wave_file.getnchannels(), wave_file.getframerate(), wave_file.getsampwidth()) != (1, 16000, 2):
            raise ValueError("Audio must be mono 16 kHz, 16-bit PCM.")
        audio = np.frombuffer(wave_file.readframes(wave_file.getnframes()), dtype="<i2").astype(np.float32) / 32768
    if not len(audio) or not np.any(audio):
        raise ValueError("The video has no audible audio track.")

    with contextlib.redirect_stdout(sys.stderr):
        language, raw_segments = run_model(audio, model_path, backend)

    def timed_text(item, text_field, earliest, latest):
        start = float(item["start"])
        end = float(item["end"])
        text = item[text_field].strip()
        if not (math.isfinite(start) and math.isfinite(end) and text):
            return None
        start = round(max(earliest, start), 3)
        end = round(min(latest, end), 3)
        return {"start": start, "end": end, "text": text} if end > start else None

    segments = []
    for raw in raw_segments:
        segment = timed_text(raw, "text", 0, duration)
        if segment is None:
            continue
        words = (timed_text(word, "word", segment["start"], segment["end"]) for word in raw.get("words", []))
        segments.append({
            "id": f"s{len(segments) + 1}",
            **segment,
            "words": [word for word in words if word is not None],
        })

    if not segments:
        raise ValueError("Local Whisper did not find intelligible speech in the video.")
    json.dump({"language": language, "segments": segments}, sys.stdout, ensure_ascii=False, allow_nan=False)


if __name__ == "__main__":
    try:
        main(sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4] if len(sys.argv) > 4 else "mlx")
    except ValueError as error:
        print(f"Transcription: {error}", file=sys.stderr)
        sys.exit(1)
