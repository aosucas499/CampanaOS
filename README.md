# CampanaOS — Timbre Escolar por Audio Linux (`systemd .timer` + Web Local)

Sistema autónomo de automatización de timbres escolares por **audio puro** hacia ecualizador o etapa de megafonía, sin Node.js ni `pip` en el equipo destino. Diseñado para **Raspberry Pi OS (Trixie / Bookworm en 32 y 64 bits)** y **Ubuntu Server / Desktop**.

## Instalación rápida desde GitHub (`git clone`)

En tu Raspberry Pi o PC Linux, clona el repositorio y ejecuta el instalador como superusuario:

```bash
git clone http://github.com/aosucas499//campana-os
cd campana-os
sudo ./install.sh
```

El instalador (`install.sh`):
- Detecta automáticamente tu usuario Linux (`$SUDO_USER`, con soporte opcional `--user <usuario>`) y su `UID` para PipeWire headless.
- Instala `python3`, `mpv`, `ffmpeg`, `yt-dlp`, `alsa-utils`, `pipewire-pulse`/`pipewire-alsa` y `avahi-daemon` sin usar `pip` global ni instalar Node.js.
- Configura `/opt/campana-os` con la interfaz web ya compilada (`deploy/webapp/`), activa los *timers* `systemd` y levanta `campana-web.service` en el puerto `3000`.

### Actualizar tras cambios en GitHub (`git pull`)

```bash
cd campana-os
git pull
sudo bash install.sh
```

Al detectar una instalación previa en `/opt/campana-os`, **`install.sh` conserva automáticamente** tus horarios (`schedule.json`), el PIN administrador (`auth-secrets.json`) y los audios personalizados en `/opt/campana-os/audio/`, actualizando únicamente los scripts y la interfaz web. Si deseas restablecer la configuración base de fábrica, añade `--reset-config`.

---

## Hardware y compatibilidad verificada

- **Raspberry Pi OS**: **Trixie (Debian 13)** y **Bookworm (Debian 12)** en **32-bit (`armhf`)** y **64-bit (`arm64`)**.
- **Ubuntu**: 20.04 LTS, 22.04 LTS y 24.04 LTS (`x86_64` / `arm64`).
- **Python**: 3.8 – 3.13+ usando únicamente librería estándar.
- **Conexión de audio al ecualizador**:
  - **Jack 3.5 mm** (Raspberry Pi 3/4): `timbre_runner.py` autodetecta el *sink* analógico `Headphones` en PipeWire (o `plughw:CARD=Headphones,DEV=0` en ALSA) evitando que el HDMI (`vc4hdmi`) capture `hw:0,0`.
  - **HDMI** o **Tarjeta de sonido USB** (recomendado en Raspberry Pi 5).

## Acceso al panel y comandos útiles

- **Panel local**: `http://localhost:3000`
- **Panel en red local (mDNS)**: `http://campana-escolar.local:3000`

```bash
# Ver próximos timbres programados
systemctl list-timers 'campana-ring-*'

# Ver salidas PipeWire y tarjetas ALSA detectadas
pactl list short sinks || aplay -l

# Ver estado del panel web local
sudo systemctl status campana-web

# Ver historial de toques y pruebas de audio
sudo journalctl -u 'campana-ring@*' -f

# Probar salida de audio inmediatamente
sudo -u "$USER" python3 /opt/campana-os/timbre_runner.py --test-audio
```

---

## Desarrollo (PC de trabajo)

Si modificas la interfaz React/TypeScript o las plantillas de despliegue, regenera `install.sh` y `deploy/` antes de hacer `git push`:

```bash
npm install
npm run sync:deploy
```

También puedes iniciar el entorno de desarrollo local en `http://localhost:3000` con `npm run dev`.
