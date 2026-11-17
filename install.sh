#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_USER=""
RESET_CONFIG=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
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
echo " Centro: I.E.S. Sierra Norte"
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
elif [[ "1" -eq 1 || "$SRC_DIR" == "$SCRIPT_DIR/deploy" ]]; then
  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER:-}" != "root" ]] && id "$SUDO_USER" &>/dev/null; then
    TARGET_USER="$SUDO_USER"
  elif id "pi" &>/dev/null; then
    TARGET_USER="pi"
  else
    TARGET_USER=$(awk -F: '$3 >= 1000 && $3 < 65534 {print $1; exit}' /etc/passwd || true)
  fi
else
  TARGET_USER="pi"
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

echo "[2/6] Instalando paquetes de audio PipeWire/ALSA, ffmpeg y red local (sin Node.js ni pip global)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y python3 mpv ffmpeg curl ca-certificates alsa-utils avahi-daemon dbus-user-session

for opt_pkg in pulseaudio-utils pipewire-alsa pipewire-pulse wireplumber; do
  if apt-cache show "$opt_pkg" >/dev/null 2>&1; then
    apt-get install -y "$opt_pkg" || true
  fi
done

echo "[2b/6] Instalando herramienta libre yt-dlp (compatible Python 3.8-3.13 y RPi OS Trixie 32-bit armhf)..."
if curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o /usr/local/bin/yt-dlp; then
  chmod a+rx /usr/local/bin/yt-dlp
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
  if [[ -d "$SRC_DIR/audio" ]]; then
    cp -rf "$SRC_DIR/audio/"* "$INSTALL_DIR/audio/" 2>/dev/null || true
  fi
fi

if [[ -d "$SRC_DIR/webapp" ]]; then
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

echo "[6/6] Activando Avahi mDNS, timers systemd y panel web..."
systemctl enable --now avahi-daemon || true
python3 "$INSTALL_DIR/sync_timers.py"
systemctl daemon-reload
if systemctl is-active --quiet campana-web.service; then
  systemctl enable campana-web.service >/dev/null 2>&1 || true
  systemctl restart campana-web.service
else
  systemctl enable --now campana-web.service
fi

echo ""
echo "Tarjetas de audio detectadas en el sistema:"
aplay -l 2>/dev/null | grep -E '^card ' || true
echo ""
echo "Instalación/actualización completada con éxito."
echo "Panel local:          http://localhost:3000"
echo "Panel en red local:   http://campana-escolar.local:3000 (o http://$(hostname -I | awk '{print $1}'):3000)"
echo "Ver próximos toques:  systemctl list-timers 'campana-ring-*'"
echo "Ver logs de audio:    sudo journalctl -u 'campana-ring@*' -f"
echo "Probar audio ahora:   sudo -u $TARGET_USER python3 $INSTALL_DIR/timbre_runner.py --test-audio"
