#!/usr/bin/env python3
"""Procedurally synthesised sound effects -> assets/audio/*.wav (+ .ogg via ffmpeg)

All WAV files: 44100 Hz, mono, 16-bit PCM.
Loops (engine_*, tyre_screech_loop) are *mathematically* periodic: every
oscillator has an integer number of cycles in the loop and all noise is shaped
circularly in the FFT domain, so sample N-1 flows into sample 0 without a seam.
"""
from __future__ import annotations

import json
import math
import shutil
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "audio"
SR = 44100
LOOP_SECONDS = 2.0


def rng(seed):
    return np.random.default_rng(seed)


def qfreq(f, L=LOOP_SECONDS):
    """Quantise frequency so it completes an integer number of cycles in L seconds."""
    return max(1, round(f * L)) / L


def periodic_band_noise(n, lo, hi, seed, tilt=0.0):
    """Circular (loopable) noise with energy between lo..hi Hz."""
    X = np.fft.rfft(rng(seed).standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    g = ((f >= lo) & (f <= hi)).astype(float)
    # soft edges
    g = np.maximum(g, np.exp(-((f - lo) / (0.25 * lo + 1)) ** 2) * (f < lo))
    g = np.maximum(g, np.exp(-((f - hi) / (0.25 * hi + 1)) ** 2) * (f > hi))
    if tilt:
        g *= (np.maximum(f, 1) / max(lo, 1)) ** tilt
    x = np.fft.irfft(X * g, n)
    return x / (np.abs(x).max() + 1e-12)


def periodic_lfo(n, cycles, seed, smooth=8):
    """Smooth random periodic modulation with `cycles` harmonics of the loop."""
    r = rng(seed)
    t = np.arange(n) / n
    out = np.zeros(n)
    for k in range(1, smooth + 1):
        out += r.standard_normal() / k * np.sin(2 * np.pi * k * cycles * t + r.random() * 6.283)
    return out / (np.abs(out).max() + 1e-12)


def engine_loop(rpm, seed, cylinders=8):
    n = int(SR * LOOP_SECONDS)
    t = np.arange(n) / SR
    crank = qfreq(rpm / 60)
    fire = qfreq(rpm / 60 * cylinders / 2)
    r = rng(seed)
    x = np.zeros(n)
    # firing harmonics with a "formant" bump around 2-3x fundamental
    for h in range(1, 28):
        f = fire * h
        if f > 9000:
            break
        a = 1.0 / h ** 0.9 * (1 + 0.8 * math.exp(-((h - 2.5) / 1.5) ** 2))
        x += a * np.sin(2 * np.pi * f * t + r.random() * 6.283)
    # crank-order lumpiness (uneven firing) — strongest at idle
    lump = 0.0
    for h in range(1, 6):
        lump += np.sin(2 * np.pi * crank * h * t + r.random() * 6.283) / h
    lump_amt = np.interp(rpm, [900, 7500], [0.45, 0.10])
    x *= (1 + lump_amt * lump / 2)
    # per-combustion jitter: periodic noise modulating amplitude
    x *= (1 + 0.12 * periodic_lfo(n, 3, seed + 1, 12))
    # intake / exhaust roar
    roar = periodic_band_noise(n, 200 + rpm * 0.05, 1500 + rpm * 0.4, seed + 2)
    x = x / np.abs(x).max() + roar * np.interp(rpm, [900, 7500], [0.10, 0.30])
    # drive / saturation, stronger at high revs
    drive = np.interp(rpm, [900, 7500], [1.4, 2.6])
    x = np.tanh(x * drive)
    return x


def screech_loop(seed=91):
    n = int(SR * LOOP_SECONDS)
    t = np.arange(n) / SR
    noise = periodic_band_noise(n, 1400, 4200, seed)
    x = 0.5 * noise
    r = rng(seed)
    for base, amp in ((1150, 0.6), (2310, 0.35), (3460, 0.15)):
        f = qfreq(base)
        fm = qfreq(r.uniform(5, 9))
        beta = r.uniform(4, 9)
        x += amp * np.sin(2 * np.pi * f * t + beta * np.sin(2 * np.pi * fm * t) + r.random() * 6.283)
    x *= (1 + 0.35 * periodic_lfo(n, 4, seed + 3, 6))
    return np.tanh(x * 1.2)


def env_ad(n, attack, decay_tau):
    t = np.arange(n) / SR
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    return a * np.exp(-np.maximum(t - attack, 0) / decay_tau)


def noise(n, seed):
    return rng(seed).standard_normal(n)


def lowpass(x, fc, order=2):
    from scipy.signal import butter, sosfilt
    return sosfilt(butter(order, fc, "low", fs=SR, output="sos"), x)


def bandpass(x, lo, hi, order=2):
    from scipy.signal import butter, sosfilt
    return sosfilt(butter(order, [lo, hi], "band", fs=SR, output="sos"), x)


def collision(heavy, seed):
    dur = 1.4 if heavy else 0.45
    n = int(SR * dur)
    t = np.arange(n) / SR
    r = rng(seed)
    f0 = 55 if heavy else 95
    thump = np.sin(2 * np.pi * (f0 + 60 * np.exp(-t / 0.03)) * t) * env_ad(n, 0.002, 0.18 if heavy else 0.07)
    crunch = bandpass(noise(n, seed), 300, 6000) * env_ad(n, 0.001, 0.25 if heavy else 0.05)
    x = 1.0 * thump + 0.7 * crunch
    if heavy:
        # secondary impacts + scraping debris
        for k in range(6):
            t0 = r.uniform(0.04, 0.5)
            i0 = int(t0 * SR)
            m = n - i0
            x[i0:] += r.uniform(0.2, 0.5) * bandpass(noise(m, seed + 10 + k), 800, 7000) * env_ad(m, 0.001, r.uniform(0.02, 0.08))
        for f, a, tau in ((317, 0.30, 0.35), (873, 0.22, 0.25), (1529, 0.15, 0.18), (2311, 0.10, 0.12)):
            x += a * np.sin(2 * np.pi * f * t + r.random() * 6) * env_ad(n, 0.001, tau)
    else:
        for f, a, tau in ((640, 0.25, 0.06), (1410, 0.15, 0.04)):
            x += a * np.sin(2 * np.pi * f * t) * env_ad(n, 0.001, tau)
    fade = np.clip((dur - t) / 0.05, 0, 1)
    return np.tanh(x * 1.3) * fade


def nitro(seed=101):
    dur = 1.6
    n = int(SR * dur)
    t = np.arange(n) / SR
    from scipy.signal import istft, stft
    w = noise(n, seed)
    f, tt, Z = stft(w, SR, nperseg=1024)
    centre = 300 + 3200 * np.clip(tt / 0.9, 0, 1) ** 1.5
    G = np.exp(-((f[:, None] - centre[None, :]) / (0.6 * centre[None, :])) ** 2)
    _, x = istft(Z * G, SR, nperseg=1024)
    x = x[:n]
    x /= np.abs(x).max()
    rumble = lowpass(noise(n, seed + 1), 120, 4) * 3
    env = np.clip(t / 0.08, 0, 1) * np.clip((dur - t) / 0.6, 0, 1) ** 1.5
    return np.tanh((x + 0.4 * rumble) * env * 1.5)


def beep(freq, dur):
    n = int(SR * dur)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * freq * t) + 0.3 * np.sin(2 * np.pi * 2 * freq * t) + 0.12 * np.sin(2 * np.pi * 3 * freq * t)
    env = np.clip(t / 0.005, 0, 1) * np.clip((dur - t) / 0.03, 0, 1)
    return x / 1.42 * env


