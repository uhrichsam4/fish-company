#!/usr/bin/env python3
"""
Procedural audio generator for Fish Company.

Generates every synthesized sound effect, loop, ambience bed and music
track used by the game as 16-bit PCM WAV files. A separate shell pipeline
(tools/build_audio.sh) encodes these to OGG Vorbis, trims silence, and
copies sourced (Kenney / Openverse) recordings alongside them.

Every sound is deterministic: the RNG is seeded from the sound's name so
re-running this script reproduces byte-identical output.

Usage:
    python3 tools/gen_audio.py --out /path/to/staging/wav [--only name1,name2]

Design notes
------------
* All synthesis is additive/subtractive DSP built on numpy + scipy: noise
  colored via 1/f-family FFT filters, phase-continuous chirps for pitch
  sweeps, a bank-of-bandpass "spectral sweep via STFT mask" for whoosh /
  splash textures, ADSR-ish envelopes, and a small synthetic-impulse
  reverb for tails/shimmer.
* Anything meant to loop seamlessly (engine drones, reels, line tension,
  ambience beds, music) is rendered long, then wrapped with
  `make_seamless()`, which crossfades the tail into the head so the loop
  point is inaudible.
* Stereo ambience/music is produced by rendering two decorrelated mono
  channels (independent noise seeds through the same recipe) rather than
  a delay-based widener -- simpler and artifact-free.
"""
import argparse
import math
import os
import sys
import zlib

import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 44100


# --------------------------------------------------------------------------
# Low-level helpers
# --------------------------------------------------------------------------

def rng_for(name, salt=0):
    seed = (zlib.crc32(f"{name}:{salt}".encode()) ^ 0x9E3779B9) & 0xFFFFFFFF
    return np.random.default_rng(seed)


def n_samples(dur, sr=SR):
    return max(1, int(round(dur * sr)))


def white(n, rng):
    return rng.uniform(-1.0, 1.0, n).astype(np.float64)


