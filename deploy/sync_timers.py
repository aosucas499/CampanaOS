#!/usr/bin/env python3
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
        '<?xml version="1.0" standalone="no"?>\n'
        '<!DOCTYPE service-group SYSTEM "avahi-service.dtd">\n'
        "<service-group>\n"
        "  <name replace-wildcards=\"yes\">CampanaOS - {school} (%h)</name>\n"
        "  <service>\n"
        "    <type>_http._tcp</type>\n"
        "    <port>{port}</port>\n"
        "  </service>\n"
        "</service-group>\n"
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
                Path("/etc/hostname").write_text(mdns_host + "\n", encoding="utf-8")
                subprocess.run(["hostname", mdns_host], check=False)
            except Exception:
                pass
        avahi_changed = True

    try:
        hosts_lines = HOSTS_PATH.read_text(encoding="utf-8").splitlines() if HOSTS_PATH.exists() else []
        new_lines: List[str] = []
        replaced = False
        for line in hosts_lines:
            if re.match(r"^\s*127\.0\.1\.1\s+", line):
                new_lines.append("127.0.1.1\t{0}".format(mdns_host))
                replaced = True
            else:
                new_lines.append(line)
        if not replaced:
            new_lines.append("127.0.1.1\t{0}".format(mdns_host))
        new_hosts_text = "\n".join(new_lines).rstrip() + "\n"
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
                label = str(item.get("label", "Toque escolar")).replace("\n", " ")

                unit_content = (
                    "[Unit]\n"
                    "Description=CampanaOS Timer - {label} ({hhmm})\n\n"
                    "[Timer]\n"
                    "OnCalendar={days_expr} *-*-* {hhmm}:00\n"
                    "AccuracySec=1s\n"
                    "Persistent=false\n"
                    "Unit=campana-ring@{unit_id}.service\n\n"
                    "[Install]\n"
                    "WantedBy=timers.target\n"
                ).format(label=label, hhmm=hhmm, days_expr=days_expr, unit_id=unit_id)

                (SYSTEMD_DIR / timer_name).write_text(unit_content, encoding="utf-8")
                created_timers.append(timer_name)

    run_systemctl("daemon-reload")
    for timer_name in created_timers:
        run_systemctl("enable", "--now", timer_name)

    print("Sincronización completada: {0} timers activos.".format(len(created_timers)))


if __name__ == "__main__":
    main()
