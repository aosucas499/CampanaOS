#!/usr/bin/env python3
"""
CampanaOS - Ejecutor Puntual de Audio (Python 3.8-3.13+, modo systemd .timer)
Compatible con Ubuntu 20/22/24 y Raspberry Pi OS Bookworm/Trixie (32-bit armhf / 64-bit arm64).
Reproductor configurado: mpv (default)
"""

import argparse
import datetime
import json
import logging
import math
import re
import shutil
import struct
import subprocess
import sys
import wave
from pathlib import Path
from typing import Any, Dict, List, Optional

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "schedule.json"
AUDIO_DIR = BASE_DIR / "audio"
LOG_PATH = BASE_DIR / "timbre.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(LOG_PATH, encoding="utf-8"),
    ],
)
logger = logging.getLogger("CampanaOS-Audio")


def synthesize_tone_wav(tone_id: str, preset: Optional[str], target_path: Path) -> None:
    """Genera un archivo WAV limpio si no se proporcionó un MP3/WAV personalizado."""
    if target_path.exists():
        return
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    sample_rate = 44100
    kind = preset or tone_id

    notes: List[tuple] = []
    if "westminster" in kind:
        seq = [659.25, 523.25, 587.33, 392.0]
        for idx, freq in enumerate(seq):
            notes.append((idx * 0.52, 1.3, freq, 0.5))
    elif "soft" in kind:
        for idx, freq in enumerate([523.25, 659.25, 783.99, 1046.5]):
            notes.append((idx * 0.25, 1.4, freq, 0.45))
    elif "recess" in kind:
        notes = [(0.0, 1.1, 880.0, 0.55), (0.32, 1.3, 1174.66, 0.55)]
    elif "evacuation" in kind:
        for idx in range(5):
            notes.append((idx * 0.7, 0.35, 880.0, 0.6))
            notes.append((idx * 0.7 + 0.35, 0.35, 620.0, 0.6))
    else:
        for idx in range(28):
            notes.append((idx * 0.075, 0.16, 1180.0 + (idx % 2) * 20.0, 0.42))

    total_duration = max((start + dur for start, dur, _, _ in notes), default=2.0)
    total_samples = int(sample_rate * total_duration)
    buffer = [0.0] * total_samples

    for start, dur, freq, amp in notes:
        s_idx = int(start * sample_rate)
        n_len = int(dur * sample_rate)
        for i in range(n_len):
            pos = s_idx + i
            if pos >= total_samples:
                break
            t = i / sample_rate
            env = math.exp(-2.8 * t) * min(1.0, t / 0.01)
            val = amp * env * (
                math.sin(2.0 * math.pi * freq * t)
                + 0.35 * math.sin(2.0 * math.pi * freq * 2.0 * t)
            )
            buffer[pos] += val

    with wave.open(str(target_path), "w") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        frames = bytearray()
        for sample in buffer:
            clamped = max(-0.98, min(0.98, sample))
            frames.extend(struct.pack("<h", int(clamped * 32767)))
        wav_file.writeframes(bytes(frames))


def detect_pulse_sink(output_dev: str) -> Optional[str]:
    """Detecta el sink activo en PipeWire (pipewire-pulse) / PulseAudio evitando HDMI cuando se pide Jack 3.5 mm."""
    if output_dev == "default" or not shutil.which("pactl"):
        return None
    try:
        res = subprocess.run(["pactl", "list", "short", "sinks"], capture_output=True, text=True, timeout=3)
        if res.returncode != 0:
            return None
        sinks: List[str] = []
        for line in res.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 2:
                sinks.append(parts[1])

        if output_dev == "hw:0,0":
            for sink in sinks:
                low = sink.lower()
                if "hdmi" not in low and any(k in low for k in ("headphone", "analog", "bcm2835", "lineout")):
                    return sink
        elif output_dev == "hdmi":
            for sink in sinks:
                if "hdmi" in sink.lower():
                    return sink
        elif output_dev == "usb-audio":
            for sink in sinks:
                if "usb" in sink.lower():
                    return sink
    except Exception:
        pass
    return None


