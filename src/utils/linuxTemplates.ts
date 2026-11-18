import type { BellAppState, BellScheduleItem } from '../types/bell.ts';
export { generateWebPanelPy } from './pythonWebPanelTemplate.ts';

const SYSTEMD_WEEKDAYS: Record<number, string> = {
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
  7: 'Sun',
};

export function formatSystemdDays(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 7) return 'Mon..Sun';
  if (sorted.join(',') === '1,2,3,4,5') return 'Mon..Fri';
  return sorted.map((d) => SYSTEMD_WEEKDAYS[d] ?? '').filter(Boolean).join(',');
}

export function sanitizeUnitId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '-');
}

export function generateScheduleJson(state: BellAppState): string {
  const payload = {
    schoolName: state.hardware.schoolName,
    activeProfileId: state.activeProfileId,
    hardware: state.hardware,
    security: {
      authEnabled: state.security.authEnabled,
      hasAdminPin: state.security.hasAdminPin,
      lockReadOnlyPreview: state.security.lockReadOnlyPreview,
      hostnameMdns: state.security.hostnameMdns,
      webPort: state.security.webPort,
    },
    network: {
      hostnameMdns: state.security.hostnameMdns,
      webPort: state.security.webPort,
    },
    profiles: state.profiles,
    holidays: state.holidays,
    schedules: state.schedules,
    tones: state.tones.map((t) => ({
      id: t.id,
      name: t.name,
      category: t.category,
      description: t.description,
      durationSec: t.durationSec,
      synthPreset: t.synthPreset ?? null,
      fileName: t.fileName ?? `${t.id}.wav`,
    })),
    logs: state.logs.slice(0, 30),
  };
  return JSON.stringify(payload, null, 2);
}

export function generateSingleTimerUnit(item: BellScheduleItem): string {
  const unitId = sanitizeUnitId(item.id);
  const daysExpr = formatSystemdDays(item.days);
  return `[Unit]
Description=CampanaOS Timer - ${item.label} (${item.time})

[Timer]
OnCalendar=${daysExpr} *-*-* ${item.time}:00
AccuracySec=1s
Persistent=false
Unit=campana-ring@${unitId}.service

[Install]
WantedBy=timers.target
`;
}

export function generateTimerPreviewUnits(state: BellAppState): string {
  const activeProfile = state.profiles.find((p) => p.id === state.activeProfileId);
  if (activeProfile?.isSilent) {
    return `# El perfil activo (${activeProfile.name}) está en Modo Silencio.\n# No se habilitan unidades .timer hasta seleccionar un perfil lectivo.\n`;
  }

  const activeItems = state.schedules
    .filter((s) => s.enabled && s.profileId === state.activeProfileId && s.days.length > 0)
    .sort((a, b) => a.time.localeCompare(b.time));

  if (activeItems.length === 0) {
    return `# No hay toques habilitados en el perfil activo (${activeProfile?.name ?? state.activeProfileId}).\n`;
  }

  return activeItems
    .map((item) => {
      const unitName = `campana-ring-${sanitizeUnitId(item.id)}.timer`;
      return `# === /etc/systemd/system/${unitName} ===\n${generateSingleTimerUnit(item)}`;
    })
    .join('\n');
}

export interface TemplateRenderOptions {
  mode?: 'zip' | 'git';
}

export function generateRingServiceTemplate(state: BellAppState, options: TemplateRenderOptions = {}): string {
  const user = options.mode === 'git' ? '__CAMPANA_USER__' : state.hardware.linuxUser || 'pi';
  return `[Unit]
Description=CampanaOS - Ejecución puntual de audio (%i)
After=sound.target

[Service]
Type=oneshot
User=${user}
WorkingDirectory=/opt/campana-os
ExecStart=/usr/bin/python3 /opt/campana-os/timbre_runner.py --schedule-id %i
Environment=PYTHONUNBUFFERED=1
Environment=XDG_RUNTIME_DIR=/run/user/__CAMPANA_UID__
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/__CAMPANA_UID__/bus
Environment=PULSE_RUNTIME_PATH=/run/user/__CAMPANA_UID__/pulse
`;
}

