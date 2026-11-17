import type { BellAppState, BellScheduleItem, HolidayException } from '../types/bell.ts';

export const DAY_LABELS: { id: number; short: string; full: string }[] = [
  { id: 1, short: 'L', full: 'Lunes' },
  { id: 2, short: 'M', full: 'Martes' },
  { id: 3, short: 'X', full: 'Miércoles' },
  { id: 4, short: 'J', full: 'Jueves' },
  { id: 5, short: 'V', full: 'Viernes' },
  { id: 6, short: 'S', full: 'Sábado' },
  { id: 7, short: 'D', full: 'Domingo' },
];

export function formatDaysSummary(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 7) return 'Todos los días';
  if (sorted.join(',') === '1,2,3,4,5') return 'Lunes a Viernes';
  if (sorted.join(',') === '6,7') return 'Fin de semana';
  return sorted.map((d) => DAY_LABELS.find((x) => x.id === d)?.short ?? '').join(' ');
}

export function toLocalIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getActiveHoliday(date: Date, holidays: HolidayException[]): HolidayException | null {
  const iso = toLocalIsoDate(date);
  return holidays.find((h) => iso >= h.startDate && iso <= (h.endDate || h.startDate)) ?? null;
}

export interface NextBellInfo {
  schedule: BellScheduleItem;
  targetDate: Date;
  countdownText: string;
  isToday: boolean;
}

export function findNextBell(state: BellAppState, now: Date): NextBellInfo | null {
  const activeProfile = state.profiles.find((p) => p.id === state.activeProfileId);
  if (activeProfile?.isSilent) return null;

  const activeItems = state.schedules.filter(
    (s) => s.enabled && s.profileId === state.activeProfileId && s.days.length > 0,
  );
  if (activeItems.length === 0) return null;

  for (let offsetDays = 0; offsetDays < 14; offsetDays++) {
    const candidateDay = new Date(now);
    candidateDay.setDate(now.getDate() + offsetDays);
    const holiday = getActiveHoliday(candidateDay, state.holidays);
    if (holiday) continue;

    const jsDay = candidateDay.getDay();
    const weekday = jsDay === 0 ? 7 : jsDay;

    const dayItems = activeItems
      .filter((s) => s.days.includes(weekday))
      .sort((a, b) => a.time.localeCompare(b.time));

    for (const item of dayItems) {
      const [hh, mm] = item.time.split(':').map(Number);
      const target = new Date(candidateDay);
      target.setHours(hh, mm, 0, 0);
      const diffMs = target.getTime() - now.getTime();
      if (diffMs > 0) {
        const totalSec = Math.floor(diffMs / 1000);
        const hrs = Math.floor(totalSec / 3600);
        const mins = Math.floor((totalSec % 3600) / 60);
        const secs = totalSec % 60;
        const countdownText = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        return {
          schedule: item,
          targetDate: target,
          countdownText,
          isToday: offsetDays === 0,
        };
      }
    }
  }
  return null;
}