def countdown():
    total = np.zeros(int(SR * 3.9))
    for k in range(3):
        b = beep(880, 0.18)
        i = int(k * SR)
        total[i:i + len(b)] += b
    b = beep(1760, 0.75)
    i = int(3 * SR)
    total[i:i + len(b)] += b
    return total


def brass(freq, dur, seed):
    n = int(SR * dur)
    t = np.arange(n) / SR
    vib = 1 + 0.004 * np.sin(2 * np.pi * 5.5 * t) * np.clip((t - 0.15) / 0.2, 0, 1)
    phase = 2 * np.pi * freq * np.cumsum(vib) / SR
    bright = 0.35 + 0.65 * np.exp(-t / 0.25)        # filter envelope: bright attack
    x = np.zeros(n)
    for h in range(1, 14):
        x += (bright ** (h / 4)) / h * np.sin(h * phase)
    env = np.clip(t / 0.03, 0, 1) * np.clip((dur - t) / 0.08, 0, 1)
    return x * env


def fanfare():
    """Original short victory fanfare (C major), ~3.2 s."""
    def hz(note):
        names = {"C": -9, "D": -7, "E": -5, "F": -4, "G": -2, "A": 0, "B": 2}
        return 440 * 2 ** ((names[note[0]] + 12 * (int(note[-1]) - 4)) / 12)
    beat = 0.16
    melody = [("G4", 0, 1), ("C5", 1, 1), ("E5", 2, 1), ("G5", 3, 2), ("E5", 5, 1), ("F5", 6, 1), ("A5", 7, 2),
              ("G5", 9, 1), ("C6", 10, 8)]
    total = np.zeros(int(SR * 3.4))
    for k, (note, start, length) in enumerate(melody):
        x = brass(hz(note), length * beat + 0.05, k)
        i = int(start * beat * SR)
        total[i:i + len(x)] += 0.6 * x
    # sustained final chord
    for k, note in enumerate(["C4", "E4", "G4", "C5"]):
        x = brass(hz(note), 8 * beat, 20 + k)
        i = int(10 * beat * SR)
        total[i:i + len(x)] += 0.3 * x
    # snare-ish hits on the downbeats
    for st in (0, 3, 5, 7, 10):
        i = int(st * beat * SR)
        m = int(0.15 * SR)
        total[i:i + m] += 0.25 * bandpass(noise(m, 300 + st), 1500, 8000) * env_ad(m, 0.001, 0.04)
    # small room reverb
    ir_n = int(0.6 * SR)
    ir = noise(ir_n, 999) * np.exp(-np.arange(ir_n) / SR / 0.15) * 0.08
    ir[0] = 1.0
    from scipy.signal import fftconvolve
    wet = fftconvolve(total, ir)[:len(total)]
    t = np.arange(len(total)) / SR
    return np.tanh(wet * 0.9) * np.clip((3.4 - t) / 0.3, 0, 1)


