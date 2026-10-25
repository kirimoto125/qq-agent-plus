#!/usr/bin/env python3
"""看视频：下载音频 → whisper 转写 → 输出纯文本。

作为独立脚本被 Node 调用，避免把 Python 依赖塞进 Node 进程。
用法：python3 watch_video.py <bvid或url> [--model small] [--max-seconds 1200]
输出：stdout 打印 JSON {ok, bvid, title, durationSec, chars, text, error}
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

MODEL_ROOT = "/mnt/data/qq-agent/models"
CACHE_DIR = "/mnt/data/qq-agent/media-cache"


def run(cmd, timeout=600):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def normalize_input(value):
    value = str(value or "").strip()
    m = re.search(r"BV[0-9A-Za-z]+", value)
    if m:
        return m.group(0)
    if value.isdigit():
        return value
    return value


def download_audio(target, workdir, max_seconds):
    url = target if target.startswith("http") else f"https://www.bilibili.com/video/{target}"
    out_tpl = os.path.join(workdir, "audio.%(ext)s")
    result = run([
        sys.executable, "-m", "yt_dlp",
        "-f", "bestaudio/best",
        "--no-playlist",
        "-o", out_tpl,
        "--print", "after_move:%(title)s\t%(duration)s",
        url,
    ], timeout=300 if max_seconds < 600 else 600)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "下载失败").strip()[:400])
    title, duration = "", 0
    for line in (result.stdout or "").splitlines():
        if "\t" in line:
            t, d = line.split("\t", 1)
            title = t.strip()
            try:
                duration = float(d)
            except ValueError:
                duration = 0
    audio = None
    for name in os.listdir(workdir):
        if name.startswith("audio."):
            audio = os.path.join(workdir, name)
            break
    if not audio:
        raise RuntimeError("下载后找不到音频文件")
    return audio, title, duration


def to_wav(audio, workdir):
    wav = os.path.join(workdir, "audio.wav")
    result = run(["ffmpeg", "-y", "-v", "error", "-i", audio, "-ar", "16000", "-ac", "1", wav], timeout=300)
    if result.returncode != 0 or not os.path.exists(wav):
        raise RuntimeError(f"ffmpeg 转 WAV 失败：{result.stderr.strip()[:300]}")
    return wav


def transcribe(wav, model_size):
    from faster_whisper import WhisperModel
    model = WhisperModel(model_size, device="cpu", compute_type="int8", download_root=MODEL_ROOT)
    segments, info = model.transcribe(wav, language="zh", beam_size=1)
    text = "".join(seg.text for seg in segments)
    return text, float(getattr(info, "duration", 0) or 0)


def to_simplified(text):
    try:
        from opencc import OpenCC
        return OpenCC("t2s").convert(text)
    except Exception:
        return text


def clean(text):
    text = re.sub(r"\s+", " ", text or "").strip()
    return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("target")
    parser.add_argument("--model", default="small")
    parser.add_argument("--max-seconds", type=int, default=1200)
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()

    bvid = normalize_input(args.target)
    result = {"ok": False, "bvid": bvid, "title": "", "durationSec": 0, "chars": 0, "text": "", "error": ""}
    started = time.time()
    workdir = tempfile.mkdtemp(prefix="watch-", dir=CACHE_DIR if os.path.isdir(CACHE_DIR) else None)
    try:
        audio, title, duration = download_audio(bvid, workdir, args.max_seconds)
        result["title"] = title
        result["durationSec"] = int(duration)
        if duration and duration > args.max_seconds:
            raise RuntimeError(f"视频太长（{int(duration)} 秒，上限 {args.max_seconds} 秒），不适合逐字看完")
        wav = to_wav(audio, workdir)
        text, _ = transcribe(wav, args.model)
        text = clean(to_simplified(text))
        result.update(ok=bool(text), text=text[:12000], chars=len(text))
        if not text:
            result["error"] = "没有识别出人声（可能是纯音乐/无解说）"
    except Exception as error:  # noqa: BLE001
        result["error"] = str(error)[:400]
    finally:
        if not args.keep:
            try:
                for name in os.listdir(workdir):
                    os.remove(os.path.join(workdir, name))
                os.rmdir(workdir)
            except OSError:
                pass
    result["elapsedSec"] = round(time.time() - started, 1)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
