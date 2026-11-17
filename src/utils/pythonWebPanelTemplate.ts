export function generateWebPanelPy(): string {
  return `#!/usr/bin/env python3
"""
CampanaOS - Servidor Web Local y en Red (Python 3.8-3.13+ stdlib, sin Node.js ni pip)
Compatible con Ubuntu 20/22/24 y Raspberry Pi OS Bookworm/Trixie (arm64/armhf).
Sirve la interfaz web compilada desde /opt/campana-os/webapp, gestiona
schedule.json, auth-secrets.json, archivos de audio, disparo manual en el
equipo anfitrión y sincronización de systemd .timer.
"""

import base64
import datetime
import hashlib
import hmac
import io
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request
import uuid
import zipfile
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlparse

BASE_DIR = Path(__file__).resolve().parent
WEBAPP_DIR = BASE_DIR / "webapp"
AUDIO_DIR = BASE_DIR / "audio"
BIN_DIR = BASE_DIR / "bin"
COOKIES_PATH = BASE_DIR / "youtube-cookies.txt"
SCHEDULE_PATH = BASE_DIR / "schedule.json"
SECRETS_PATH = BASE_DIR / "auth-secrets.json"
SYNC_SCRIPT = BASE_DIR / "sync_timers.py"
RUNNER_SCRIPT = BASE_DIR / "timbre_runner.py"
COOKIE_NAME = "campana_session"

STATE_LOCK = threading.Lock()

DIRECT_AUDIO_RE = re.compile(r"\\.(mp3|wav|ogg|m4a|aac|flac)$", re.IGNORECASE)
YOUTUBE_HOST_RE = re.compile(r"(^|\\.)(youtube\\.com|youtu\\.be|youtube-nocookie\\.com)$", re.IGNORECASE)


def slugify_audio_name(value: str) -> str:
    clean = re.sub(r"[^a-zA-Z0-9_-]+", "-", value.strip()).strip("-")
    return clean[:64] or "audio-{0}".format(uuid.uuid4().hex[:6])


def resolve_yt_dlp_bin() -> Optional[str]:
    local_bin = BIN_DIR / "yt-dlp"
    for candidate in (local_bin, Path("/usr/local/bin/yt-dlp")):
        if candidate.is_file() and os.access(str(candidate), os.X_OK):
            return str(candidate)
    return shutil.which("yt-dlp")


def download_latest_yt_dlp() -> Optional[str]:
    try:
        BIN_DIR.mkdir(parents=True, exist_ok=True)
        target = BIN_DIR / "yt-dlp"
        req = urllib.request.Request(
            "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp",
            headers={"User-Agent": "CampanaOS/1.0"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            blob = resp.read()
        if len(blob) > 100000:
            target.write_bytes(blob)
            target.chmod(0o755)
            return str(target)
    except Exception:
        pass
    return None


def detect_js_runtime_args() -> List[str]:
    deno_bin = shutil.which("deno")
    if deno_bin:
        return ["--js-runtimes", "deno:{0}".format(deno_bin)]
    node_bin = shutil.which("node") or shutil.which("nodejs")
    if node_bin:
        return ["--js-runtimes", "node:{0}".format(node_bin)]
    return []


def format_yt_dlp_error(raw_stderr: str, has_cookies: bool) -> str:
    lines = [ln.strip() for ln in (raw_stderr or "").splitlines() if ln.strip()]
    error_lines = [ln for ln in lines if ln.startswith("ERROR:")]
    detail = error_lines[-1] if error_lines else (lines[-1] if lines else "No se pudo extraer el audio con yt-dlp.")
    low = detail.lower()
    if "sign in" in low or "bot" in low or "cookies" in low:
        hint = "YouTube ha pedido verificación anti-bot en esta red. Puedes cargar un archivo cookies.txt en la sección de importación o usar una fuente libre como Pixabay/Freesound."
        return "{0} — {1}".format(detail, hint)
    if "not available" in low or "unavailable" in low:
        if not has_cookies:
            return "{0} — Comprueba que el vídeo sea público y sin restricción de edad/región. Si sigue fallando, actualiza yt-dlp o carga cookies.txt opcional.".format(detail)
        return "{0} — El vídeo no está disponible (privado, eliminado o bloqueado en esta región).".format(detail)
    return detail


def import_audio_from_url(raw_url: str, custom_name: str) -> Dict[str, Any]:
    parsed = urlparse(raw_url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("Introduce una URL válida que empiece por http:// o https://")

    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    path_lower = unquote(parsed.path or "").lower()
    if DIRECT_AUDIO_RE.search(path_lower):
        req = urllib.request.Request(raw_url.strip(), headers={"User-Agent": "CampanaOS/1.0"})
        with urllib.request.urlopen(req, timeout=45) as resp:
            content = resp.read(25 * 1024 * 1024 + 1)
            if len(content) > 25 * 1024 * 1024:
                raise ValueError("El archivo de audio supera el límite de 25 MB.")
            orig_base = os.path.basename(unquote(parsed.path or "")) or "audio.mp3"
            ext = os.path.splitext(orig_base)[1].lower() or ".mp3"
            stem = custom_name.strip() or os.path.splitext(orig_base)[0].replace("_", " ").replace("-", " ")
            safe_file = "{0}-{1}{2}".format(slugify_audio_name(stem), uuid.uuid4().hex[:6], ext)
            target = AUDIO_DIR / safe_file
            target.write_bytes(content)
            ctype = resp.headers.get("Content-Type") or mimetypes.guess_type(safe_file)[0] or "audio/mpeg"
            return {
                "id": "custom-" + uuid.uuid4().hex[:8],
                "name": stem.strip() or safe_file,
                "category": "custom",
                "description": "Importado desde enlace directo ({0})".format(parsed.netloc),
                "durationSec": 5,
                "fileName": safe_file,
                "mimeType": ctype.split(";")[0].strip(),
            }

    yt_dlp_bin = resolve_yt_dlp_bin() or download_latest_yt_dlp()
    if not yt_dlp_bin:
        raise RuntimeError(
            "yt-dlp no está instalado. Ejecuta en terminal: sudo curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp"
        )
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg no está instalado. Ejecuta: sudo apt-get install -y ffmpeg")

    is_youtube = bool(YOUTUBE_HOST_RE.search(parsed.hostname or ""))
    js_args = detect_js_runtime_args()
    has_cookies = COOKIES_PATH.is_file() and COOKIES_PATH.stat().st_size > 0
    cookie_args = ["--cookies", str(COOKIES_PATH)] if has_cookies else []

    strategies: List[List[str]] = (
        [
            ["--extractor-args", "youtube:player_client=android_vr,tv"],
            ["--extractor-args", "youtube:player_client=tv,web_safari"],
            ["--extractor-args", "youtube:player_client=mweb,ios"],
            [],
        ]
        if is_youtube
        else [[]]
    )

    def run_yt_dlp(bin_path: str, extra_args: List[str], tmp_dir: str) -> subprocess.CompletedProcess:
        out_tpl = str(Path(tmp_dir) / "%(id)s.%(ext)s")
        cmd = [
            bin_path,
            "--force-ipv4",
            "--ignore-config",
            "--no-playlist",
            "--no-warnings",
            "--no-check-certificates",
            "-f",
            "bestaudio/best",
            "--match-filter",
            "duration <= 1800",
            "--extract-audio",
            "--audio-format",
            "mp3",
            "--audio-quality",
            "192K",
            "--print-json",
            *js_args,
            *cookie_args,
            *extra_args,
            "-o",
            out_tpl,
            "--",
            raw_url.strip(),
        ]
        return subprocess.run(cmd, capture_output=True, text=True, timeout=120)

    with tempfile.TemporaryDirectory(prefix="campana_yt_") as tmp_dir:
        last_proc: Optional[subprocess.CompletedProcess] = None
        succeeded_proc: Optional[subprocess.CompletedProcess] = None

        for extra in strategies:
            for stale in Path(tmp_dir).glob("*"):
                if stale.is_file():
                    stale.unlink()
            proc = run_yt_dlp(yt_dlp_bin, extra, tmp_dir)
            last_proc = proc
            if proc.returncode == 0 and list(Path(tmp_dir).glob("*.mp3")):
                succeeded_proc = proc
                break

        if not succeeded_proc and is_youtube:
            refreshed = download_latest_yt_dlp()
            if refreshed:
                for extra in (["--extractor-args", "youtube:player_client=android_vr,tv"], []):
                    for stale in Path(tmp_dir).glob("*"):
                        if stale.is_file():
                            stale.unlink()
                    proc = run_yt_dlp(refreshed, extra, tmp_dir)
                    last_proc = proc
                    if proc.returncode == 0 and list(Path(tmp_dir).glob("*.mp3")):
                        succeeded_proc = proc
                        break

        if not succeeded_proc:
            raw_err = (last_proc.stderr or last_proc.stdout or "") if last_proc else ""
            if not raw_err and last_proc and last_proc.returncode == 0:
                raise RuntimeError("yt-dlp no generó archivo MP3 (¿vídeo de más de 30 minutos o retransmisión en directo?).")
            raise RuntimeError(format_yt_dlp_error(raw_err, has_cookies))

        meta: Dict[str, Any] = {}
        for line in (succeeded_proc.stdout or "").splitlines():
            line = line.strip()
            if line.startswith("{"):
                try:
                    meta = json.loads(line)
                except Exception:
                    pass

        mp3_files = list(Path(tmp_dir).glob("*.mp3"))
        if not mp3_files:
            raise RuntimeError("yt-dlp finalizó sin generar archivo MP3.")

        src_mp3 = mp3_files[0]
        if src_mp3.stat().st_size > 25 * 1024 * 1024:
            raise ValueError("El MP3 resultante supera el límite de 25 MB.")

        raw_title = str(custom_name.strip() or meta.get("title") or src_mp3.stem)
        safe_file = "{0}-{1}.mp3".format(slugify_audio_name(raw_title), uuid.uuid4().hex[:6])
        shutil.copy2(str(src_mp3), str(AUDIO_DIR / safe_file))
        duration_val = float(meta.get("duration") or 10)
        return {
            "id": "custom-" + uuid.uuid4().hex[:8],
            "name": raw_title[:80],
            "category": "custom",
            "description": "Audio extraído con yt-dlp ({0})".format(parsed.netloc),
            "durationSec": max(1, int(round(duration_val))),
            "fileName": safe_file,
            "mimeType": "audio/mpeg",
        }


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_secrets() -> Dict[str, Any]:
    if not SECRETS_PATH.exists():
        data = {
            "adminPinHash": None,
            "adminPinSalt": None,
            "sessionSecret": secrets.token_hex(32),
        }
        SECRETS_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return data
    try:
        data = json.loads(SECRETS_PATH.read_text(encoding="utf-8"))
        if not data.get("sessionSecret"):
            data["sessionSecret"] = secrets.token_hex(32)
        return data
    except Exception:
        return {
            "adminPinHash": None,
            "adminPinSalt": None,
            "sessionSecret": secrets.token_hex(32),
        }


def save_secrets(data: Dict[str, Any]) -> None:
    SECRETS_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")


def hash_pin(pin: str, salt: str) -> str:
    dk = hashlib.scrypt(pin.encode("utf-8"), salt=salt.encode("utf-8"), n=16384, r=8, p=1, dklen=64)
    return dk.hex()


def verify_pin(pin: str, sec: Dict[str, Any]) -> bool:
    stored = sec.get("adminPinHash")
    salt = sec.get("adminPinSalt")
    if not stored or not salt:
        return False
    candidate = hash_pin(pin, salt)
    return hmac.compare_digest(candidate, stored)


def sign_session(secret_hex: str) -> str:
    expires = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000) + 7 * 24 * 3600 * 1000
    nonce = secrets.token_hex(8)
    payload = "{0}.{1}".format(expires, nonce)
    sig = hmac.new(secret_hex.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return "{0}.{1}".format(payload, sig)


def verify_session(token: Optional[str], secret_hex: str) -> bool:
    if not token:
        return False
    parts = token.split(".")
    if len(parts) != 3:
        return False
    expires_str, nonce, sig = parts
    try:
        expires_ms = int(expires_str)
    except ValueError:
        return False
    now_ms = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
    if now_ms > expires_ms:
        return False
    payload = "{0}.{1}".format(expires_str, nonce)
    expected = hmac.new(secret_hex.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected)


def load_state() -> Dict[str, Any]:
    data = json.loads(SCHEDULE_PATH.read_text(encoding="utf-8"))
    if "security" not in data:
        net = data.get("network", {})
        data["security"] = {
            "authEnabled": False,
            "hasAdminPin": False,
            "lockReadOnlyPreview": False,
            "hostnameMdns": net.get("hostnameMdns", "campana-escolar"),
            "webPort": int(net.get("webPort", 3000)),
        }
    if "logs" not in data:
        data["logs"] = []
    if "systemdSync" not in data:
        data["systemdSync"] = {
            "supported": SYNC_SCRIPT.exists(),
            "lastSyncedAt": None,
            "activeTimerCount": 0,
            "lastMessage": "Listo para sincronizar systemd .timer.",
        }
    data["systemdSync"]["supported"] = SYNC_SCRIPT.exists()
    data["systemdSync"]["activeTimerCount"] = count_active_timers(data)
    return data


def count_active_timers(data: Dict[str, Any]) -> int:
    active_id = data.get("activeProfileId")
    profiles = {p["id"]: p for p in data.get("profiles", [])}
    if profiles.get(active_id, {}).get("isSilent", False):
        return 0
    return sum(
        1
        for item in data.get("schedules", [])
        if item.get("enabled", True) and item.get("profileId") == active_id and item.get("days")
    )


def save_state(data: Dict[str, Any]) -> None:
    data["network"] = {
        "hostnameMdns": data["security"].get("hostnameMdns", "campana-escolar"),
        "webPort": int(data["security"].get("webPort", 3000)),
    }
    data["systemdSync"]["activeTimerCount"] = count_active_timers(data)
    data["serverTimeIso"] = now_iso()
    SCHEDULE_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def sync_systemd_timers(data: Dict[str, Any]) -> Dict[str, Any]:
    count = count_active_timers(data)
    if not SYNC_SCRIPT.exists():
        data["systemdSync"] = {
            "supported": False,
            "lastSyncedAt": data["systemdSync"].get("lastSyncedAt"),
            "activeTimerCount": count,
            "lastMessage": "Script sync_timers.py no encontrado.",
        }
        save_state(data)
        return data["systemdSync"]

    try:
        proc = subprocess.run(
            ["sudo", "-n", sys.executable, str(SYNC_SCRIPT)],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if proc.returncode == 0:
            msg = proc.stdout.strip() or "{0} unidades systemd .timer sincronizadas.".format(count)
            data["systemdSync"] = {
                "supported": True,
                "lastSyncedAt": now_iso(),
                "activeTimerCount": count,
                "lastMessage": msg,
            }
        else:
            err = proc.stderr.strip() or proc.stdout.strip() or "Error de permisos sudo"
            data["systemdSync"] = {
                "supported": True,
                "lastSyncedAt": data["systemdSync"].get("lastSyncedAt"),
                "activeTimerCount": count,
                "lastMessage": "Error al sincronizar systemd: {0}".format(err),
            }
    except Exception as exc:
        data["systemdSync"] = {
            "supported": True,
            "lastSyncedAt": data["systemdSync"].get("lastSyncedAt"),
            "activeTimerCount": count,
            "lastMessage": "Error al sincronizar systemd: {0}".format(exc),
        }
    save_state(data)
    return data["systemdSync"]


def detect_lan_ips() -> List[str]:
    ips: List[str] = []
    try:
        out = subprocess.check_output(["hostname", "-I"], text=True, timeout=2)
        for tok in out.split():
            if re.match(r"^\\d+\\.\\d+\\.\\d+\\.\\d+$", tok) and not tok.startswith("127."):
                if tok not in ips:
                    ips.append(tok)
    except Exception:
        pass
    return ips[:4]


def build_client_state(data: Dict[str, Any], sec: Dict[str, Any], authenticated: bool) -> Dict[str, Any]:
    sec_cfg = data.get("security", {})
    has_pin = bool(sec.get("adminPinHash"))
    lan_ips = detect_lan_ips()
    has_cookies = COOKIES_PATH.is_file() and COOKIES_PATH.stat().st_size > 0
    if sec_cfg.get("authEnabled") and sec_cfg.get("lockReadOnlyPreview") and not authenticated:
        return {
            "activeProfileId": data.get("activeProfileId"),
            "profiles": [],
            "schedules": [],
            "holidays": [],
            "tones": [],
            "hardware": {
                **data.get("hardware", {}),
                "linuxUser": "***",
            },
            "security": {
                **sec_cfg,
                "hasAdminPin": has_pin,
            },
            "systemdSync": {
                "supported": data["systemdSync"]["supported"],
                "lastSyncedAt": None,
                "activeTimerCount": 0,
                "lastMessage": "Panel bloqueado. Inicia sesión como administrador.",
            },
            "authenticated": False,
            "locked": True,
            "lanIps": lan_ips,
            "hasYoutubeCookies": has_cookies,
            "logs": [],
            "serverTimeIso": now_iso(),
        }

    out = dict(data)
    out["security"] = {**sec_cfg, "hasAdminPin": has_pin}
    out["authenticated"] = authenticated
    out["locked"] = False
    out["lanIps"] = lan_ips
    out["hasYoutubeCookies"] = has_cookies
    out["serverTimeIso"] = now_iso()
    return out


class CampanaHandler(BaseHTTPRequestHandler):
    server_version = "CampanaOS-Python/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        sys.stdout.write("[CampanaWeb] " + (format % args) + "\\n")
        sys.stdout.flush()

    def _read_json_body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def _send_json(self, status: int, payload: Any, cookie_header: Optional[str] = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if cookie_header:
            self.send_header("Set-Cookie", cookie_header)
        self.end_headers()
        self.wfile.write(body)

    def _is_authenticated(self, data: Dict[str, Any], sec: Dict[str, Any]) -> bool:
        if not data.get("security", {}).get("authEnabled") or not sec.get("adminPinHash"):
            return True
        raw_cookie = self.headers.get("Cookie", "")
        jar = cookies.SimpleCookie()
        jar.load(raw_cookie)
        morsel = jar.get(COOKIE_NAME)
        token = morsel.value if morsel else None
        return verify_session(token, sec["sessionSecret"])

    def _require_auth(self, data: Dict[str, Any], sec: Dict[str, Any]) -> bool:
        if self._is_authenticated(data, sec):
            return True
        self._send_json(401, {"error": "Se requiere PIN o contraseña de administrador para realizar esta acción."})
        return False

    def _serve_static(self, path_str: str) -> None:
        rel = path_str.lstrip("/") or "index.html"
        target = (WEBAPP_DIR / rel).resolve()
        if not str(target).startswith(str(WEBAPP_DIR.resolve())) or not target.is_file():
            target = WEBAPP_DIR / "index.html"
        if not target.is_file():
            self._send_json(404, {"error": "Archivo web no encontrado en /opt/campana-os/webapp"})
            return
        ctype, _ = mimetypes.guess_type(str(target))
        content = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path_str = parsed.path

        if path_str == "/api/state":
            with STATE_LOCK:
                sec = load_secrets()
                data = load_state()
                auth = self._is_authenticated(data, sec)
                self._send_json(200, build_client_state(data, sec, auth))
            return

        if path_str == "/api/export/bundle":
            with STATE_LOCK:
                sec = load_secrets()
                data = load_state()
                if not self._require_auth(data, sec):
                    return
                buf = io.BytesIO()
                with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                    for fname in ["schedule.json", "timbre_runner.py", "sync_timers.py", "web_panel.py", "README.md"]:
                        fpath = BASE_DIR / fname
                        if fpath.is_file():
                            zf.write(fpath, fname)
                    if AUDIO_DIR.is_dir():
                        for af in AUDIO_DIR.iterdir():
                            if af.is_file():
                                zf.write(af, "audio/" + af.name)
                blob = buf.getvalue()
                self.send_response(200)
                self.send_header("Content-Type", "application/zip")
                self.send_header("Content-Disposition", 'attachment; filename="campana-os-backup.zip"')
                self.send_header("Content-Length", str(len(blob)))
                self.end_headers()
                self.wfile.write(blob)
            return

        if path_str == "/api/backup/export":
            with STATE_LOCK:
                sec = load_secrets()
                data = load_state()
                if not self._require_auth(data, sec):
                    return
                query = parse_qs(parsed.query)
                raw_name = (query.get("name") or ["respaldo-campana-os"])[0].strip()
                safe_slug = "".join(c if (c.isalnum() or c in "-_") else "-" for c in raw_name.lower()).strip("-") or "respaldo-campana-os"
                exported_tones = []
                for t in data.get("tones", []):
                    t_copy = dict(t)
                    if t_copy.get("category") == "custom" and not t_copy.get("dataUrl") and t_copy.get("fileName"):
                        af = AUDIO_DIR / os.path.basename(t_copy["fileName"])
                        if af.is_file():
                            mime = t_copy.get("mimeType") or mimetypes.guess_type(str(af))[0] or "audio/mpeg"
                            b64 = base64.b64encode(af.read_bytes()).decode("ascii")
                            t_copy["dataUrl"] = "data:{0};base64,{1}".format(mime, b64)
                    exported_tones.append(t_copy)
                sec_cfg = data.get("security", {})
                backup_payload = {
                    "format": "campana-os-backup",
                    "version": 1,
                    "backupName": raw_name or "Respaldo CampanaOS",
                    "exportedAt": now_iso(),
                    "activeProfileId": data.get("activeProfileId"),
                    "profiles": data.get("profiles", []),
                    "schedules": data.get("schedules", []),
                    "holidays": data.get("holidays", []),
                    "tones": exported_tones,
                    "hardware": data.get("hardware", {}),
                    "security": {
                        "authEnabled": bool(sec_cfg.get("authEnabled", False)),
                        "lockReadOnlyPreview": bool(sec_cfg.get("lockReadOnlyPreview", False)),
                        "hostnameMdns": sec_cfg.get("hostnameMdns", "campana-escolar"),
                        "webPort": int(sec_cfg.get("webPort", 3000)),
                    },
                }
                blob = json.dumps(backup_payload, indent=2, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Disposition", 'attachment; filename="{0}.json"'.format(safe_slug))
                self.send_header("Content-Length", str(len(blob)))
                self.end_headers()
                self.wfile.write(blob)
            return

        if path_str.startswith("/audio/"):
            fname = os.path.basename(path_str[len("/audio/"):])
            af = (AUDIO_DIR / fname).resolve()
            if fname and str(af).startswith(str(AUDIO_DIR.resolve())) and af.is_file():
                ctype, _ = mimetypes.guess_type(str(af))
                blob = af.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", ctype or "audio/mpeg")
                self.send_header("Content-Length", str(len(blob)))
                self.end_headers()
                self.wfile.write(blob)
                return
            self._send_json(404, {"error": "Audio no encontrado"})
            return

        self._serve_static(path_str)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path_str = parsed.path
        body = self._read_json_body()

        if path_str == "/api/tones/import-url":
            with STATE_LOCK:
                sec = load_secrets()
                data = load_state()
                if not self._require_auth(data, sec):
                    return
            raw_url = str(body.get("url", "")).strip()
            custom_name = str(body.get("name", "")).strip()
            if not raw_url:
                self._send_json(400, {"error": "La URL del audio o vídeo es obligatoria."})
                return
            try:
                created = import_audio_from_url(raw_url, custom_name)
            except ValueError as ve:
                self._send_json(400, {"error": str(ve)})
                return
            except subprocess.TimeoutExpired:
                self._send_json(504, {"error": "Tiempo de espera agotado al descargar el audio."})
                return
            except Exception as exc:
                self._send_json(500, {"error": "Error al importar audio: {0}".format(str(exc))})
                return

            with STATE_LOCK:
                sec = load_secrets()
                data = load_state()
                data["tones"].append(created)
                save_state(data)
                self._send_json(201, {"tone": created, "state": build_client_state(data, sec, True)})
            return

        if path_str == "/api/tones/youtube-cookies":
            with STATE_LOCK:
                sec = load_secrets()
                data = load_state()
                if not self._require_auth(data, sec):
                    return
                cookies_text = str(body.get("cookiesText", "")).strip()
                if not cookies_text or "youtube" not in cookies_text.lower():
                    self._send_json(400, {"error": "El contenido no parece un archivo cookies.txt válido de YouTube en formato Netscape."})
                    return
                COOKIES_PATH.write_text(cookies_text + "\\n", encoding="utf-8")
                self._send_json(200, {"state": build_client_state(data, sec, True)})
            return

        with STATE_LOCK:
            sec = load_secrets()
            data = load_state()

            if path_str == "/api/auth/login":
                pin = str(body.get("pin", ""))
                if not data.get("security", {}).get("authEnabled") or not sec.get("adminPinHash"):
                    self._send_json(200, {"authenticated": True, "state": build_client_state(data, sec, True)})
                    return
                if not pin or not verify_pin(pin, sec):
                    self._send_json(401, {"error": "PIN o contraseña incorrectos."})
                    return
                token = sign_session(sec["sessionSecret"])
                cookie_hdr = "{0}={1}; HttpOnly; Path=/; SameSite=Lax; Max-Age={2}".format(
                    COOKIE_NAME, token, 7 * 24 * 3600
                )
                self._send_json(200, {"authenticated": True, "state": build_client_state(data, sec, True)}, cookie_hdr)
                return

            if path_str == "/api/auth/logout":
                cookie_hdr = "{0}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0".format(COOKIE_NAME)
                auth_now = not bool(data.get("security", {}).get("authEnabled"))
                self._send_json(200, {"authenticated": auth_now, "state": build_client_state(data, sec, auth_now)}, cookie_hdr)
                return

            if not self._require_auth(data, sec):
                return

            if path_str == "/api/profiles":
                name = str(body.get("name", "")).strip()
                if not name:
                    self._send_json(400, {"error": "El nombre del perfil es obligatorio"})
                    return
                created = {
                    "id": "prof-" + uuid.uuid4().hex[:8],
                    "name": name,
                    "description": str(body.get("description", "")).strip() or "Perfil horario personalizado.",
                    "isSilent": bool(body.get("isSilent", False)),
                }
                data["profiles"].append(created)
                save_state(data)
                self._send_json(201, {"profile": created, "state": build_client_state(data, sec, True)})
                return

            if path_str == "/api/schedules":
                hhmm = str(body.get("time", ""))
                label = str(body.get("label", "")).strip()
                if not hhmm or not label:
                    self._send_json(400, {"error": "Hora y etiqueta son obligatorios"})
                    return
                created = {
                    "id": "sch-" + uuid.uuid4().hex[:8],
                    "profileId": body.get("profileId") or data["activeProfileId"],
                    "time": hhmm,
                    "label": label,
                    "days": body.get("days") or [1, 2, 3, 4, 5],
                    "toneId": body.get("toneId") or "classic-bell",
                    "enabled": bool(body.get("enabled", True)),
                }
                data["schedules"].append(created)
                data["schedules"].sort(key=lambda s: s["time"])
                save_state(data)
                sync_systemd_timers(data)
                self._send_json(201, {"schedule": created, "state": build_client_state(data, sec, True)})
                return

            if path_str == "/api/holidays":
                name = str(body.get("name", "")).strip()
                start_date = str(body.get("startDate", ""))
                end_date = str(body.get("endDate", "")) or start_date
                if not name or not start_date:
                    self._send_json(400, {"error": "Nombre y fecha de inicio son obligatorios"})
                    return
                created = {
                    "id": "hol-" + uuid.uuid4().hex[:8],
                    "name": name,
                    "startDate": start_date,
                    "endDate": end_date if end_date >= start_date else start_date,
                }
                data["holidays"].append(created)
                data["holidays"].sort(key=lambda h: h["startDate"])
                save_state(data)
                self._send_json(201, {"holiday": created, "state": build_client_state(data, sec, True)})
                return

            if path_str == "/api/tones":
                name = str(body.get("name", "")).strip()
                data_url = str(body.get("dataUrl", ""))
                file_name = str(body.get("fileName", "")) or "{0}.mp3".format(uuid.uuid4().hex[:8])
                if not name or not data_url:
                    self._send_json(400, {"error": "Nombre y archivo de audio son obligatorios"})
                    return
                safe_name = os.path.basename(file_name)
                if "," in data_url:
                    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
                    raw_b64 = data_url.split(",", 1)[1]
                    (AUDIO_DIR / safe_name).write_bytes(base64.b64decode(raw_b64))
                created = {
                    "id": "custom-" + uuid.uuid4().hex[:8],
                    "name": name,
                    "category": "custom",
                    "description": str(body.get("description", "")).strip() or "Archivo de audio personalizado.",
                    "durationSec": float(body.get("durationSec") or 5),
                    "fileName": safe_name,
                    "mimeType": body.get("mimeType") or "audio/mpeg",
                }
                data["tones"].append(created)
                save_state(data)
                self._send_json(201, {"tone": created, "state": build_client_state(data, sec, True)})
                return

            if path_str == "/api/ring-now":
                tone_id = str(body.get("toneId") or "classic-bell")
                source = str(body.get("source") or "manual")
                tones_map = {t["id"]: t for t in data.get("tones", [])}
                tone = tones_map.get(tone_id) or data["tones"][0]
                now_dt = datetime.datetime.now()
                log = {
                    "id": "log-" + uuid.uuid4().hex[:8],
                    "timestamp": now_iso(),
                    "timeDisplay": now_dt.strftime("%H:%M:%S"),
                    "label": body.get("label") or ("Alerta de Evacuación Manual" if source == "emergencia" else "Toque Manual"),
                    "toneName": tone["name"],
                    "source": source,
                    "status": "completado",
                }
                data["logs"] = [log] + data.get("logs", [])[:119]
                save_state(data)
                if RUNNER_SCRIPT.exists():
                    subprocess.Popen([sys.executable, str(RUNNER_SCRIPT), "--tone-id", tone["id"]])
                self._send_json(200, {"log": log, "tone": tone, "state": build_client_state(data, sec, True)})
                return

            if path_str == "/api/systemd/sync":
                sync_res = sync_systemd_timers(data)
                self._send_json(200, {"systemdSync": sync_res, "state": build_client_state(data, sec, True)})
                return

            if path_str == "/api/backup/import":
                backup = body.get("backup")
                mode = str(body.get("mode") or "schedules-and-audio")
                if not isinstance(backup, dict) or backup.get("format") != "campana-os-backup":
                    self._send_json(400, {"error": "El archivo no es un respaldo válido de CampanaOS."})
                    return
                profiles = backup.get("profiles") or []
                schedules = backup.get("schedules") or []
                holidays = backup.get("holidays") or []
                tones = backup.get("tones") or []
                if not isinstance(profiles, list) or len(profiles) == 0:
                    self._send_json(400, {"error": "El respaldo no contiene perfiles horarios válidos."})
                    return

                AUDIO_DIR.mkdir(parents=True, exist_ok=True)
                restored_tones = []
                for t in tones:
                    t_copy = dict(t)
                    if t_copy.get("category") == "custom":
                        safe_name = os.path.basename(str(t_copy.get("fileName") or "{0}.mp3".format(t_copy.get("id", "audio"))))
                        raw_url = str(t_copy.pop("dataUrl", "") or "")
                        if "," in raw_url:
                            raw_b64 = raw_url.split(",", 1)[1]
                            (AUDIO_DIR / safe_name).write_bytes(base64.b64decode(raw_b64))
                        t_copy["fileName"] = safe_name
                    restored_tones.append(t_copy)

                data["profiles"] = profiles
                active_id = backup.get("activeProfileId")
                data["activeProfileId"] = active_id if any(p.get("id") == active_id for p in profiles) else profiles[0]["id"]
                data["schedules"] = sorted(schedules, key=lambda s: str(s.get("time", "")))
                data["holidays"] = sorted(holidays, key=lambda h: str(h.get("startDate", "")))
                if restored_tones:
                    data["tones"] = restored_tones

                if mode == "full":
                    hw = backup.get("hardware")
                    if isinstance(hw, dict):
                        for key in ["schoolName", "linuxUser", "audioBackend", "audioOutput", "masterVolume", "timezone"]:
                            if key in hw:
                                data["hardware"][key] = hw[key]
                    sec_in = backup.get("security")
                    if isinstance(sec_in, dict):
                        if "hostnameMdns" in sec_in:
                            data["security"]["hostnameMdns"] = str(sec_in["hostnameMdns"])
                        if "webPort" in sec_in:
                            data["security"]["webPort"] = int(sec_in["webPort"])
                        if "lockReadOnlyPreview" in sec_in:
                            data["security"]["lockReadOnlyPreview"] = bool(sec_in["lockReadOnlyPreview"])

                save_state(data)
                sync_systemd_timers(data)
                self._send_json(200, {"state": build_client_state(data, sec, True)})
                return

            self._send_json(404, {"error": "Ruta no encontrada"})

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        path_str = parsed.path
        body = self._read_json_body()

        with STATE_LOCK:
            sec = load_secrets()
            data = load_state()
            if not self._require_auth(data, sec):
                return

            if path_str == "/api/active-profile":
                profile_id = body.get("profileId")
                if not any(p["id"] == profile_id for p in data["profiles"]):
                    self._send_json(400, {"error": "Perfil no válido"})
                    return
                data["activeProfileId"] = profile_id
                save_state(data)
                sync_systemd_timers(data)
                self._send_json(200, build_client_state(data, sec, True))
                return

            if path_str.startswith("/api/schedules/"):
                sch_id = path_str.split("/")[-1]
                for idx, item in enumerate(data["schedules"]):
                    if item["id"] == sch_id:
                        updated = dict(item)
                        for key in ["time", "label", "days", "toneId", "enabled", "profileId"]:
                            if key in body:
                                updated[key] = body[key]
                        data["schedules"][idx] = updated
                        data["schedules"].sort(key=lambda s: s["time"])
                        save_state(data)
                        sync_systemd_timers(data)
                        self._send_json(200, {"schedule": updated, "state": build_client_state(data, sec, True)})
                        return
                self._send_json(404, {"error": "Toque no encontrado"})
                return

            if path_str == "/api/hardware":
                for key in ["schoolName", "linuxUser", "audioBackend", "audioOutput", "masterVolume", "timezone"]:
                    if key in body:
                        data["hardware"][key] = body[key]
                save_state(data)
                self._send_json(200, {"hardware": data["hardware"], "state": build_client_state(data, sec, True)})
                return

            if path_str == "/api/security":
                new_pin = str(body.get("newPin") or "").strip()
                cur_pin = str(body.get("currentPin") or "")
                if new_pin:
                    if len(new_pin) < 4:
                        self._send_json(400, {"error": "El PIN o contraseña debe tener al menos 4 caracteres."})
                        return
                    if sec.get("adminPinHash") and cur_pin and not verify_pin(cur_pin, sec):
                        self._send_json(403, {"error": "La contraseña actual no coincide."})
                        return
                    salt = secrets.token_hex(16)
                    sec["adminPinSalt"] = salt
                    sec["adminPinHash"] = hash_pin(new_pin, salt)
                    save_secrets(sec)

                auth_enabled = bool(body.get("authEnabled", data["security"]["authEnabled"]))
                if auth_enabled and not sec.get("adminPinHash"):
                    self._send_json(400, {"error": "Debes definir un PIN antes de activar el bloqueo."})
                    return

                raw_host = str(body.get("hostnameMdns") or data["security"]["hostnameMdns"]).strip().lower()
                clean_host = "".join(c if (c.isalnum() or c == "-") else "-" for c in raw_host).strip("-") or "campana-escolar"
                try:
                    port_val = int(body.get("webPort") or data["security"]["webPort"])
                    if port_val < 80 or port_val > 65535:
                        port_val = int(data["security"]["webPort"])
                except ValueError:
                    port_val = int(data["security"]["webPort"])

                data["security"] = {
                    "authEnabled": auth_enabled,
                    "hasAdminPin": bool(sec.get("adminPinHash")),
                    "lockReadOnlyPreview": bool(body.get("lockReadOnlyPreview", data["security"]["lockReadOnlyPreview"])),
                    "hostnameMdns": clean_host,
                    "webPort": port_val,
                }
                save_state(data)
                sync_systemd_timers(data)

                cookie_hdr = None
                if auth_enabled:
                    token = sign_session(sec["sessionSecret"])
                    cookie_hdr = "{0}={1}; HttpOnly; Path=/; SameSite=Lax; Max-Age={2}".format(
                        COOKIE_NAME, token, 7 * 24 * 3600
                    )
                self._send_json(200, {"security": data["security"], "state": build_client_state(data, sec, True)}, cookie_hdr)
                return

            self._send_json(404, {"error": "Ruta no encontrada"})

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        path_str = parsed.path

        with STATE_LOCK:
            sec = load_secrets()
            data = load_state()
            if not self._require_auth(data, sec):
                return

            if path_str.startswith("/api/schedules/"):
                sch_id = path_str.split("/")[-1]
                data["schedules"] = [s for s in data["schedules"] if s["id"] != sch_id]
                save_state(data)
                sync_systemd_timers(data)
                self._send_json(200, {"state": build_client_state(data, sec, True)})
                return

            if path_str.startswith("/api/holidays/"):
                hol_id = path_str.split("/")[-1]
                data["holidays"] = [h for h in data["holidays"] if h["id"] != hol_id]
                save_state(data)
                self._send_json(200, {"state": build_client_state(data, sec, True)})
                return

            if path_str.startswith("/api/tones/"):
                tone_id = path_str.split("/")[-1]
                tone = next((t for t in data["tones"] if t["id"] == tone_id), None)
                if not tone or tone.get("category") == "built-in":
                    self._send_json(400, {"error": "No se pueden eliminar los tonos integrados"})
                    return
                data["tones"] = [t for t in data["tones"] if t["id"] != tone_id]
                for s in data["schedules"]:
                    if s.get("toneId") == tone_id:
                        s["toneId"] = "classic-bell"
                save_state(data)
                self._send_json(200, {"state": build_client_state(data, sec, True)})
                return

            if path_str == "/api/tones/youtube-cookies":
                if COOKIES_PATH.exists():
                    COOKIES_PATH.unlink()
                self._send_json(200, {"state": build_client_state(data, sec, True)})
                return

            if path_str == "/api/logs":
                data["logs"] = []
                save_state(data)
                self._send_json(200, {"state": build_client_state(data, sec, True)})
                return

            self._send_json(404, {"error": "Ruta no encontrada"})


def main() -> None:
    data = load_state()
    port = int(os.environ.get("PORT") or data.get("security", {}).get("webPort") or 3000)
    server = ThreadingHTTPServer(("0.0.0.0", port), CampanaHandler)
    sys.stdout.write("CampanaOS Web Panel escuchando en http://0.0.0.0:{0}\\n".format(port))
    sys.stdout.flush()
    server.serve_forever()


if __name__ == "__main__":
    main()
`;
}
