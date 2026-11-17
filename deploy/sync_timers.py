#!/usr/bin/env python3
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