def normalise(x, peak_db):
    x = np.asarray(x, float)
    return x / (np.abs(x).max() + 1e-12) * 10 ** (peak_db / 20)


def write_wav(path, x):
    pcm = np.round(np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    return len(pcm)


def _ogg_crc_table():
    tbl = []
    for i in range(256):
        r = i << 24
        for _ in range(8):
            r = ((r << 1) ^ 0x04C11DB7) if r & 0x80000000 else (r << 1)
        tbl.append(r & 0xFFFFFFFF)
    return tbl


_OGG_CRC = _ogg_crc_table()


def pin_ogg_serial(path, serial=0x52414345):
    """libvorbis/libsndfile pick a random Ogg stream serial number per encode.
    Rewrite it to a constant (and fix each page CRC) so builds are byte-reproducible."""
    data = bytearray(Path(path).read_bytes())
    pos = 0
    while pos < len(data):
        if data[pos:pos + 4] != b"OggS":
            raise ValueError(f"bad Ogg page at {pos} in {path}")
        nseg = data[pos + 26]
        size = 27 + nseg + sum(data[pos + 27:pos + 27 + nseg])
        data[pos + 14:pos + 18] = serial.to_bytes(4, "little")
        data[pos + 22:pos + 26] = b"\0\0\0\0"
        crc = 0
        for byte in data[pos:pos + size]:
            crc = ((crc << 8) & 0xFFFFFFFF) ^ _OGG_CRC[((crc >> 24) & 0xFF) ^ byte]
        data[pos + 22:pos + 26] = crc.to_bytes(4, "little")
        pos += size
    Path(path).write_bytes(bytes(data))


def to_ogg(wav, ogg, x):
    """Ogg Vorbis via libsndfile/libvorbis (python-soundfile); falls back to ffmpeg."""
    try:
        import soundfile as sf
        sf.write(str(ogg), x.astype(np.float32), SR, format="OGG", subtype="VORBIS")
        return "libvorbis (libsndfile)"
    except Exception as e:  # pragma: no cover - fallback path
        ff = shutil.which("ffmpeg")
        if not ff:
            raise SystemExit(f"need python-soundfile with OGG/Vorbis or ffmpeg: {e}")
        enc = ["-c:a", "libvorbis", "-q:a", "6"]
        r = subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav), *enc, str(ogg)])
        if r.returncode:
            subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav), "-c:a", "vorbis",
                            "-strict", "-2", "-q:a", "6", str(ogg)], check=True)
            return "ffmpeg native vorbis"
        return "ffmpeg libvorbis"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    sounds = {
        # name: (signal, loop, description, extra metadata)
        "engine_idle": (engine_loop(900, 1), True, "Engine loop at idle", {"base_rpm": 900}),
        "engine_mid": (engine_loop(4000, 2), True, "Engine loop at mid RPM", {"base_rpm": 4000}),
        "engine_high": (engine_loop(7500, 3), True, "Engine loop at high RPM", {"base_rpm": 7500}),
        "tyre_screech_loop": (screech_loop(), True, "Tyre screech / skid loop", {}),
        "collision_light": (collision(False, 51), False, "Light impact (scrape, tap)", {}),
        "collision_heavy": (collision(True, 61), False, "Heavy crash into a wall", {}),
        "nitro_whoosh": (nitro(), False, "Nitro boost activation whoosh", {}),
        "beep_short": (beep(880, 0.18), False, "Countdown beep (3, 2, 1)", {"frequency_hz": 880}),
        "beep_long": (beep(1760, 0.75), False, "Countdown GO beep", {"frequency_hz": 1760}),
        "countdown": (countdown(), False, "Full countdown: 3 short beeps 1 s apart + 1 long beep at t=3 s",
                      {"beep_times_s": [0, 1, 2, 3]}),
        "finish_fanfare": (fanfare(), False, "Short original finish fanfare", {}),
    }
    meta = {}
    for name, (sig, loop, desc, extra) in sounds.items():
        wav = OUT / f"{name}.wav"
        ogg = OUT / f"{name}.ogg"
        sig = normalise(sig, -3.0 if loop else -1.0)
        n = write_wav(wav, sig)
        encoder = to_ogg(wav, ogg, sig)
        pin_ogg_serial(ogg)
        meta[name] = {"wav": f"audio/{name}.wav", "ogg": f"audio/{name}.ogg", "loop": loop,
                      "duration_s": round(n / SR, 4), "samples": n, "description": desc,
                      "ogg_encoder": encoder, **extra}
        if loop:
            meta[name]["loop_start_sample"] = 0
            meta[name]["loop_end_sample"] = n
        print(f"  audio {name}: {n / SR:.2f}s{' (loop)' if loop else ''}")
    (ROOT / "build").mkdir(exist_ok=True)
    (ROOT / "build" / "audio_meta.json").write_text(json.dumps(meta, indent=1))


if __name__ == "__main__":
    main()
