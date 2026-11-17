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

export function generateRingServiceTemplate(state: BellAppState): string {
  const user = state.hardware.linuxUser || 'pi';
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

export function generateWebServiceUnit(state: BellAppState): string {
  const user = state.hardware.linuxUser || 'pi';
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

export function generateSudoersRule(state: BellAppState): string {
  const user = state.hardware.linuxUser || 'pi';
  return `# Permite al panel web local de CampanaOS recargar los systemd timers sin ejecutar Python web como root
${user} ALL=(root) NOPASSWD: /usr/bin/python3 /opt/campana-os/sync_timers.py
`;
}

export function generateTimbreRunnerPy(state: BellAppState): string {
  const { hardware } = state;
  return `#!/usr/bin/env python3
"""
CampanaOS - Ejecutor Puntual de Audio (Python 3.8+, modo systemd .timer)
Compatible con Ubuntu 20.04/22.04/24.04 y Raspberry Pi OS (arm64/armhf).
Reproductor configurado: ${hardware.audioBackend} (${hardware.audioOutput})
"""

import argparse
import datetime
import json
import logging
import math
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


def build_player_command(backend: str, volume: int, output_dev: str, audio_path: Path) -> List[str]:
    if backend == "mpv":
        cmd = ["mpv", "--no-video", "--really-quiet", "--volume={0}".format(volume)]
        if output_dev != "default":
            cmd.append("--audio-device=alsa/{0}".format(output_dev))
        cmd.append(str(audio_path))
        return cmd
    if backend == "paplay":
        return ["paplay", str(audio_path)]
    if backend == "mpg123":
        return ["mpg123", "-q", str(audio_path)]
    cmd = ["aplay", "-q"]
    if output_dev != "default":
        cmd.extend(["-D", output_dev])
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
        logger.warning("El reproductor '%s' devolvió código %s; probando fallback ALSA.", backend, res.returncode)
    except FileNotFoundError:
        logger.warning("Reproductor '%s' no encontrado; probando fallback ALSA.", backend)
    except Exception as exc:
        logger.warning("Error ejecutando '%s': %s", backend, exc)

    # Fallback automático ALSA para entornos headless sin PulseAudio/PipeWire
    try:
        if audio_path.suffix.lower() == ".wav":
            subprocess.run(["aplay", "-q", str(audio_path)], check=False, timeout=60)
        else:
            subprocess.run(["mpv", "--no-video", "--ao=alsa", "--volume={0}".format(volume), str(audio_path)], check=False, timeout=60)
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
`;
}

export function generateSyncTimersPy(): string {
  return `#!/usr/bin/env python3
"""
CampanaOS - Sincronizador de unidades systemd .timer (Python 3.8+)
Lee /opt/campana-os/schedule.json, genera los archivos campana-ring-*.timer,
elimina los obsoletos y recarga systemd. Debe ejecutarse como root (vía sudoers).
"""

import json
import re
import subprocess
from pathlib import Path
from typing import Dict, List

BASE_DIR = Path("/opt/campana-os")
CONFIG_PATH = BASE_DIR / "schedule.json"
SYSTEMD_DIR = Path("/etc/systemd/system")
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


def format_oncalendar_days(days: List[int]) -> str:
    ordered = sorted(set(days))
    if ordered == [1, 2, 3, 4, 5, 6, 7]:
        return "Mon..Sun"
    if ordered == [1, 2, 3, 4, 5]:
        return "Mon..Fri"
    return ",".join(DAY_MAP[d] for d in ordered if d in DAY_MAP)


def run_systemctl(*args: str) -> None:
    subprocess.run(["systemctl", *args], check=False)


def main() -> None:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))

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

export function generateInstallScript(state: BellAppState): string {
  const user = state.hardware.linuxUser || 'pi';
  const mdns = state.security.hostnameMdns || 'campana-escolar';
  const port = state.security.webPort || 3000;

  return `#!/usr/bin/env bash
set -euo pipefail

echo "=================================================================="
echo " Instalador CampanaOS - Ubuntu 20/22/24 y Raspberry Pi OS"
echo " Centro: ${state.hardware.schoolName}"
echo "=================================================================="

if [[ $EUID -ne 0 ]]; then
  echo "Por favor ejecuta este script como root: sudo bash install.sh"
  exit 1
fi

INSTALL_DIR="/opt/campana-os"
TARGET_USER="${user}"

if ! id "$TARGET_USER" &>/dev/null; then
  echo "El usuario '$TARGET_USER' no existe en este equipo."
  echo "Cambia 'Usuario Linux' en CampanaOS o crea el usuario antes de instalar."
  exit 1
fi

TARGET_UID=$(id -u "$TARGET_USER")
echo "[1/6] Usuario detectado: $TARGET_USER (UID $TARGET_UID) · Arquitectura: $(uname -m)"

echo "[2/6] Instalando paquetes de audio, ffmpeg, yt-dlp y red local (sin Node.js)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y python3 mpv ffmpeg curl ca-certificates alsa-utils avahi-daemon dbus-user-session

for opt_pkg in pulseaudio-utils pipewire-alsa pipewire-pulse; do
  if apt-cache show "$opt_pkg" >/dev/null 2>&1; then
    apt-get install -y "$opt_pkg" || true
  fi
done

echo "[2b/6] Instalando herramienta libre yt-dlp (compatible Ubuntu 20/22/24 y RPi OS armhf/arm64)..."
if curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o /usr/local/bin/yt-dlp; then
  chmod a+rx /usr/local/bin/yt-dlp
elif apt-cache show yt-dlp >/dev/null 2>&1; then
  apt-get install -y yt-dlp || true
else
  echo "Aviso: no se pudo descargar yt-dlp ahora; la importación desde YouTube requerirá instalar yt-dlp manualmente."
fi

echo "[3/6] Configurando permisos de audio y sesión headless (linger)..."
usermod -aG audio "$TARGET_USER" || true
loginctl enable-linger "$TARGET_USER" || true

echo "[4/6] Copiando scripts, interfaz web y audios a $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR/audio" "$INSTALL_DIR/webapp"
cp -f timbre_runner.py sync_timers.py web_panel.py schedule.json "$INSTALL_DIR/"
if [ -d "./webapp" ]; then
  rm -rf "$INSTALL_DIR/webapp"/*
  cp -rf ./webapp/* "$INSTALL_DIR/webapp/"
fi
if [ -d "./audio" ]; then
  cp -rf ./audio/* "$INSTALL_DIR/audio/" 2>/dev/null || true
fi
chmod 755 "$INSTALL_DIR/timbre_runner.py" "$INSTALL_DIR/sync_timers.py" "$INSTALL_DIR/web_panel.py"
chown -R "$TARGET_USER":"$TARGET_USER" "$INSTALL_DIR"

echo "[5/6] Instalando unidades systemd (UID dinámico $TARGET_UID) y sudoers..."
sed "s/__CAMPANA_UID__/$TARGET_UID/g" campana-ring@.service > /etc/systemd/system/campana-ring@.service
sed "s/__CAMPANA_UID__/$TARGET_UID/g" campana-web.service > /etc/systemd/system/campana-web.service
cp -f campana-os.sudoers /etc/sudoers.d/campana-os
chmod 440 /etc/sudoers.d/campana-os
if command -v visudo >/dev/null 2>&1; then
  visudo -cf /etc/sudoers.d/campana-os
fi

echo "[6/6] Activando Avahi mDNS, timers systemd y panel web..."
systemctl enable --now avahi-daemon || true
python3 "$INSTALL_DIR/sync_timers.py"
systemctl daemon-reload
systemctl enable --now campana-web.service

echo ""
echo "Instalación completada con éxito."
echo "Panel local:          http://localhost:${port}"
echo "Panel en red local:   http://${mdns}.local:${port} (o http://$(hostname -I | awk '{print $1}'):${port})"
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

- **Ubuntu Desktop / Server**: 20.04 LTS, 22.04 LTS y 24.04 LTS (\`x86_64\` / \`arm64\`).
- **Raspberry Pi OS**: 32-bit (\`armhf\`) y 64-bit (\`arm64\`).
- **Cero dependencias Node.js en el equipo destino**: tanto el ejecutor de audio como el servidor web local funcionan íntegramente con Python 3 estándar (\`3.8+\`).

## 2. Cómo se conecta al ecualizador del centro

1. Conecta un cable de audio desde la salida **Jack 3.5 mm**, **HDMI** o **tarjeta USB** del PC Linux / Raspberry Pi hacia la entrada de línea (AUX / LINE IN) de tu **ecualizador o etapa de megafonía**.
2. Cada toque programado ejecuta una unidad \`systemd .timer\` puntual (\`OnCalendar=\`, \`AccuracySec=1s\`, \`Persistent=false\`) que dispara \`timbre_runner.py\`, validando festivos y perfil activo antes de reproducir el sonido.
3. El panel web local (\`campana-web.service\`) permite editar horarios, gestionar festivos, subir archivos MP3/WAV, importar audios desde enlace o YouTube (\`yt-dlp\` + \`ffmpeg\`) o pulsar **Tocar timbre ahora** desde el propio equipo o desde cualquier PC de la red local.

## 3. Instalación rápida

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

# Ver estado del panel web local
sudo systemctl status campana-web

# Ver historial de toques y pruebas de audio
sudo journalctl -u 'campana-ring@*' -f
\`\`\`
`;
}