def detect_alsa_device(output_dev: str) -> Optional[str]:
    """Resuelve la tarjeta ALSA real en /proc/asound/cards (en Pi 4 Trixie, Headphones suele ser tarjeta 1 o 2)."""
    if output_dev == "default":
        return None
    cards_path = Path("/proc/asound/cards")
    if cards_path.exists():
        try:
            text = cards_path.read_text(encoding="utf-8", errors="ignore")
            entries: List[tuple] = []
            for line in text.splitlines():
                m = re.match(r"^\s*(\d+)\s+\[([^\]]+)\]:\s*(.*)$", line)
                if m:
                    entries.append((m.group(1), m.group(2).strip(), m.group(3).lower()))

            if output_dev == "hw:0,0":
                for _, card_id, desc in entries:
                    low_id = card_id.lower()
                    if "hdmi" in low_id or "hdmi" in desc:
                        continue
                    if any(k in low_id or k in desc for k in ("headphone", "bcm2835", "analog", "pch")):
                        return "plughw:CARD={0},DEV=0".format(card_id)
                for _, card_id, desc in entries:
                    if "hdmi" not in card_id.lower() and "hdmi" not in desc:
                        return "plughw:CARD={0},DEV=0".format(card_id)
            elif output_dev == "hdmi":
                for _, card_id, desc in entries:
                    if "hdmi" in card_id.lower() or "hdmi" in desc:
                        return "plughw:CARD={0},DEV=0".format(card_id)
            elif output_dev == "usb-audio":
                for _, card_id, desc in entries:
                    if "usb" in card_id.lower() or "usb" in desc:
                        return "plughw:CARD={0},DEV=0".format(card_id)
        except Exception:
            pass
    return output_dev if output_dev.startswith("hw:") or output_dev.startswith("plughw:") else None


def build_player_command(backend: str, volume: int, output_dev: str, audio_path: Path) -> List[str]:
    pulse_sink = detect_pulse_sink(output_dev)
    alsa_dev = detect_alsa_device(output_dev)

    if backend == "mpv":
        cmd = ["mpv", "--no-video", "--really-quiet", "--volume={0}".format(volume)]
        if output_dev != "default":
            if pulse_sink:
                cmd.append("--audio-device=pulse/{0}".format(pulse_sink))
            elif alsa_dev:
                cmd.append("--audio-device=alsa/{0}".format(alsa_dev))
        cmd.append(str(audio_path))
        return cmd
    if backend == "paplay":
        cmd = ["paplay"]
        if pulse_sink:
            cmd.extend(["--device", pulse_sink])
        cmd.append(str(audio_path))
        return cmd
    if backend == "mpg123":
        return ["mpg123", "-q", str(audio_path)]
    cmd = ["aplay", "-q"]
    if alsa_dev:
        cmd.extend(["-D", alsa_dev])
    cmd.append(str(audio_path))
    return cmd