export function generateWebServiceUnit(state: BellAppState, options: TemplateRenderOptions = {}): string {
  const user = options.mode === 'git' ? '__CAMPANA_USER__' : state.hardware.linuxUser || 'pi';
  const port = state.security.webPort || 3000;
  return `[Unit]
Description=CampanaOS - Panel Web Local y en Red (puerto ${port})
After=network-online.target avahi-daemon.service sound.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
WorkingDirectory=/opt/campana-os
Environment=PORT=${port}
Environment=PYTHONUNBUFFERED=1
Environment=XDG_RUNTIME_DIR=/run/user/__CAMPANA_UID__
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/__CAMPANA_UID__/bus
Environment=PULSE_RUNTIME_PATH=/run/user/__CAMPANA_UID__/pulse
ExecStart=/usr/bin/python3 /opt/campana-os/web_panel.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

export function generateSudoersRule(state: BellAppState, options: TemplateRenderOptions = {}): string {
  const user = options.mode === 'git' ? '__CAMPANA_USER__' : state.hardware.linuxUser || 'pi';
  return `# Permite al panel web local de CampanaOS recargar los systemd timers sin ejecutar Python web como root
${user} ALL=(root) NOPASSWD: /usr/bin/python3 /opt/campana-os/sync_timers.py
`;
}

export function generateTimbreRunnerPy(state: BellAppState): string {
  const { hardware } = state;
  return `#!/usr/bin/env python3
"""
CampanaOS - Ejecutor Puntual de Audio (Python 3.8-3.13+, modo systemd .timer)
Compatible con Ubuntu 20/22/24 y Raspberry Pi OS Bookworm/Trixie (32-bit armhf / 64-bit arm64).
Reproductor configurado: ${hardware.audioBackend} (${hardware.audioOutput})
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
import tempfile
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
                m = re.match(r"^\\s*(\\d+)\\s+\\[([^\\]]+)\\]:\\s*(.*)$", line)
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


def build_player_command(
    backend: str,
    volume: int,
    output_dev: str,
    audio_path: Path,
    start_sec: float = 0.0,
    play_duration: float = 0.0,
) -> List[str]:
    pulse_sink = detect_pulse_sink(output_dev)
    alsa_dev = detect_alsa_device(output_dev)

    if backend == "mpv":
        cmd = ["mpv", "--no-video", "--really-quiet", "--volume={0}".format(volume)]
        if start_sec > 0:
            cmd.append("--start={0:.2f}".format(start_sec))
        if play_duration > 0:
            cmd.append("--length={0:.2f}".format(play_duration))
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


def trim_audio_segment(
    audio_path: Path,
    start_sec: float,
    play_duration: float,
    target_ext: str,
) -> Optional[Path]:
    """Recorta temporalmente el fragmento solicitado con ffmpeg para reproductores sin --start/--length."""
    if not shutil.which("ffmpeg") or (start_sec <= 0 and play_duration <= 0):
        return None
    tmp_dir = Path(tempfile.mkdtemp(prefix="campana-trim-"))
    out_path = tmp_dir / ("segment" + target_ext)
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    if start_sec > 0:
        cmd.extend(["-ss", "{0:.2f}".format(start_sec)])
    cmd.extend(["-i", str(audio_path)])
    if play_duration > 0:
        cmd.extend(["-t", "{0:.2f}".format(play_duration)])
    cmd.append("-vn")
    if target_ext == ".wav":
        cmd.extend(["-acodec", "pcm_s16le"])
    else:
        cmd.extend(["-acodec", "libmp3lame", "-q:a", "2"])
    cmd.append(str(out_path))
    try:
        res = subprocess.run(cmd, check=False, timeout=45)
        if res.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0:
            return out_path
    except Exception as exc:
        logger.warning("ffmpeg no pudo recortar el fragmento: %s", exc)
    shutil.rmtree(str(tmp_dir), ignore_errors=True)
    return None


def play_audio(
    tone: Dict[str, Any],
    hardware: Dict[str, Any],
    start_sec: float = 0.0,
    play_duration: float = 0.0,
) -> None:
    backend = str(hardware.get("audioBackend", "mpv"))
    volume = int(hardware.get("masterVolume", 85))
    output_dev = str(hardware.get("audioOutput", "default"))
    tone_id = str(tone.get("id", "classic-bell"))
    filename = str(tone.get("fileName") or "{0}.wav".format(tone_id))
    audio_path = AUDIO_DIR / filename

    safe_start = max(0.0, float(start_sec or 0.0))
    safe_dur = max(0.0, float(play_duration or 0.0))

    if not audio_path.exists():
        fallback_wav = AUDIO_DIR / "{0}.wav".format(tone_id)
        synthesize_tone_wav(tone_id, tone.get("synthPreset"), fallback_wav)
        audio_path = fallback_wav

    effective_path = audio_path
    effective_start = safe_start
    effective_dur = safe_dur
    trimmed_path: Optional[Path] = None

    if backend != "mpv" and (safe_start > 0 or safe_dur > 0):
        target_ext = ".mp3" if backend == "mpg123" else ".wav"
        trimmed_path = trim_audio_segment(audio_path, safe_start, safe_dur, target_ext)
        if trimmed_path is not None:
            effective_path = trimmed_path
            effective_start = 0.0
            effective_dur = 0.0

    run_timeout = max(90, int(safe_dur) + 25) if safe_dur > 0 else 300
    mpv_trim_args: List[str] = []
    if safe_start > 0:
        mpv_trim_args.append("--start={0:.2f}".format(safe_start))
    if safe_dur > 0:
        mpv_trim_args.append("--length={0:.2f}".format(safe_dur))

    try:
        cmd = build_player_command(backend, volume, output_dev, effective_path, effective_start, effective_dur)
        logger.info("Reproduciendo audio: %s", " ".join(cmd))

        try:
            res = subprocess.run(cmd, check=False, timeout=run_timeout)
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
                ["mpv", "--no-video", "--really-quiet", "--ao=pulse", "--volume={0}".format(volume)]
                + mpv_trim_args
                + [str(audio_path)],
                check=False,
                timeout=run_timeout,
            )
            if res_pw.returncode == 0:
                return
        except Exception:
            pass

        # Fallback 2: ALSA directo apuntando a la tarjeta resuelta (o default)
        alsa_dev = detect_alsa_device(output_dev)
        try:
            if effective_path.suffix.lower() == ".wav" and (effective_start == 0 and effective_dur == 0):
                aplay_cmd = ["aplay", "-q"]
                if alsa_dev:
                    aplay_cmd.extend(["-D", alsa_dev])
                aplay_cmd.append(str(effective_path))
                subprocess.run(aplay_cmd, check=False, timeout=run_timeout)
            else:
                mpv_alsa = ["mpv", "--no-video", "--really-quiet", "--ao=alsa", "--volume={0}".format(volume)] + mpv_trim_args
                if alsa_dev:
                    mpv_alsa.append("--audio-device=alsa/{0}".format(alsa_dev))
                mpv_alsa.append(str(audio_path))
                subprocess.run(mpv_alsa, check=False, timeout=run_timeout)
        except Exception as exc:
            logger.error("Fallback ALSA falló: %s", exc)
    finally:
        if trimmed_path is not None:
            shutil.rmtree(str(trimmed_path.parent), ignore_errors=True)


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
    parser.add_argument("--start-sec", type=float, default=0.0, help="Segundo inicial de reproducción")
    parser.add_argument("--duration-sec", type=float, default=0.0, help="Duración máxima en segundos")
    args = parser.parse_args()

    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    hardware = config.get("hardware", {})
    tones_list = config.get("tones", [{"id": "classic-bell", "fileName": "classic-bell.wav"}])
    tones_map = {t["id"]: t for t in tones_list}

    if args.test_audio:
        play_audio(tones_list[0], hardware, args.start_sec, args.duration_sec)
        return

    if args.tone_id:
        tone = tones_map.get(args.tone_id, tones_list[0])
        play_audio(tone, hardware, args.start_sec, args.duration_sec)
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

    item_start = float(item.get("startSec") or 0.0)
    item_dur = float(item.get("playDurationSec") or 0.0)
    logger.info("Ejecutando toque systemd: %s (%s)", item.get("label"), item.get("time"))
    tone = tones_map.get(item.get("toneId"), tones_list[0])
    play_audio(
        tone,
        hardware,
        args.start_sec if args.start_sec > 0 else item_start,
        args.duration_sec if args.duration_sec > 0 else item_dur,
    )


if __name__ == "__main__":
    main()
`;
}

export function generateSyncTimersPy(): string {
  return `#!/usr/bin/env python3
"""
CampanaOS - Sincronizador de unidades systemd .timer y red mDNS (Python 3.8+)
Lee /opt/campana-os/schedule.json, genera los archivos campana-ring-*.timer,
configura hostname/Avahi mDNS (<nombre>.local) y recarga systemd.
Debe ejecutarse como root (vía sudoers o install.sh).
"""

import json
import re
import socket
import subprocess
from pathlib import Path
from typing import Any, Dict, List

BASE_DIR = Path("/opt/campana-os")
CONFIG_PATH = BASE_DIR / "schedule.json"
SYSTEMD_DIR = Path("/etc/systemd/system")
AVAHI_SERVICE_PATH = Path("/etc/avahi/services/campana-os.service")
HOSTS_PATH = Path("/etc/hosts")
TIMER_PREFIX = "campana-ring-"

DAY_MAP: Dict[int, str] = {
    1: "Mon",
    2: "Tue",
    3: "Wed",
    4: "Thu",
    5: "Fri",
    6: "Sat",
    7: "Sun",
}


def sanitize_id(raw_id: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "-", raw_id)


def sanitize_mdns_host(raw_host: Any) -> str:
    cleaned = re.sub(r"[^a-z0-9-]+", "-", str(raw_host or "").strip().lower()).strip("-")
    return cleaned[:63] or "campana-escolar"


def format_oncalendar_days(days: List[int]) -> str:
    ordered = sorted(set(days))
    if ordered == [1, 2, 3, 4, 5, 6, 7]:
        return "Mon..Sun"
    if ordered == [1, 2, 3, 4, 5]:
        return "Mon..Fri"
    return ",".join(DAY_MAP[d] for d in ordered if d in DAY_MAP)


def run_systemctl(*args: str) -> None:
    subprocess.run(["systemctl", *args], check=False)


def sync_mdns_hostname(config: Dict[str, Any]) -> None:
    sec_cfg = config.get("security") or config.get("network") or {}
    mdns_host = sanitize_mdns_host(sec_cfg.get("hostnameMdns", "campana-escolar"))
    try:
        web_port = int(sec_cfg.get("webPort", 3000))
    except (TypeError, ValueError):
        web_port = 3000

    school_name = str(config.get("hardware", {}).get("schoolName", "CampanaOS")).replace("&", "&amp;").replace("<", "&lt;")
    service_xml = (
        '<?xml version="1.0" standalone="no"?>\\n'
        '<!DOCTYPE service-group SYSTEM "avahi-service.dtd">\\n'
        "<service-group>\\n"
        "  <name replace-wildcards=\\"yes\\">CampanaOS - {school} (%h)</name>\\n"
        "  <service>\\n"
        "    <type>_http._tcp</type>\\n"
        "    <port>{port}</port>\\n"
        "  </service>\\n"
        "</service-group>\\n"
    ).format(school=school_name, port=web_port)

    avahi_changed = False
    try:
        AVAHI_SERVICE_PATH.parent.mkdir(parents=True, exist_ok=True)
        prev_xml = AVAHI_SERVICE_PATH.read_text(encoding="utf-8") if AVAHI_SERVICE_PATH.exists() else ""
        if prev_xml != service_xml:
            AVAHI_SERVICE_PATH.write_text(service_xml, encoding="utf-8")
            avahi_changed = True
    except Exception:
        pass

    current_host = socket.gethostname().split(".")[0].strip().lower()
    if current_host != mdns_host:
        res = subprocess.run(["hostnamectl", "set-hostname", mdns_host], check=False)
        if res.returncode != 0:
            try:
                Path("/etc/hostname").write_text(mdns_host + "\\n", encoding="utf-8")
                subprocess.run(["hostname", mdns_host], check=False)
            except Exception:
                pass
        avahi_changed = True

    try:
        hosts_lines = HOSTS_PATH.read_text(encoding="utf-8").splitlines() if HOSTS_PATH.exists() else []
        new_lines: List[str] = []
        replaced = False
        for line in hosts_lines:
            if re.match(r"^\\s*127\\.0\\.1\\.1\\s+", line):
                new_lines.append("127.0.1.1\\t{0}".format(mdns_host))
                replaced = True
            else:
                new_lines.append(line)
        if not replaced:
            new_lines.append("127.0.1.1\\t{0}".format(mdns_host))
        new_hosts_text = "\\n".join(new_lines).rstrip() + "\\n"
        prev_hosts_text = HOSTS_PATH.read_text(encoding="utf-8") if HOSTS_PATH.exists() else ""
        if prev_hosts_text != new_hosts_text:
            HOSTS_PATH.write_text(new_hosts_text, encoding="utf-8")
            avahi_changed = True
    except Exception:
        pass

    if avahi_changed:
        run_systemctl("enable", "avahi-daemon")
        run_systemctl("restart", "avahi-daemon")


def main() -> None:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))

    sync_mdns_hostname(config)

    active_profile_id = config.get("activeProfileId")
    profiles = {p["id"]: p for p in config.get("profiles", [])}
    active_profile = profiles.get(active_profile_id, {})
    is_silent = bool(active_profile.get("isSilent", False))

    existing_timers = list(SYSTEMD_DIR.glob("{0}*.timer".format(TIMER_PREFIX)))
    for timer_path in existing_timers:
        run_systemctl("disable", "--now", timer_path.name)
        if timer_path.exists():
            timer_path.unlink()

    created_timers: List[str] = []

    if not is_silent:
        for item in config.get("schedules", []):
            if (
                item.get("enabled", True)
                and item.get("profileId") == active_profile_id
                and item.get("days")
            ):
                unit_id = sanitize_id(item["id"])
                timer_name = "{0}{1}.timer".format(TIMER_PREFIX, unit_id)
                days_expr = format_oncalendar_days(item["days"])
                hhmm = item["time"]
                label = str(item.get("label", "Toque escolar")).replace("\\n", " ")

                unit_content = (
                    "[Unit]\\n"
                    "Description=CampanaOS Timer - {label} ({hhmm})\\n\\n"
                    "[Timer]\\n"
                    "OnCalendar={days_expr} *-*-* {hhmm}:00\\n"
                    "AccuracySec=1s\\n"
                    "Persistent=false\\n"
                    "Unit=campana-ring@{unit_id}.service\\n\\n"
                    "[Install]\\n"
                    "WantedBy=timers.target\\n"
                ).format(label=label, hhmm=hhmm, days_expr=days_expr, unit_id=unit_id)

                (SYSTEMD_DIR / timer_name).write_text(unit_content, encoding="utf-8")
                created_timers.append(timer_name)

    run_systemctl("daemon-reload")
    for timer_name in created_timers:
        run_systemctl("enable", "--now", timer_name)

    print("Sincronización completada: {0} timers activos.".format(len(created_timers)))


if __name__ == "__main__":
    main()
`;
}

export function generateInstallScript(state: BellAppState, options: TemplateRenderOptions = {}): string {
  const configuredUser = state.hardware.linuxUser || 'pi';
  const defaultMdns = state.security.hostnameMdns || 'campana-escolar';
  const defaultPort = state.security.webPort || 3000;
  const preferSudoUser = options.mode === 'git';

  return `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
CLI_USER=""
RESET_CONFIG=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)
      if [[ $# -lt 2 || -z "\${2:-}" ]]; then
        echo "Error: --user requiere un nombre de usuario Linux."
        exit 1
      fi
      CLI_USER="$2"
      shift 2
      ;;
    --reset-config)
      RESET_CONFIG=1
      shift
      ;;
    -h|--help)
      echo "Uso: sudo bash install.sh [--user <usuario>] [--reset-config]"
      echo "  --user <usuario>  Especifica manualmente el usuario Linux del servicio"
      echo "  --reset-config    Sobrescribe schedule.json existente con la configuración base"
      exit 0
      ;;
    *)
      echo "Opción no reconocida: $1 (usa --help para ver las opciones)"
      exit 1
      ;;
  esac
done

echo "=================================================================="
echo " Instalador CampanaOS - Raspberry Pi OS Trixie/Bookworm y Ubuntu"
echo " Centro: ${state.hardware.schoolName}"
echo "=================================================================="

if [[ $EUID -ne 0 ]]; then
  echo "Por favor ejecuta este script como root: sudo bash install.sh"
  exit 1
fi

if [[ -f "$SCRIPT_DIR/deploy/timbre_runner.py" ]]; then
  SRC_DIR="$SCRIPT_DIR/deploy"
  SOURCE_LABEL="Repositorio Git ($SRC_DIR)"
else
  SRC_DIR="$SCRIPT_DIR"
  SOURCE_LABEL="Paquete local ($SRC_DIR)"
fi

INSTALL_DIR="/opt/campana-os"
TARGET_USER=""

if [[ -n "$CLI_USER" ]]; then
  TARGET_USER="$CLI_USER"
elif [[ "${preferSudoUser ? '1' : '0'}" -eq 1 || "$SRC_DIR" == "$SCRIPT_DIR/deploy" ]]; then
  if [[ -n "\${SUDO_USER:-}" && "\${SUDO_USER:-}" != "root" ]] && id "$SUDO_USER" &>/dev/null; then
    TARGET_USER="$SUDO_USER"
  elif id "pi" &>/dev/null; then
    TARGET_USER="pi"
  else
    TARGET_USER=$(awk -F: '$3 >= 1000 && $3 < 65534 {print $1; exit}' /etc/passwd || true)
  fi
else
  TARGET_USER="${configuredUser}"
fi

if [[ -z "$TARGET_USER" ]] || ! id "$TARGET_USER" &>/dev/null; then
  echo "No se pudo determinar un usuario Linux válido ('$TARGET_USER')."
  echo "Ejecuta: sudo bash install.sh --user <tu-usuario-linux>"
  exit 1
fi

TARGET_UID=$(id -u "$TARGET_USER")
PY_VER=$(python3 -c 'import sys; print("{0}.{1}".format(*sys.version_info[:2]))' 2>/dev/null || echo "3.x")
echo "[1/6] Origen: $SOURCE_LABEL"
echo "      Usuario: $TARGET_USER (UID $TARGET_UID) · Arch: $(uname -m) · Python $PY_VER"

echo "[2/6] Instalando paquetes de audio PipeWire/ALSA, ffmpeg y red local mDNS..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y python3 mpv ffmpeg curl ca-certificates alsa-utils avahi-daemon libnss-mdns avahi-utils dbus-user-session

for opt_pkg in pulseaudio-utils pipewire-alsa pipewire-pulse wireplumber; do
  if apt-cache show "$opt_pkg" >/dev/null 2>&1; then
    apt-get install -y "$opt_pkg" || true
  fi
done

echo "[2b/6] Instalando o actualizando yt-dlp oficial (compatible Python 3.8-3.13 y RPi OS Trixie 32-bit armhf)..."
if curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o /usr/local/bin/yt-dlp; then
  chmod a+rx /usr/local/bin/yt-dlp
  /usr/local/bin/yt-dlp --version || true
elif [[ -x /usr/local/bin/yt-dlp ]]; then
  /usr/local/bin/yt-dlp -U || true
elif apt-cache show yt-dlp >/dev/null 2>&1; then
  apt-get install -y yt-dlp || true
else
  echo "Aviso: no se pudo descargar yt-dlp ahora; la importación desde YouTube requerirá instalar yt-dlp manualmente."
fi

echo "[3/6] Configurando permisos de audio y sesión PipeWire headless (linger)..."
usermod -aG audio "$TARGET_USER" || true
loginctl enable-linger "$TARGET_USER" || true

echo "[4/6] Copiando scripts e interfaz web a $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR/audio" "$INSTALL_DIR/webapp"
cp -f "$SRC_DIR/timbre_runner.py" "$SRC_DIR/sync_timers.py" "$SRC_DIR/web_panel.py" "$INSTALL_DIR/"

if [[ -f "$INSTALL_DIR/schedule.json" && "$RESET_CONFIG" -eq 0 ]]; then
  echo "      -> Actualización detectada: conservando schedule.json, auth-secrets.json y audio/ existentes."
else
  cp -f "$SRC_DIR/schedule.json" "$INSTALL_DIR/schedule.json"
  python3 - "$INSTALL_DIR/schedule.json" "$TARGET_USER" <<'PYEOF'
import json
import sys
from pathlib import Path

cfg_path = Path(sys.argv[1])
target_user = sys.argv[2]
data = json.loads(cfg_path.read_text(encoding="utf-8"))
data.setdefault("hardware", {})["linuxUser"] = target_user
cfg_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
PYEOF
  if [[ -d "$SRC_DIR/audio" ]] && compgen -G "$SRC_DIR/audio/*" >/dev/null; then
    cp -rf "$SRC_DIR/audio/"* "$INSTALL_DIR/audio/" 2>/dev/null || true
  fi
fi

if [[ -d "$SRC_DIR/webapp" ]] && compgen -G "$SRC_DIR/webapp/*" >/dev/null; then
  rm -rf "$INSTALL_DIR/webapp"/*
  cp -rf "$SRC_DIR/webapp/"* "$INSTALL_DIR/webapp/"
fi
chmod 755 "$INSTALL_DIR/timbre_runner.py" "$INSTALL_DIR/sync_timers.py" "$INSTALL_DIR/web_panel.py"
chown -R "$TARGET_USER":"$TARGET_USER" "$INSTALL_DIR"

echo "[5/6] Instalando unidades systemd ($TARGET_USER / UID $TARGET_UID) y sudoers..."
sed -e "s/__CAMPANA_USER__/$TARGET_USER/g" -e "s/__CAMPANA_UID__/$TARGET_UID/g" "$SRC_DIR/campana-ring@.service" > /etc/systemd/system/campana-ring@.service
sed -e "s/__CAMPANA_USER__/$TARGET_USER/g" -e "s/__CAMPANA_UID__/$TARGET_UID/g" "$SRC_DIR/campana-web.service" > /etc/systemd/system/campana-web.service
sed -e "s/__CAMPANA_USER__/$TARGET_USER/g" "$SRC_DIR/campana-os.sudoers" > /etc/sudoers.d/campana-os
chmod 440 /etc/sudoers.d/campana-os
if command -v visudo >/dev/null 2>&1; then
  visudo -cf /etc/sudoers.d/campana-os
fi

ACTIVE_MDNS=$(python3 -c 'import json, re; d=json.load(open("/opt/campana-os/schedule.json")); h=(d.get("security") or d.get("network") or {}).get("hostnameMdns","${defaultMdns}"); print(re.sub(r"[^a-z0-9-]+","-",str(h).lower()).strip("-") or "${defaultMdns}")' 2>/dev/null || echo "${defaultMdns}")
ACTIVE_PORT=$(python3 -c 'import json; d=json.load(open("/opt/campana-os/schedule.json")); print(int((d.get("security") or d.get("network") or {}).get("webPort", ${defaultPort})))' 2>/dev/null || echo "${defaultPort}")

echo "[6/6] Activando mDNS ($ACTIVE_MDNS.local), timers systemd y panel web..."
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 5353/udp >/dev/null 2>&1 || true
  ufw allow "$ACTIVE_PORT/tcp" >/dev/null 2>&1 || true
fi
systemctl enable --now avahi-daemon || true
python3 "$INSTALL_DIR/sync_timers.py"
systemctl daemon-reload
if systemctl is-active --quiet campana-web.service; then
  systemctl enable campana-web.service >/dev/null 2>&1 || true
  systemctl restart campana-web.service
else
  systemctl enable --now campana-web.service
fi

LAN_IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$' | head -n 3 | tr '\n' ' ' || true)

echo ""
echo "Tarjetas de audio detectadas en el sistema:"
aplay -l 2>/dev/null | grep -E '^card ' || true
echo ""
echo "Comprobación mDNS ($ACTIVE_MDNS.local):"
avahi-resolve -4 -n "$ACTIVE_MDNS.local" 2>/dev/null || echo "  Aviso: si tu router/Wi-Fi escolar bloquea multicast mDNS (UDP 5353), usa la IP directa."
echo ""
echo "Instalación/actualización completada con éxito."
echo "Panel local:          http://localhost:$ACTIVE_PORT"
echo "Panel mDNS (LAN):     http://$ACTIVE_MDNS.local:$ACTIVE_PORT"
if [[ -n "$LAN_IPS" ]]; then
  for ip in $LAN_IPS; do
    echo "Panel por IP (LAN):   http://$ip:$ACTIVE_PORT"
  done
fi
echo "Ver próximos toques:  systemctl list-timers 'campana-ring-*'"
echo "Ver logs de audio:    sudo journalctl -u 'campana-ring@*' -f"
echo "Probar audio ahora:   sudo -u $TARGET_USER python3 $INSTALL_DIR/timbre_runner.py --test-audio"
`;
}

export function generateReadme(state: BellAppState): string {
  const mdns = state.security.hostnameMdns || 'campana-escolar';
  const port = state.security.webPort || 3000;
  return `# CampanaOS — Timbre Escolar por Audio Linux (\`systemd .timer\` + Web Local)

Centro configurado: **${state.hardware.schoolName}**
Salida de audio: **${state.hardware.audioBackend} (${state.hardware.audioOutput})**
Acceso local: **http://localhost:${port}**
Acceso en red local: **http://${mdns}.local:${port}**

## 1. Compatibilidad verificada

- **Raspberry Pi OS**: **Trixie (Debian 13)** y **Bookworm (Debian 12)** en **32-bit (\`armhf\`)** y **64-bit (\`arm64\`)**, optimizado para PipeWire y salidas \`Headphones\`.
- **Ubuntu Desktop / Server**: 20.04 LTS, 22.04 LTS y 24.04 LTS (\`x86_64\` / \`arm64\`).
- **Python 3.8 – 3.13+ sin Node.js ni \`pip\` global**: compatible con PEP 668 (Debian 12/13 y Ubuntu 24.04); tanto el ejecutor de audio como el servidor web usan Python 3 estándar.

## 2. Cómo se conecta al ecualizador del centro

1. Conecta un cable de audio desde la salida **Jack 3.5 mm** (Raspberry Pi 3/4), **HDMI** o **tarjeta de sonido USB** (necesaria en Raspberry Pi 5 al no incluir Jack analógico) hacia la entrada de línea (AUX / LINE IN) de tu **ecualizador o etapa de megafonía**.
2. En **Raspberry Pi 4 con Trixie**, el vídeo HDMI suele ocupar la tarjeta \`hw:0,0\`. Si seleccionas **Jack 3.5 mm**, \`timbre_runner.py\` autodetecta automáticamente el *sink* analógico \`Headphones\` en **PipeWire** (o \`plughw:CARD=Headphones,DEV=0\` en ALSA) sin interferir con el escritorio.
3. Cada toque programado ejecuta una unidad \`systemd .timer\` puntual (\`OnCalendar=\`, \`AccuracySec=1s\`, \`Persistent=false\`) que dispara \`timbre_runner.py\`, validando festivos y perfil activo antes de reproducir el sonido.
4. El panel web local (\`campana-web.service\`) permite editar horarios, gestionar festivos, subir archivos MP3/WAV, importar audios desde enlace o YouTube (\`yt-dlp\` + \`ffmpeg\`) o pulsar **Tocar timbre ahora** desde el propio equipo o desde cualquier PC de la red local.

## 3. Instalación rápida

### Opción A: Desde GitHub (\`git clone\` + actualización \`git pull\`)
\`\`\`bash
git clone <URL-DEL-REPOSITORIO> campana-os
cd campana-os
sudo bash install.sh

# Para actualizar más adelante conservando horarios, PIN y audios:
git pull && sudo bash install.sh
\`\`\`

### Opción B: Desde paquete \`.zip\` descargado
\`\`\`bash
unzip campana-os-linux-rpi.zip -d campana-os
cd campana-os
sudo bash install.sh
\`\`\`

Si deseas que el equipo responda en la red local como \`${mdns}.local\`:

\`\`\`bash
sudo hostnamectl set-hostname ${mdns}
sudo systemctl restart avahi-daemon
\`\`\`

## 4. Comandos útiles

\`\`\`bash
# Ver próximos timbres programados
systemctl list-timers 'campana-ring-*'

# Ver salidas PipeWire y tarjetas ALSA detectadas
pactl list short sinks || aplay -l

# Ver estado del panel web local
sudo systemctl status campana-web

# Ver historial de toques y pruebas de audio
sudo journalctl -u 'campana-ring@*' -f
\`\`\`
`;
}