def pink(n, rng):
    pad = 2048
    w = white(n + pad, rng)
    X = np.fft.rfft(w)
    freqs = np.fft.rfftfreq(len(w))
    freqs = np.where(freqs == 0, freqs[1] if len(freqs) > 1 else 1.0, freqs)
    X = X / np.sqrt(freqs)
    y = np.fft.irfft(X, n=len(w))
    y = y[pad // 2: pad // 2 + n]
    return y / (np.max(np.abs(y)) + 1e-9)


def brown(n, rng):
    pad = 2048
    w = white(n + pad, rng)
    y = np.cumsum(w)
    y = y - np.mean(y)
    y = y[pad // 2: pad // 2 + n]
    return y / (np.max(np.abs(y)) + 1e-9)


def noise(n, rng, color='white'):
    if color == 'white':
        return white(n, rng)
    if color == 'pink':
        return pink(n, rng)
    if color == 'brown':
        return brown(n, rng)
    raise ValueError(color)


def butter_filt(sig, sr, kind, freq, q=0.8, order=2):
    nyq = sr / 2 - 5
    if kind == 'low':
        f = float(np.clip(freq, 10, nyq))
        sos = signal.butter(order, f, btype='lowpass', fs=sr, output='sos')
    elif kind == 'high':
        f = float(np.clip(freq, 10, nyq))
        sos = signal.butter(order, f, btype='highpass', fs=sr, output='sos')
    else:
        center = float(np.clip(freq, 20, nyq))
        bw = center / max(q, 0.05)
        low = max(10.0, center - bw / 2)
        high = min(nyq, center + bw / 2)
        if high <= low:
            high = low + 10
        sos = signal.butter(order, [low, high], btype='bandpass', fs=sr, output='sos')
    return signal.sosfilt(sos, sig)


def sweep_noise(dur, sr, f0, f1, width_oct=1.1, shape='exp', color='white', rng=None, nperseg=1024):
    """Broadband noise whose energy sweeps from f0 -> f1 Hz over `dur`
    seconds, via an STFT time-frequency Gaussian mask. This is the
    workhorse for whoosh / splash / swoosh style textures."""
    n = n_samples(dur, sr)
    x = noise(n + nperseg, rng, color)
    f, tt, Z = signal.stft(x, fs=sr, nperseg=nperseg, noverlap=int(nperseg * 0.75))
    if shape == 'exp':
        f0c, f1c = max(f0, 20), max(f1, 20)
        ratio = f1c / f0c
        fc = f0c * (ratio ** (tt / max(dur, 1e-6)))
    else:
        fc = f0 + (f1 - f0) * (tt / max(dur, 1e-6))
    logf = np.log2(np.maximum(f, 1e-6))[:, None]
    logfc = np.log2(np.maximum(fc, 1e-6))[None, :]
    mask = np.exp(-0.5 * ((logf - logfc) / width_oct) ** 2)
    Zf = Z * mask
    _, y = signal.istft(Zf, fs=sr, nperseg=nperseg, noverlap=int(nperseg * 0.75))
    y = y[:n]
    if len(y) < n:
        y = np.pad(y, (0, n - len(y)))
    peak = np.max(np.abs(y)) + 1e-9
    return y / peak


def chirp(dur, sr, f0, f1, shape='exp', wave='sine'):
    n = n_samples(dur, sr)
    tt = np.arange(n) / sr
    f0 = max(f0, 1e-3)
    if shape == 'exp' and f1 > 0 and f0 > 0:
        k = (f1 / f0) ** (1.0 / max(dur, 1e-6))
        if abs(k - 1.0) < 1e-9:
            phase = 2 * np.pi * f0 * tt
        else:
            phase = 2 * np.pi * f0 * (k ** tt - 1) / np.log(k)
    else:
        phase = 2 * np.pi * (f0 * tt + (f1 - f0) * tt ** 2 / (2 * max(dur, 1e-6)))
    if wave == 'sine':
        y = np.sin(phase)
    elif wave == 'saw':
        y = signal.sawtooth(phase)
    elif wave == 'square':
        y = signal.square(phase)
    elif wave == 'tri':
        y = signal.sawtooth(phase, width=0.5)
    else:
        raise ValueError(wave)
    return y


def env_ad(n, sr, attack=0.005, hold=0.0, decay_curve=2.2):
    a = min(n_samples(attack, sr), n)
    h = min(n_samples(hold, sr), max(0, n - a))
    d = max(0, n - a - h)
    e = np.zeros(n)
    if a > 0:
        e[:a] = np.linspace(0, 1, a) ** 1.3
    if h > 0:
        e[a:a + h] = 1.0
    if d > 0:
        tail = np.linspace(0, 1, d)
        e[a + h:] = (1 - tail) ** decay_curve
    return e


def env_exp(n, sr, tau):
    tt = np.arange(n) / sr
    return np.exp(-tt / max(tau, 1e-4))


def linramp(n, a, b):
    return np.linspace(a, b, n)


def normalize(sig, peak=0.9):
    m = np.max(np.abs(sig)) + 1e-9
    return sig / m * peak


def soft_clip(sig, drive=1.15):
    return np.tanh(sig * drive) / np.tanh(drive)


def make_ir(dur, sr, decay=0.5, rng=None, tone='low'):
    n = n_samples(dur, sr)
    src = white(n, rng)
    if tone == 'low':
        src = butter_filt(src, sr, 'low', 5200, order=2)
    e = np.exp(-np.arange(n) / sr / max(decay, 0.02))
    return src * e


def apply_reverb(sig, sr, wet=0.22, ir_dur=1.2, decay=0.4, rng=None, tone='low'):
    ir = make_ir(ir_dur, sr, decay=decay, rng=rng, tone=tone)
    ir = ir / (np.max(np.abs(ir)) + 1e-9)
    wet_sig = signal.fftconvolve(sig, ir)
    dry = np.pad(sig, (0, len(wet_sig) - len(sig)))
    out = dry + wet * wet_sig
    return out


def mix(*layers):
    n = max(len(l) for l in layers)
    out = np.zeros(n)
    for l in layers:
        out[:len(l)] += l
    return out


def pad_to(sig, n):
    if len(sig) >= n:
        return sig[:n]
    return np.pad(sig, (0, n - len(sig)))


def click(sr, freq=2500, q=6, dur=0.02, color='white', rng=None):
    n = n_samples(dur, sr)
    x = noise(n, rng, color)
    x = butter_filt(x, sr, 'band', freq, q=q, order=2)
    x *= env_exp(n, sr, dur / 5)
    return normalize(x, 0.9)


def click_train(times_sec, total_dur, sr, click_fn):
    n = n_samples(total_dur, sr)
    out = np.zeros(n)
    for t in times_sec:
        c = click_fn()
        i = n_samples(t, sr)
        end = min(n, i + len(c))
        if end > i:
            out[i:end] += c[:end - i]
    return out


def make_seamless(sig, sr, xf=1.0):
    """Crossfade the tail of a (possibly stereo) buffer into its head so
    it loops with no audible seam. Works on 1D (mono) or 2D (n,2) arrays."""
    stereo = sig.ndim == 2
    n = sig.shape[0]
    x = n_samples(xf, sr)
    if n <= 2 * x:
        return sig
    if stereo:
        head = sig[:x, :]
        body = sig[x:n - x, :]
        tail = sig[n - x:, :]
        fo = np.linspace(1, 0, x)[:, None]
        fi = np.linspace(0, 1, x)[:, None]
    else:
        head = sig[:x]
        body = sig[x:n - x]
        tail = sig[n - x:]
        fo = np.linspace(1, 0, x)
        fi = np.linspace(0, 1, x)
    blended = tail * fo + head * fi
    return np.concatenate([body, blended], axis=0)


def stereo_from(fn, *args, decorrelate=True, **kwargs):
    """Render `fn` twice (independent RNG draws) and stack as stereo."""
    left = fn(*args, **kwargs)
    right = fn(*args, **kwargs) if decorrelate else left.copy()
    n = min(len(left), len(right))
    return np.stack([left[:n], right[:n]], axis=1)


def write_wav(path, sig, sr=SR):
    sig = np.asarray(sig, dtype=np.float64)
    if sig.ndim == 1:
        peak = np.max(np.abs(sig)) + 1e-12
        if peak > 0.995:
            sig = soft_clip(sig, 1.2) * 0.98
        data = np.clip(sig, -1, 1)
        data = (data * 32767).astype(np.int16)
    else:
        peak = np.max(np.abs(sig)) + 1e-12
        if peak > 0.995:
            sig = soft_clip(sig, 1.2) * 0.98
        data = np.clip(sig, -1, 1)
        data = (data * 32767).astype(np.int16)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    wavfile.write(path, sr, data)


def bell_partial(dur, sr, f0, partials=((1, 1.0), (2.0, 0.35), (3.01, 0.18), (4.2, 0.08)), tau=None):
    n = n_samples(dur, sr)
    tt = np.arange(n) / sr
    tau = tau or dur / 3.2
    out = np.zeros(n)
    for mult, amp in partials:
        out += amp * np.sin(2 * np.pi * f0 * mult * tt)
    out *= np.exp(-tt / tau)
    return out


def bell_arp(notes_semi, root, note_dur, gap, sr=SR, wave='bell'):
    total = note_dur + gap * (len(notes_semi) - 1) + note_dur * 1.5
    n = n_samples(total, sr)
    out = np.zeros(n)
    for i, semi in enumerate(notes_semi):
        f = root * (2 ** (semi / 12))
        start = n_samples(i * gap, sr)
        tone = bell_partial(note_dur * 2.2, sr, f)
        end = min(n, start + len(tone))
        out[start:end] += tone[:end - start] * (0.9 - 0.08 * i)
    return out


# --------------------------------------------------------------------------
# Sound family recipes
# --------------------------------------------------------------------------

def whoosh(dur, f0, f1, q=1.1, color='pink', peak=0.75, name='whoosh', salt=0, click_at=None):
    rng = rng_for(name, salt)
    body = sweep_noise(dur, SR, f0, f1, width_oct=q, color=color, rng=rng)
    n = len(body)
    body *= env_ad(n, SR, attack=dur * 0.18, hold=dur * 0.08, decay_curve=1.6)
    if click_at is not None:
        c = click(SR, freq=2400, q=5, dur=0.03, rng=rng)
        i = n_samples(click_at, SR)
        end = min(n, i + len(c))
        body[i:end] += c[:end - i] * 0.5
    return normalize(body, peak)


def gen_cast_whoosh():
    return whoosh(0.34, 550, 2800, q=1.3, color='pink', peak=0.7, name='cast_whoosh', click_at=0.27)


def gen_spear_throw():
    return whoosh(0.22, 750, 3400, q=1.0, color='pink', peak=0.75, name='spear_throw')


def gen_net_throw():
    rng = rng_for('net_throw')
    w = sweep_noise(0.38, SR, 1300, 480, width_oct=1.4, color='pink', rng=rng)
    n = len(w)
    w *= env_ad(n, SR, attack=0.05, hold=0.06, decay_curve=1.4)
    # cloth flutter: amplitude-modulated high-passed noise
    flut = noise(n, rng, 'white')
    flut = butter_filt(flut, SR, 'high', 2200, order=2)
    lfo = 0.5 + 0.5 * np.sin(2 * np.pi * 11 * np.arange(n) / SR + rng.uniform(0, 6))
    flut *= lfo * env_ad(n, SR, attack=0.03, hold=0.2, decay_curve=1.2) * 0.35
    return normalize(mix(w, flut), 0.6)


def gen_harpoon_fire():
    rng = rng_for('harpoon_fire')
    w = sweep_noise(0.26, SR, 3400, 420, width_oct=1.0, color='white', rng=rng)
    n = len(w)
    w *= env_ad(n, SR, attack=0.002, hold=0.02, decay_curve=1.8)
    mech = click(SR, freq=1800, q=4, dur=0.05, rng=rng)
    out = np.zeros(n)
    out[:len(w)] += w * 0.85
    out[:len(mech)] += mech * 0.6
    thump = np.sin(2 * np.pi * 70 * np.arange(n) / SR) * env_exp(n, SR, 0.05) * 0.3
    return normalize(mix(out, thump), 0.85)


def gen_gun_shot():
    rng = rng_for('gun_shot')
    n = n_samples(0.32, SR)
    crack = noise(n, rng, 'white')
    crack = butter_filt(crack, SR, 'low', 6000, order=2)
    crack *= env_exp(n, SR, 0.02)
    boom = noise(n, rng, 'brown')
    boom = butter_filt(boom, SR, 'low', 220, order=3)
    boom *= env_ad(n, SR, attack=0.001, hold=0.01, decay_curve=1.4) * env_exp(n, SR, 0.12)
    sub = np.sin(2 * np.pi * 62 * np.arange(n) / SR) * env_exp(n, SR, 0.09)
    out = crack * 0.8 + boom * 0.9 + sub * 0.5
    return normalize(soft_clip(out, 1.3), 0.95)


def gen_club_hit_synth_layer():
    rng = rng_for('club_hit_layer')
    n = n_samples(0.22, SR)
    body = noise(n, rng, 'brown')
    body = butter_filt(body, SR, 'low', 500, order=3)
    body *= env_exp(n, SR, 0.05)
    return normalize(body, 0.8)


def splash(dur, size, name):
    rng = rng_for(name)
    f0 = {'small': 3200, 'medium': 2200, 'big': 1600}[size]
    f1 = {'small': 650, 'medium': 320, 'big': 130}[size]
    body = sweep_noise(dur, SR, f0, f1, width_oct=1.15, color='white', rng=rng)
    n = len(body)
    body *= env_ad(n, SR, attack=0.004, hold=dur * 0.04, decay_curve=1.9)
    # low "plop" thump for weight, scaled with size
    thump_f = {'small': 210, 'medium': 140, 'big': 85}[size]
    thump_amt = {'small': 0.25, 'medium': 0.45, 'big': 0.75}[size]
    thump = np.sin(2 * np.pi * thump_f * np.arange(n) / SR) * env_exp(n, SR, dur * 0.22) * thump_amt
    # bright droplet fizz tail (settling foam), only for medium/big
    out = body * 0.85 + thump
    if size != 'small':
        fizz = noise(n, rng, 'pink')
        fizz = butter_filt(fizz, SR, 'high', 2800, order=2)
        fizz *= env_ad(n, SR, attack=dur * 0.15, hold=0, decay_curve=1.1) * 0.25
        out = mix(out, fizz)
    peak = {'small': 0.55, 'medium': 0.75, 'big': 0.95}[size]
    return normalize(out, peak)


def gen_splash_small():
    return splash(0.3, 'small', 'splash_small')


def gen_splash_medium():
    return splash(0.55, 'medium', 'splash_medium')


def gen_splash_big():
    return splash(1.05, 'big', 'splash_big')


def gen_fish_bite():
    rng = rng_for('fish_bite')
    n = n_samples(0.18, SR)
    thud = noise(n, rng, 'brown')
    thud = butter_filt(thud, SR, 'low', 420, order=3)
    thud *= env_ad(n, SR, attack=0.001, hold=0.01, decay_curve=1.6)
    tick = chirp(0.05, SR, 900, 300, wave='square')
    tick *= env_exp(len(tick), SR, 0.02)
    out = np.zeros(n)
    out[:len(thud)] += thud
    i = n_samples(0.02, SR)
    end = min(n, i + len(tick))
    out[i:end] += tick[:end - i] * 0.35
    return normalize(out, 0.7)


def fish_flop_variant(idx):
    rng = rng_for('fish_flop', idx)
    dur = 0.22 + rng.uniform(-0.02, 0.03)
    n = n_samples(dur, SR)
    wet = noise(n, rng, 'brown')
    wet = butter_filt(wet, SR, 'low', 900 + rng.uniform(-100, 150), order=2)
    wet *= env_ad(n, SR, attack=0.002, hold=0.005, decay_curve=1.7)
    slap = noise(n, rng, 'white')
    slap = butter_filt(slap, SR, 'band', 1400 + rng.uniform(-200, 300), q=1.3, order=2)
    slap *= env_exp(n, SR, 0.02)
    out = wet * 0.8 + slap * 0.4
    return normalize(out, 0.7)


def gen_fish_impact():
    rng = rng_for('fish_impact')
    n = n_samples(0.26, SR)
    wet = noise(n, rng, 'brown')
    wet = butter_filt(wet, SR, 'low', 480, order=3)
    wet *= env_ad(n, SR, attack=0.001, hold=0.01, decay_curve=1.5)
    crack = noise(n, rng, 'white')
    crack = butter_filt(crack, SR, 'band', 1200, q=1.0, order=2)
    crack *= env_exp(n, SR, 0.015)
    return normalize(mix(wet * 0.9, crack * 0.3), 0.82)


def gen_fish_thrash():
    rng = rng_for('fish_thrash')
    dur = 0.6
    n = n_samples(dur, SR)
    out = np.zeros(n)
    hits = sorted(rng.uniform(0.02, dur - 0.15, 4))
    for h in hits:
        s = splash(0.22, 'small', f'fish_thrash_{h:.3f}')
        i = n_samples(h, SR)
        end = min(n, i + len(s))
        out[i:end] += s[:end - i] * rng.uniform(0.5, 0.85)
    swell = noise(n, rng, 'white')
    swell = butter_filt(swell, SR, 'band', 1800, q=0.7, order=2)
    swell *= env_ad(n, SR, attack=0.05, hold=dur * 0.5, decay_curve=1.3) * 0.3
    return normalize(mix(out, swell), 0.88)


def footstep_variant(surface, idx, name_base):
    rng = rng_for(name_base, idx)
    if surface == 'sand':
        dur = 0.13 + rng.uniform(-0.01, 0.02)
        n = n_samples(dur, SR)
        grains = noise(n, rng, 'pink')
        grains = butter_filt(grains, SR, 'band', 1400 + rng.uniform(-150, 150), q=1.1, order=2)
        grains *= env_ad(n, SR, attack=0.006, hold=0.01, decay_curve=1.4)
        thud = noise(n, rng, 'brown')
        thud = butter_filt(thud, SR, 'low', 220, order=2)
        thud *= env_exp(n, SR, 0.04) * 0.4
        out = grains * 0.6 + thud
        return normalize(out, 0.4)
    raise ValueError(surface)


def gen_jump():
    rng = rng_for('jump')
    w = sweep_noise(0.15, SR, 700, 1700, width_oct=1.2, color='pink', rng=rng)
    n = len(w)
    w *= env_ad(n, SR, attack=0.01, hold=0.02, decay_curve=1.6)
    return normalize(w, 0.45)


def gen_land():
    rng = rng_for('land')
    n = n_samples(0.2, SR)
    thud = noise(n, rng, 'brown')
    thud = butter_filt(thud, SR, 'low', 260, order=3)
    thud *= env_ad(n, SR, attack=0.002, hold=0.01, decay_curve=1.6)
    scuff = noise(n, rng, 'pink')
    scuff = butter_filt(scuff, SR, 'band', 1600, q=1.0, order=2)
    scuff *= env_exp(n, SR, 0.03) * 0.25
    return normalize(mix(thud, scuff), 0.6)


def gen_reel_click():
    rng = rng_for('reel_click')
    c = click(SR, freq=3600, q=7, dur=0.045, color='white', rng=rng)
    body = noise(len(c), rng, 'brown')
    body = butter_filt(body, SR, 'low', 900, order=2)[:len(c)]
    body *= env_exp(len(c), SR, 0.015) * 0.3
    return normalize(mix(c, body), 0.55)


def gen_line_snap():
    rng = rng_for('line_snap')
    dur = 0.28
    n = n_samples(dur, SR)
    twang = chirp(0.14, SR, 2200, 180, shape='exp', wave='saw')
    twang *= env_exp(len(twang), SR, 0.05)
    crack = noise(n_samples(0.02, SR), rng, 'white')
    crack = butter_filt(crack, SR, 'high', 3000, order=2)
    crack *= env_exp(len(crack), SR, 0.006)
    out = np.zeros(n)
    out[:len(crack)] += crack * 0.8
    out[:len(twang)] += twang * 0.6
    return normalize(soft_clip(out, 1.2), 0.75)


def gen_crate_break():
    rng = rng_for('crate_break')
    dur = 0.5
    n = n_samples(dur, SR)
    out = np.zeros(n)
    hits = [0.0, 0.03, 0.07, 0.12]
    for i, h in enumerate(hits):
        d = n_samples(0.12, SR)
        w = noise(d, rng, 'brown' if i == 0 else 'white')
        kind = 'low' if i == 0 else 'band'
        w = butter_filt(w, SR, kind, 700 - i * 90 if i == 0 else 1800 - i * 250, q=1.3, order=2)
        w *= env_exp(d, SR, 0.05 - i * 0.005)
        start = n_samples(h, SR)
        end = min(n, start + d)
        out[start:end] += w[:end - start] * (0.9 - i * 0.15)
    splinters = noise(n, rng, 'pink')
    splinters = butter_filt(splinters, SR, 'band', 2600, q=1.0, order=2)
    splinters *= env_ad(n, SR, attack=0.01, hold=0.03, decay_curve=1.6) * 0.35
    return normalize(mix(out, splinters), 0.85)


def gen_boat_impact_layer():
    rng = rng_for('boat_impact_layer')
    n = n_samples(0.5, SR)
    boom = noise(n, rng, 'brown')
    boom = butter_filt(boom, SR, 'low', 160, order=3)
    boom *= env_ad(n, SR, attack=0.003, hold=0.03, decay_curve=1.4)
    sub = np.sin(2 * np.pi * 48 * np.arange(n) / SR) * env_exp(n, SR, 0.22) * 0.5
    return normalize(mix(boom, sub), 0.85)


def gen_boss_slam_layer():
    rng = rng_for('boss_slam_layer')
    n = n_samples(1.0, SR)
    boom = noise(n, rng, 'brown')
    boom = butter_filt(boom, SR, 'low', 130, order=3)
    boom *= env_ad(n, SR, attack=0.004, hold=0.05, decay_curve=1.3)
    sub = np.sin(2 * np.pi * 42 * np.arange(n) / SR) * env_exp(n, SR, 0.55) * 0.6
    return normalize(mix(boom, sub), 0.95)


def gen_boss_roar():
    rng = rng_for('boss_roar')
    dur = 2.3
    n = n_samples(dur, SR)
    tt = np.arange(n) / SR
    f = 95 * np.exp(-tt / 1.6) + 55
    phase = 2 * np.pi * np.cumsum(f) / SR
    vocal = signal.sawtooth(phase) * 0.6 + np.sin(phase * 1.003) * 0.4
    vocal = soft_clip(vocal, 2.4)
    trem = 1 - 0.22 * (0.5 + 0.5 * np.sin(2 * np.pi * 6.5 * tt))
    vocal *= trem
    vocal = butter_filt(vocal, SR, 'band', 420, q=1.4, order=2) * 0.6 + vocal * 0.5
    breath = noise(n, rng, 'brown')
    breath = butter_filt(breath, SR, 'band', 500, q=0.9, order=2)
    env = env_ad(n, SR, attack=0.25, hold=dur * 0.35, decay_curve=1.5)
    out = (vocal * 0.8 + breath * 0.5) * env
    out = apply_reverb(out, SR, wet=0.18, ir_dur=0.8, decay=0.3, rng=rng)
    return normalize(soft_clip(out, 1.3), 0.95)


def gen_radio_static():
    rng = rng_for('radio_static')
    dur = 0.55
    n = n_samples(dur, SR)
    hiss = noise(n, rng, 'white')
    hiss = butter_filt(hiss, SR, 'band', 2600, q=0.6, order=2)
    am = 0.6 + 0.4 * noise(n, rng, 'pink')
    am = np.clip(am, 0, 1.4)
    out = hiss * am
    # sparse crackle impulses
    n_crackles = 14
    for _ in range(n_crackles):
        i = rng.integers(0, n - 40)
        out[i:i + 20] += rng.uniform(-1, 1, 20) * 0.5
    out *= env_ad(n, SR, attack=0.01, hold=dur * 0.7, decay_curve=1.2)
    return normalize(out, 0.5)


def gen_sonar_ping():
    rng = rng_for('sonar_ping')
    dur = 1.3
    ping = chirp(0.16, SR, 1500, 900, shape='exp', wave='sine')
    ping *= env_ad(len(ping), SR, attack=0.004, hold=0.02, decay_curve=1.8)
    n = n_samples(dur, SR)
    out = pad_to(ping, n)
    out = apply_reverb(out, SR, wet=0.55, ir_dur=1.6, decay=0.7, rng=rng, tone='low')
    return normalize(out, 0.55)


def gen_sub_dive():
    rng = rng_for('sub_dive')
    dur = 1.9
    w = sweep_noise(dur, SR, 900, 110, width_oct=1.2, color='brown', rng=rng)
    n = len(w)
    w *= env_ad(n, SR, attack=0.1, hold=dur * 0.3, decay_curve=1.4)
    bub = gen_bubbles_core(dur, rng, density=18)
    out = mix(w * 0.8, bub * 0.5)
    return normalize(out, 0.75)


def gen_bubbles_core(dur, rng, density=12, margin=0.0):
    n = n_samples(dur, SR)
    out = np.zeros(n)
    lo, hi = margin, max(margin, dur - margin)
    times = np.sort(rng.uniform(lo, hi, density))
    for t in times:
        d = rng.uniform(0.03, 0.09)
        m = n_samples(d, SR)
        f0 = rng.uniform(400, 700)
        f1 = f0 * rng.uniform(1.6, 2.6)
        pop = chirp(d, SR, f0, f1, shape='exp', wave='sine')
        pop *= env_ad(m, SR, attack=0.004, hold=0.0, decay_curve=1.6)
        i = n_samples(t, SR)
        end = min(n, i + m)
        if end > i:
            out[i:end] += pop[:end - i] * rng.uniform(0.35, 0.7)
    return out


def gen_bubbles():
    rng = rng_for('bubbles')
    return normalize(gen_bubbles_core(0.65, rng, density=10), 0.5)


def gen_underwater_whoosh():
    rng = rng_for('underwater_whoosh')
    w = sweep_noise(0.75, SR, 1100, 180, width_oct=1.3, color='brown', rng=rng)
    n = len(w)
    w *= env_ad(n, SR, attack=0.08, hold=0.15, decay_curve=1.5)
    return normalize(w, 0.6)


def gen_pickup_synth():
    n = n_samples(0.1, SR)
    t = chirp(0.1, SR, 780, 1300, wave='tri')
    t *= env_ad(n, SR, attack=0.004, hold=0.01, decay_curve=1.8)
    return normalize(t, 0.4)


def coin_variant(idx):
    rng = rng_for('coin', idx)
    root = 1500 + idx * 90
    n = n_samples(0.16, SR)
    b = bell_partial(0.16, SR, root, partials=((1, 1.0), (2.4, 0.5), (4.0, 0.22)), tau=0.06)
    b2 = bell_partial(0.16, SR, root * 1.5, partials=((1, 0.7),), tau=0.05)
    i2 = n_samples(0.035, SR)
    out = np.zeros(n)
    out[:len(b)] += b
    end = min(n, i2 + len(b2))
    out[i2:end] += b2[:end - i2] * 0.6
    return normalize(out, 0.55)


def combo_variant(idx):
    """idx 1..5, strictly ascending pitch for a satisfying combo ladder."""
    rng = rng_for('combo', idx)
    root = 520 * (2 ** ((idx - 1) / 5))
    n = n_samples(0.14, SR)
    tone = chirp(0.1, SR, root, root * 1.12, wave='square')
    tone *= env_ad(len(tone), SR, attack=0.003, hold=0.02, decay_curve=1.6)
    sine = np.sin(2 * np.pi * root * 2 * np.arange(len(tone)) / SR) * env_exp(len(tone), SR, 0.05) * 0.25
    out = pad_to(tone * 0.5 + sine, n)
    return normalize(out, 0.4)


def gen_cash_register_synth_layer():
    rng = rng_for('cash_register_layer')
    bell = bell_arp([0, 4, 7], 1046, 0.11, 0.045)
    n = len(bell)
    slide = noise(n, rng, 'white')
    slide = butter_filt(slide, SR, 'high', 4000, order=2)
    slide *= env_ad(n, SR, attack=0.01, hold=0.05, decay_curve=1.4) * 0.15
    return normalize(mix(bell, slide), 0.7)


def gen_rare_fish():
    rng = rng_for('rare_fish')
    arp = bell_arp([0, 7, 12, 16, 19], 784, 0.16, 0.075)
    n = len(arp)
    shimmer = noise(n, rng, 'white')
    shimmer = butter_filt(shimmer, SR, 'high', 6000, order=2)
    trem = 0.5 + 0.5 * np.sin(2 * np.pi * 7 * np.arange(n) / SR)
    shimmer *= trem * env_ad(n, SR, attack=0.05, hold=n / SR * 0.6, decay_curve=1.3) * 0.22
    out = mix(arp, shimmer)
    out = apply_reverb(out, SR, wet=0.3, ir_dur=1.4, decay=0.6, rng=rng)
    return normalize(out, 0.7)


def gen_legendary_synth_layer():
    rng = rng_for('legendary_layer')
    dur = 1.7
    n = n_samples(dur, SR)
    riser = chirp(dur * 0.7, SR, 42, 95, shape='lin', wave='sine')
    riser *= env_ad(len(riser), SR, attack=dur * 0.3, hold=0, decay_curve=1.0)
    chord = np.zeros(n)
    for semi, amp in [(0, 0.5), (3, 0.35), (7, 0.3), (12, 0.25)]:
        f = 130.8 * (2 ** (semi / 12))
        tone = signal.sawtooth(2 * np.pi * f * np.arange(n) / SR)
        chord += tone * amp
    chord = butter_filt(chord, SR, 'low', 1400, order=2)
    chord *= env_ad(n, SR, attack=0.02, hold=dur * 0.55, decay_curve=1.5)
    cym = noise(n, rng, 'white')
    cym = butter_filt(cym, SR, 'high', 5000, order=2)
    cym *= env_ad(n, SR, attack=0.01, hold=0.05, decay_curve=1.1) * 0.35
    out = pad_to(riser, n) * 0.6 + chord * 0.6 + cym
    out = apply_reverb(out, SR, wet=0.25, ir_dur=1.5, decay=0.6, rng=rng)
    return normalize(soft_clip(out, 1.2), 0.9)


def gen_harpoon_impact_layer():
    rng = rng_for('harpoon_impact_layer')
    n = n_samples(0.3, SR)
    thump = noise(n, rng, 'brown')
    thump = butter_filt(thump, SR, 'low', 260, order=3)
    thump *= env_ad(n, SR, attack=0.002, hold=0.02, decay_curve=1.5)
    return normalize(thump, 0.85)


def gen_explosion_synth_layer():
    rng = rng_for('explosion_layer')
    dur = 1.5
    n = n_samples(dur, SR)
    boom = noise(n, rng, 'brown')
    boom = butter_filt(boom, SR, 'low', 90, order=3)
    boom *= env_ad(n, SR, attack=0.01, hold=0.25, decay_curve=1.2)
    sub = np.sin(2 * np.pi * 38 * np.arange(n) / SR) * env_exp(n, SR, 0.7) * 0.6
    return normalize(mix(boom, sub), 0.95)


# ---- mechanical loops -----------------------------------------------------

def gen_reel_loop():
    """Periodic ratchet clicks. The loop length is snapped to an exact
    integer number of click periods so the click *rhythm* tiles perfectly
    with zero crossfade needed; the short crossfade below only smooths the
    continuous whir bed underneath (never a discrete transient)."""
    rng = rng_for('reel_loop')
    clicks_per_sec = 5.2
    period = 1.0 / clicks_per_sec
    n_clicks_per_loop = 20
    dur = period * n_clicks_per_loop
    times = [i * period for i in range(n_clicks_per_loop)]

    def cf():
        return click(SR, freq=3400 + rng.uniform(-150, 150), q=6.5, dur=0.05, color='white', rng=rng)

    body = click_train(times, dur, SR, cf)
    # soft continuous mechanical whir underneath
    whir = noise(len(body), rng, 'pink')
    whir = butter_filt(whir, SR, 'band', 800, q=1.2, order=2) * 0.12
    out = normalize(mix(body, whir), 0.6)
    return make_seamless(out, SR, xf=0.04)


def gen_line_tension():
    rng = rng_for('line_tension')
    dur = 3.5
    n = n_samples(dur, SR)
    tt = np.arange(n) / SR
    base = signal.sawtooth(2 * np.pi * 175 * tt)
    base = butter_filt(base, SR, 'band', 420, q=8, order=2)
    creak_lfo = 0.5 + 0.5 * np.sin(2 * np.pi * 0.6 * tt + rng.uniform(0, 6))
    grain = noise(n, rng, 'pink') * 0.15
    out = base * (0.3 + 0.4 * creak_lfo) + grain
    out = normalize(out, 0.5)
    return make_seamless(out, SR, xf=0.6)


def gen_cast_charge():
    rng = rng_for('cast_charge')
    dur = 3.0
    n = n_samples(dur, SR)
    tt = np.arange(n) / SR
    hum = signal.sawtooth(2 * np.pi * 130 * tt) * 0.5 + np.sin(2 * np.pi * 260 * tt) * 0.25
    hum = butter_filt(hum, SR, 'band', 500, q=1.8, order=2)
    pulse = 0.7 + 0.3 * np.sin(2 * np.pi * 5.5 * tt)
    shimmer = noise(n, rng, 'white')
    shimmer = butter_filt(shimmer, SR, 'high', 4500, order=2) * 0.08
    out = hum * pulse + shimmer
    out = normalize(out, 0.5)
    return make_seamless(out, SR, xf=0.5)


def _engine_bed(dur, sr, rng, rpm_hz=28.0, growl=1.0):
    n = n_samples(dur, sr)
    tt = np.arange(n) / sr
    # pulse train via band-limited sawtooth stack (piston firing harmonics)
    fund = signal.sawtooth(2 * np.pi * rpm_hz * tt)
    sub = signal.square(2 * np.pi * rpm_hz * 0.5 * tt)
    mixed = fund * 0.6 + sub * 0.45
    mixed = butter_filt(mixed, sr, 'low', 380 * growl, order=2)
    rumble = noise(n, rng, 'brown')
    rumble = butter_filt(rumble, sr, 'low', 160, order=2) * 0.35
    chug = 0.85 + 0.15 * signal.sawtooth(2 * np.pi * rpm_hz * tt, width=0.3)
    out = (mixed + rumble) * chug
    return out


def gen_boat_engine_loop():
    rng = rng_for('boat_engine_loop')
    dur = 3.2
    out = _engine_bed(dur, SR, rng, rpm_hz=27.0)
    out = normalize(out, 0.55)
    return make_seamless(out, SR, xf=0.5)


def gen_boat_engine_start():
    rng = rng_for('boat_engine_start')
    dur = 1.3
    n = n_samples(dur, SR)
    tt = np.arange(n) / SR
    crank = noise(n_samples(0.35, SR), rng, 'white')
    crank = butter_filt(crank, SR, 'band', 500, q=2, order=2)
    crank *= env_ad(len(crank), SR, attack=0.01, hold=0.2, decay_curve=1.4) * 0.5
    rpm = 8 + 20 * np.clip((tt - 0.3) / (dur - 0.3), 0, 1)
    phase = 2 * np.pi * np.cumsum(rpm) / SR
    body = signal.sawtooth(phase) * 0.5
    body = butter_filt(body, SR, 'low', 500, order=2)
    body *= np.clip((tt - 0.3) / 0.3, 0, 1)
    out = np.zeros(n)
    out[:len(crank)] += crank
    out += body
    return normalize(out, 0.7)


def gen_boat_engine_stop():
    rng = rng_for('boat_engine_stop')
    dur = 1.1
    n = n_samples(dur, SR)
    tt = np.arange(n) / SR
    rpm = 27 * np.exp(-tt / 0.35)
    phase = 2 * np.pi * np.cumsum(rpm) / SR
    body = signal.sawtooth(phase) * 0.5
    body = butter_filt(body, SR, 'low', 420, order=2)
    body *= env_exp(n, SR, 0.4)
    sputter = noise(n, rng, 'white')
    sputter = butter_filt(sputter, SR, 'band', 700, q=1.5, order=2) * env_exp(n, SR, 0.25) * 0.2
    return normalize(mix(body, sputter), 0.65)


def gen_boat_wake():
    rng = rng_for('boat_wake')
    dur = 4.0
    n = n_samples(dur, SR)
    tt = np.arange(n) / SR
    hiss = noise(n, rng, 'white')
    hiss = butter_filt(hiss, SR, 'band', 1200, q=0.6, order=2)
    swell = 0.7 + 0.3 * np.sin(2 * np.pi * 0.18 * tt + rng.uniform(0, 6))
    out = hiss * swell
    out = normalize(out, 0.5)
    return make_seamless(out, SR, xf=0.6)


def gen_sub_ambient_loop():
    rng = rng_for('sub_ambient_loop')
    dur = 6.0
    n = n_samples(dur, SR)
    tt = np.arange(n) / SR
    drone = np.sin(2 * np.pi * 46 * tt) * 0.3 + np.sin(2 * np.pi * 69 * tt) * 0.15
    hum = noise(n, rng, 'brown')
    hum = butter_filt(hum, SR, 'low', 220, order=2) * 0.4
    breathing = 0.85 + 0.15 * np.sin(2 * np.pi * 0.12 * tt)
    out = (drone + hum) * breathing
    out = normalize(out, 0.45)
    return make_seamless(out, SR, xf=1.0)


def creak_variant(idx):
    rng = rng_for('sub_creak_synth', idx)
    dur = 1.1 + rng.uniform(-0.1, 0.2)
    n = n_samples(dur, SR)
    tt = np.arange(n) / SR
    f = 150 + 40 * np.sin(2 * np.pi * 0.9 * tt) + rng.uniform(-15, 15)
    tone = signal.sawtooth(2 * np.pi * np.cumsum(f) / SR)
    tone = butter_filt(tone, SR, 'band', 260, q=5, order=2)
    grain = noise(n, rng, 'brown') * 0.2
    env = env_ad(n, SR, attack=0.06, hold=dur * 0.5, decay_curve=1.6)
    out = (tone * 0.6 + grain) * env
    return normalize(out, 0.55)


# ---- ambience (synthesized) -----------------------------------------------

def _rain_bed(dur, sr, rng, density='rain'):
    n = n_samples(dur, sr)
    hiss = noise(n, rng, 'white')
    hiss = butter_filt(hiss, sr, 'high', 1100, order=2)
    hiss = butter_filt(hiss, sr, 'low', 6500 if density == 'storm' else 5000, order=2)
    out = hiss
    n_drops = int(dur * (60 if density == 'storm' else 30))
    for _ in range(n_drops):
        t = rng.uniform(0, dur - 0.05)
        d = n_samples(0.02, sr)
        i = n_samples(t, sr)
        drop = noise(d, rng, 'white')
        drop = butter_filt(drop, sr, 'band', rng.uniform(2500, 6000), q=2, order=2)
        drop *= env_exp(d, sr, 0.006)
        end = min(n, i + d)
        if end > i:
            out[i:end] += drop[:end - i] * 0.4
    return out


def gen_amb_storm():
    def one(seed_salt):
        rng = rng_for('amb_storm', seed_salt)
        dur = 26.0
        n = n_samples(dur, SR)
        tt = np.arange(n) / SR
        rain = _rain_bed(dur, SR, rng, density='storm')
        wind = noise(n, rng, 'pink')
        wind = butter_filt(wind, SR, 'band', 380, q=0.6, order=2)
        wind *= 0.6 + 0.4 * np.sin(2 * np.pi * 0.05 * tt + rng.uniform(0, 6))
        xf_margin = 2.0  # keep rumbles clear of the make_seamless() crossfade zone
        max_rumble = 4.0
        rumble_times = sorted(rng.uniform(xf_margin + 0.5, dur - xf_margin - max_rumble - 0.5, 3))
        rumble = np.zeros(n)
        for rt in rumble_times:
            d = n_samples(rng.uniform(2.5, 4.0), SR)
            rb = noise(d, rng, 'brown')
            rb = butter_filt(rb, SR, 'low', 90, order=3)
            rb *= env_ad(d, SR, attack=0.3, hold=d / SR * 0.3, decay_curve=1.3)
            i = n_samples(rt, SR)
            end = min(n, i + d)
            rumble[i:end] += rb[:end - i] * 0.5
        out = rain * 0.7 + wind * 0.5 + rumble
        return normalize(out, 0.8)
    st = np.stack([one(1), one(2)], axis=1)
    return make_seamless(st, SR, xf=2.0)


def gen_amb_underwater():
    def one(salt):
        rng = rng_for('amb_underwater', salt)
        dur = 22.0
        n = n_samples(dur, SR)
        tt = np.arange(n) / SR
        base = noise(n, rng, 'brown')
        base = butter_filt(base, SR, 'low', 420, order=3)
        swell = 0.8 + 0.2 * np.sin(2 * np.pi * 0.07 * tt + rng.uniform(0, 6))
        bub = gen_bubbles_core(dur, rng, density=int(dur * 1.2), margin=1.7)
        out = base * swell * 0.7 + bub * 0.15
        return normalize(out, 0.6)
    st = np.stack([one(1), one(2)], axis=1)
    return make_seamless(st, SR, xf=1.5)


def gen_amb_harbor_synth():
    """Fallback used only if the sourced harbor field-recording is
    unavailable: gentle water lapping against pilings + slow wood/rope
    creaks, kept clear of the loop crossfade zone."""
    def one(salt):
        rng = rng_for('amb_harbor_synth', salt)
        dur = 24.0
        n = n_samples(dur, SR)
        tt = np.arange(n) / SR
        lap = noise(n, rng, 'pink')
        lap = butter_filt(lap, SR, 'low', 700, order=2)
        lap *= 0.6 + 0.4 * np.sin(2 * np.pi * 0.22 * tt + rng.uniform(0, 6))
        xf_margin, max_creak = 1.5, 1.6
        creak_times = sorted(rng.uniform(xf_margin + 0.5, dur - xf_margin - max_creak - 0.5, 4))
        creaks = np.zeros(n)
        for ct in creak_times:
            c = creak_variant(int(rng.integers(1, 4)))
            i = n_samples(ct, SR)
            end = min(n, i + len(c))
            if end > i:
                creaks[i:end] += c[:end - i] * 0.35
        out = lap * 0.5 + creaks
        return normalize(out, 0.55)
    st = np.stack([one(1), one(2)], axis=1)
    return make_seamless(st, SR, xf=1.5)


def gen_amb_deep():
    def one(salt):
        rng = rng_for('amb_deep', salt)
        dur = 30.0
        n = n_samples(dur, SR)
        tt = np.arange(n) / SR
        drone = np.sin(2 * np.pi * 38 * tt) * 0.25 + np.sin(2 * np.pi * 57.2 * tt) * 0.12
        hum = noise(n, rng, 'brown')
        hum = butter_filt(hum, SR, 'low', 130, order=3) * 0.5
        # distant whale-esque moan, very sparse -- kept clear of the loop
        # crossfade zone (xf=2.5) so it never gets chopped/doubled at the seam
        moan = np.zeros(n)
        moan_times = sorted(rng.uniform(3.5, dur - 9.5, 2))
        for mt in moan_times:
            md = n_samples(rng.uniform(3.5, 5.5), SR)
            mf0, mf1 = rng.uniform(70, 90), rng.uniform(45, 60)
            mtone = chirp(md / SR, SR, mf0, mf1, shape='lin', wave='sine')
            mtone *= env_ad(md, SR, attack=md / SR * 0.3, hold=md / SR * 0.3, decay_curve=1.5) * 0.2
            i = n_samples(mt, SR)
            end = min(n, i + md)
            moan[i:end] += mtone[:end - i]
        breathing = 0.9 + 0.1 * np.sin(2 * np.pi * 0.04 * tt)
        out = (drone + hum) * breathing + moan
        return normalize(out, 0.55)
    st = np.stack([one(1), one(2)], axis=1)
    return make_seamless(st, SR, xf=2.5)


# ---- music (procedural ambient pads) --------------------------------------

CHORDS = {
    'calm': [[0, 4, 7, 11], [9, 12, 16, 19], [7, 11, 14, 17], [5, 9, 12, 16]],   # Imaj7-vi-V-IV feel
    'menu': [[0, 4, 7], [5, 9, 12], [7, 11, 14], [0, 4, 7]],
    'deep': [[0, 3, 7], [10, 15, 19], [8, 12, 15], [5, 8, 12]],   # minor, sparse
    'boss': [[0, 3, 6], [1, 4, 8], [0, 3, 6], [6, 9, 12]],       # dissonant, tense
}


def _pad_layer(freq, n, sr, rng, wave='sine', detune_cents=6, lfo_hz=0.13, lfo_amt=0.4):
    tt = np.arange(n) / sr
    d = 2 ** (detune_cents / 1200)
    a = np.sin(2 * np.pi * freq * tt)
    b = np.sin(2 * np.pi * freq * d * tt)
    c = signal.sawtooth(2 * np.pi * freq / 2 * tt) if wave == 'saw' else 0
    lfo = 1 - lfo_amt + lfo_amt * (0.5 + 0.5 * np.sin(2 * np.pi * lfo_hz * tt + rng.uniform(0, 6)))
    out = (a * 0.55 + b * 0.45 + (c * 0.15 if wave == 'saw' else 0)) * lfo
    return out


def music_track(name, root_hz, mood, dur_per_chord, wave='sine', bass=True, noise_amt=0.02,
                 brightness=3800, repeats=2):
    """Slow ambient pad progression. The chord list is tiled `repeats`
    times to reach a substantial (60-120s) loop length per the spec, and a
    very slow whole-track brightness swell (period independent of the
    chord cycle) keeps repeats from sounding perfectly static."""
    def one(salt):
        rng = rng_for(name, salt)
        chords = CHORDS[mood] * repeats
        total = dur_per_chord * len(chords)
        n = n_samples(total, SR)
        out = np.zeros(n)
        for ci, notes in enumerate(chords):
            seg_n = n_samples(dur_per_chord, SR)
            start = ci * seg_n
            seg = np.zeros(seg_n)
            for semi in notes:
                f = root_hz * (2 ** (semi / 12)) / 2
                seg += _pad_layer(f, seg_n, SR, rng, wave=wave, detune_cents=rng.uniform(4, 9)) / len(notes)
            if bass:
                bf = root_hz * (2 ** (notes[0] / 12)) / 4
                seg += np.sin(2 * np.pi * bf * np.arange(seg_n) / SR) * 0.18
            fade = min(n_samples(dur_per_chord * 0.4, SR), seg_n // 2)
            env = np.ones(seg_n)
            env[:fade] *= np.linspace(0, 1, fade)
            env[-fade:] *= np.linspace(1, 0, fade)
            end = min(n, start + seg_n)
            out[start:end] += (seg * env)[:end - start]
        tt = np.arange(n) / SR
        swell_period = total / (2.3 + rng.uniform(0, 0.6))  # not a divisor of the chord cycle
        swell = 0.82 + 0.18 * np.sin(2 * np.pi * tt / swell_period + rng.uniform(0, 6))
        out *= swell
        out = butter_filt(out, SR, 'low', brightness, order=2)
        air = noise(n, rng, 'pink') * noise_amt
        out = out + air
        return normalize(out, 0.55)
    st = np.stack([one(1), one(2)], axis=1)
    return make_seamless(st, SR, xf=3.0)


def gen_music_calm():
    return music_track('music_calm', 220.0, 'calm', 9.0, wave='sine', bass=True, brightness=3200, repeats=2)


def gen_music_menu():
    return music_track('music_menu', 246.94, 'menu', 8.0, wave='sine', bass=True, brightness=3600, repeats=2)


def gen_music_deep():
    return music_track('music_deep', 110.0, 'deep', 11.5, wave='sine', bass=True, noise_amt=0.03,
                        brightness=1800, repeats=2)


def gen_music_boss():
    """Tense low pulse with a dissonant chord ladder. The 4-chord
    progression is tiled several times to reach a 60s+ loop; each repeat
    gets independent rng draws (detune, hit timing) and a slow overall
    filter-brightness swell so it doesn't feel like a hard 13s stutter-loop."""
    def one(salt):
        rng = rng_for('music_boss', salt)
        chords = CHORDS['boss'] * 5
        dur_per_chord = 3.6
        seg_n = n_samples(dur_per_chord, SR)
        n = seg_n * len(chords)
        out = np.zeros(n)
        pulse_hz = 2.2
        for ci, notes in enumerate(chords):
            start = ci * seg_n
            seg = np.zeros(seg_n)
            for semi in notes:
                f = 98.0 * (2 ** (semi / 12)) * (1 + rng.uniform(-0.003, 0.003))
                seg += signal.sawtooth(2 * np.pi * f * np.arange(seg_n) / SR) / len(notes) * 0.4
            seg = butter_filt(seg, SR, 'low', 900, order=2)
            tt = np.arange(seg_n) / SR
            pulse = 0.55 + 0.45 * (signal.square(2 * np.pi * pulse_hz * tt, duty=0.35) * 0.5 + 0.5)
            seg *= pulse
            out[start:start + seg_n] += seg
        tt_full = np.arange(n) / SR
        low = np.sin(2 * np.pi * 49 * tt_full) * 0.25
        hits_times = np.arange(0.3, n / SR - 0.3, dur_per_chord / 2)
        hits = np.zeros(n)
        for ht in hits_times:
            d = n_samples(0.4, SR)
            hit = noise(d, rng, 'brown')
            hit = butter_filt(hit, SR, 'low', 140, order=3)
            hit *= env_exp(d, SR, 0.12)
            i = n_samples(ht, SR)
            end = min(n, i + d)
            if end > i:
                hits[i:end] += hit[:end - i] * 0.35
        total = n / SR
        swell_period = total / 2.7
        swell = 0.8 + 0.2 * np.sin(2 * np.pi * tt_full / swell_period + rng.uniform(0, 6))
        out = (out + low + hits) * swell
        return normalize(soft_clip(out, 1.15), 0.6)
    st = np.stack([one(1), one(2)], axis=1)
    return make_seamless(st, SR, xf=1.5)


# --------------------------------------------------------------------------
# Registry: name -> (generator, is_loop)
# --------------------------------------------------------------------------

REGISTRY = {
    'cast_whoosh': (gen_cast_whoosh, False),
    'spear_throw': (gen_spear_throw, False),
    'net_throw': (gen_net_throw, False),
    'harpoon_fire': (gen_harpoon_fire, False),
    'gun_shot': (gen_gun_shot, False),
    'splash_small': (gen_splash_small, False),
    'splash_medium': (gen_splash_medium, False),
    'splash_big': (gen_splash_big, False),
    'fish_bite': (gen_fish_bite, False),
    'fish_impact': (gen_fish_impact, False),
    'fish_thrash': (gen_fish_thrash, False),
    'jump': (gen_jump, False),
    'land': (gen_land, False),
    'reel_click': (gen_reel_click, False),
    'line_snap': (gen_line_snap, False),
    'crate_break': (gen_crate_break, False),
    'boss_roar': (gen_boss_roar, False),
    'radio_static': (gen_radio_static, False),
    'sonar_ping': (gen_sonar_ping, False),
    'sub_dive': (gen_sub_dive, False),
    'bubbles': (gen_bubbles, False),
    'underwater_whoosh': (gen_underwater_whoosh, False),
    'pickup': (gen_pickup_synth, False),
    'boat_engine_start': (gen_boat_engine_start, False),
    'boat_engine_stop': (gen_boat_engine_stop, False),
    'rare_fish': (gen_rare_fish, False),
    # layers, mixed with a sourced clip at build time
    'explosion_layer': (gen_explosion_synth_layer, False),
    'harpoon_impact_layer': (gen_harpoon_impact_layer, False),
    'boat_impact_layer': (gen_boat_impact_layer, False),
    'boss_slam_layer': (gen_boss_slam_layer, False),
    'cash_register_layer': (gen_cash_register_synth_layer, False),
    'legendary_layer': (gen_legendary_synth_layer, False),
    'club_hit_layer': (gen_club_hit_synth_layer, False),
    # loops
    'reel_loop': (gen_reel_loop, True),
    'line_tension': (gen_line_tension, True),
    'cast_charge': (gen_cast_charge, True),
    'boat_engine_loop': (gen_boat_engine_loop, True),
    'boat_wake': (gen_boat_wake, True),
    'sub_ambient_loop': (gen_sub_ambient_loop, True),
    # ambience
    'amb_storm': (gen_amb_storm, True),
    'amb_underwater': (gen_amb_underwater, True),
    'amb_deep': (gen_amb_deep, True),
    'amb_harbor_synth': (gen_amb_harbor_synth, True),  # fallback only; skipped if the real recording is used
    # music
    'music_calm': (gen_music_calm, True),
    'music_menu': (gen_music_menu, True),
    'music_deep': (gen_music_deep, True),
    'music_boss': (gen_music_boss, True),
}

VARIANT_REGISTRY = {
    'fish_flop': (fish_flop_variant, 3, False),
    'coin': (coin_variant, 3, False),
    'combo': (combo_variant, 5, False),
    'sub_creak': (creak_variant, 3, False),
    'footstep_sand': (lambda i: footstep_variant('sand', i, 'footstep_sand'), 4, False),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--only', default=None, help='comma separated subset of names')
    args = ap.parse_args()

    only = set(args.only.split(',')) if args.only else None
    os.makedirs(args.out, exist_ok=True)
    made = []

    for name, (fn, is_loop) in REGISTRY.items():
        if only and name not in only:
            continue
        sig = fn()
        path = os.path.join(args.out, f'{name}.wav')
        write_wav(path, sig, SR)
        made.append(name)
        print(f'  synth  {name:28s} {"[loop]" if is_loop else "":6s} {sig.shape}')

    for base, (fn, count, is_loop) in VARIANT_REGISTRY.items():
        if only and base not in only:
            continue
        for i in range(1, count + 1):
            sig = fn(i)
            path = os.path.join(args.out, f'{base}{i}.wav')
            write_wav(path, sig, SR)
            made.append(f'{base}{i}')
            print(f'  synth  {base}{i:<24}{"[loop]" if is_loop else "":6s} {sig.shape}')

    print(f'\nGenerated {len(made)} WAV files in {args.out}')


if __name__ == '__main__':
    main()