def play_audio(tone: Dict[str, Any], hardware: Dict[str, Any]) -> None:
    backend = str(hardware.get("audioBackend", "mpv"))
    volume = int(hardware.get("masterVolume", 85))
    output_dev = str(hardware.get("audioOutput", "default"))
    tone_id = str(tone.get("id", "classic-bell"))
    filename = str(tone.get("fileName") or "{0}.wav".format(tone_id))
    audio_path = AUDIO_DIR / filename

    if not audio_path.exists():
        fallback_wav = AUDIO_DIR / "{0}.wav".format(tone_id)
        synthesize_tone_wav(tone_id, tone.get("synthPreset"), fallback_wav)
        audio_path = fallback_wav

    cmd = build_player_command(backend, volume, output_dev, audio_path)
    logger.info("Reproduciendo audio: %s", " ".join(cmd))

    try:
        res = subprocess.run(cmd, check=False, timeout=60)
        if res.returncode == 0:
            return
        logger.warning("El reproductor '%s' devolvió código %s; probando fallback PipeWire/ALSA.", backend, res.returncode)
    except FileNotFoundError:
        logger.warning("Reproductor '%s' no encontrado; probando fallback PipeWire/ALSA.", backend)
    except Exception as exc:
        logger.warning("Error ejecutando '%s': %s", backend, exc)

    # Fallback 1: PipeWire / PulseAudio genérico (compartido en Trixie Desktop)
    try:
        res_pw = subprocess.run(
            ["mpv", "--no-video", "--really-quiet", "--ao=pulse", "--volume={0}".format(volume), str(audio_path)],
            check=False,
            timeout=60,
        )
        if res_pw.returncode == 0:
            return
    except Exception:
        pass

    # Fallback 2: ALSA directo apuntando a la tarjeta resuelta (o default)
    alsa_dev = detect_alsa_device(output_dev)
    try:
        if audio_path.suffix.lower() == ".wav":
            aplay_cmd = ["aplay", "-q"]
            if alsa_dev:
                aplay_cmd.extend(["-D", alsa_dev])
            aplay_cmd.append(str(audio_path))
            subprocess.run(aplay_cmd, check=False, timeout=60)
        else:
            mpv_alsa = ["mpv", "--no-video", "--really-quiet", "--ao=alsa", "--volume={0}".format(volume)]
            if alsa_dev:
                mpv_alsa.append("--audio-device=alsa/{0}".format(alsa_dev))
            mpv_alsa.append(str(audio_path))
            subprocess.run(mpv_alsa, check=False, timeout=60)
    except Exception as exc:
        logger.error("Fallback ALSA falló: %s", exc)


def is_holiday(today: datetime.date, holidays: List[Dict[str, Any]]) -> Optional[str]:
    today_iso = today.isoformat()
    for h in holidays:
        start = str(h.get("startDate", ""))
        end = str(h.get("endDate", start))
        if start <= today_iso <= end:
            return str(h.get("name", "Festivo"))
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Ejecutor puntual de audio CampanaOS")
    parser.add_argument("--schedule-id", help="ID del toque en schedule.json")
    parser.add_argument("--tone-id", help="Reproduce inmediatamente un tono concreto por ID")
    parser.add_argument("--test-audio", action="store_true", help="Reproduce el primer tono configurado")
    args = parser.parse_args()

    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    hardware = config.get("hardware", {})
    tones_list = config.get("tones", [{"id": "classic-bell", "fileName": "classic-bell.wav"}])
    tones_map = {t["id"]: t for t in tones_list}

    if args.test_audio:
        play_audio(tones_list[0], hardware)
        return

    if args.tone_id:
        tone = tones_map.get(args.tone_id, tones_list[0])
        play_audio(tone, hardware)
        return

    if not args.schedule_id:
        logger.error("Debe especificarse --schedule-id, --tone-id o --test-audio.")
        sys.exit(1)

    active_profile_id = config.get("activeProfileId")
    profiles = {p["id"]: p for p in config.get("profiles", [])}
    active_profile = profiles.get(active_profile_id, {})

    if active_profile.get("isSilent", False):
        logger.info("Perfil en Modo Silencio; toque %s omitido.", args.schedule_id)
        return

    holiday_name = is_holiday(datetime.date.today(), config.get("holidays", []))
    if holiday_name:
        logger.info("Día festivo (%s); toque %s omitido.", holiday_name, args.schedule_id)
        return

    schedules = {s["id"]: s for s in config.get("schedules", [])}
    item = schedules.get(args.schedule_id)
    if not item or not item.get("enabled", True):
        logger.info("Toque %s deshabilitado o inexistente.", args.schedule_id)
        return

    if item.get("profileId") != active_profile_id:
        logger.info("Toque %s pertenece a otro perfil; omitido.", args.schedule_id)
        return

    logger.info("Ejecutando toque systemd: %s (%s)", item.get("label"), item.get("time"))
    tone = tones_map.get(item.get("toneId"), tones_list[0])
    play_audio(tone, hardware)


if __name__ == "__main__":
    main()
