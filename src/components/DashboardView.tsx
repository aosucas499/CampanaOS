import { useState } from 'react';
import { Bell, CalendarOff, Play, ShieldAlert, Square, Trash2, Volume2 } from 'lucide-react';
import type { BellAppState } from '../types/bell.ts';
import { findNextBell, formatDaysSummary, getActiveHoliday } from '../utils/scheduleHelpers.ts';

interface DashboardViewProps {
  state: BellAppState;
  now: Date;
  playingToneId: string | null;
  browserAudioEnabled: boolean;
  onToggleBrowserAudio: () => void;
  onSwitchProfile: (profileId: string) => void;
  onManualRing: (toneId: string, label: string, source: 'manual' | 'emergencia') => void;
  onStopAudio: () => void;
  onClearLogs: () => void;
  onNavigate: (tab: 'horarios' | 'hardware' | 'festivos' | 'despliegue') => void;
}

export function DashboardView({
  state,
  now,
  playingToneId,
  browserAudioEnabled,
  onToggleBrowserAudio,
  onSwitchProfile,
  onManualRing,
  onStopAudio,
  onClearLogs,
  onNavigate,
}: DashboardViewProps) {
  const [manualToneId, setManualToneId] = useState<string>(state.tones[0]?.id ?? 'classic-bell');
  const [confirmEmergency, setConfirmEmergency] = useState(false);

  const activeProfile = state.profiles.find((p) => p.id === state.activeProfileId);
  const activeHoliday = getActiveHoliday(now, state.holidays);
  const nextBell = findNextBell(state, now);

  const timeFormatted = now.toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const dateFormatted = now.toLocaleDateString('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const jsDay = now.getDay();
  const todayWeekday = jsDay === 0 ? 7 : jsDay;
  const currentHhMm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const todaySchedules = state.schedules
    .filter((s) => s.profileId === state.activeProfileId && s.days.includes(todayWeekday))
    .sort((a, b) => a.time.localeCompare(b.time));

  const nextToneName = nextBell
    ? state.tones.find((t) => t.id === nextBell.schedule.toneId)?.name ?? 'Tono estándar'
    : null;

  return (
    <div className="space-y-8">
      {/* Master Instrument Clock & Next Bell */}
      <section className="rounded-xl bg-slate-900 text-white p-6 md:p-8 border border-slate-800">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
          <div className="lg:col-span-7 space-y-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
              <span className="font-medium text-slate-200">{state.hardware.schoolName}</span>
              <span aria-hidden="true">·</span>
              <span className="capitalize">{dateFormatted}</span>
              <span aria-hidden="true">·</span>
              <span>
                Salida {state.hardware.audioBackend} ({state.hardware.audioOutput})
              </span>
            </div>

            <div className="font-mono text-5xl sm:text-6xl font-semibold tracking-tight tabular-nums text-white">
              {timeFormatted}
            </div>

            <div className="pt-2 flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={onToggleBrowserAudio}
                className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  browserAudioEnabled
                    ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                    : 'bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700'
                }`}
              >
                <Volume2 className="w-4 h-4" />
                {browserAudioEnabled ? 'Monitor de audio en navegador activo' : 'Activar monitor en navegador'}
              </button>

              {playingToneId && (
                <button
                  type="button"
                  onClick={onStopAudio}
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium bg-amber-600 text-white hover:bg-amber-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                  Detener reproducción
                </button>
              )}
            </div>
          </div>

          <div className="lg:col-span-5 lg:border-l lg:border-slate-800 lg:pl-8 space-y-2">
            <div className="text-xs font-medium text-slate-400">Próximo toque programado</div>
            {activeProfile?.isSilent ? (
              <div className="space-y-1.5">
                <div className="text-xl font-semibold text-amber-400">Sistema en Modo Silencio</div>
                <p className="text-sm text-slate-400">
                  El perfil activo desactiva los toques automáticos. Cambia a Horario Lectivo para reanudar.
                </p>
              </div>
            ) : activeHoliday ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-xl font-semibold text-amber-400">
                  <CalendarOff className="w-5 h-5 shrink-0" />
                  <span>Festivo: {activeHoliday.name}</span>
                </div>
                <p className="text-sm text-slate-400">
                  Los toques automáticos permanecen suspendidos durante la fecha de hoy.
                </p>
              </div>
            ) : nextBell ? (
              <div className="space-y-2">
                <div className="font-mono text-3xl sm:text-4xl font-semibold tabular-nums text-emerald-400">
                  -{nextBell.countdownText}
                </div>
                <div className="text-base font-medium text-white">
                  {nextBell.schedule.time} · {nextBell.schedule.label}
                </div>
                <div className="text-xs text-slate-400">
                  {nextToneName}
                  <span aria-hidden="true"> · </span>
                  {nextBell.isToday
                    ? 'Hoy'
                    : nextBell.targetDate.toLocaleDateString('es-ES', {
                        weekday: 'long',
                        day: 'numeric',
                        month: 'short',
                      })}
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="text-lg font-semibold text-slate-300">Sin toques pendientes</div>
                <p className="text-sm text-slate-400">
                  No hay timbres habilitados en el perfil actual para los próximos 14 días.
                </p>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Active Profile & Quick Manual Controls */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section className="lg:col-span-7 bg-white rounded-xl border border-slate-200 p-6 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Perfil horario activo</h2>
              <p className="text-sm text-slate-500">
                Cambia al instante entre jornada ordinaria, exámenes, horario intensivo o silencio.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('horarios')}
              className="text-xs font-medium text-slate-700 hover:text-slate-900 underline underline-offset-4 whitespace-nowrap shrink-0 cursor-pointer"
            >
              Editar horarios
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {state.profiles.map((profile) => {
              const isSelected = profile.id === state.activeProfileId;
              const count = state.schedules.filter((s) => s.profileId === profile.id && s.enabled).length;
              return (
                <button
                  key={profile.id}
                  type="button"
                  onClick={() => onSwitchProfile(profile.id)}
                  className={`text-left p-4 rounded-lg border transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-slate-50 text-slate-900 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold truncate">{profile.name}</span>
                    <span className={`text-xs tabular-nums whitespace-nowrap shrink-0 ${isSelected ? 'text-slate-300' : 'text-slate-500'}`}>
                      {profile.isSilent ? 'Silenciado' : `${count} toques`}
                    </span>
                  </div>
                  <p className={`mt-1 text-xs line-clamp-2 ${isSelected ? 'text-slate-300' : 'text-slate-500'}`}>
                    {profile.description}
                  </p>
                </button>
              );
            })}
          </div>
        </section>

        <section className="lg:col-span-5 bg-white rounded-xl border border-slate-200 p-6 flex flex-col justify-between space-y-5">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-slate-900">Disparo manual de timbre</h2>
            <p className="text-sm text-slate-500">
              Reproduce un toque inmediato en la salida de audio del equipo Linux y regístralo en el historial.
            </p>
          </div>

          <div className="space-y-3">
            <label htmlFor="manual-tone-select" className="block text-xs font-medium text-slate-700">
              Melodía o timbre a reproducir
            </label>
            <select
              id="manual-tone-select"
              value={manualToneId}
              onChange={(e) => setManualToneId(e.target.value)}
              className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
            >
              {state.tones.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="button"
                onClick={() => onManualRing(manualToneId, 'Toque Manual', 'manual')}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Bell className="w-4 h-4" />
                Tocar timbre ahora
              </button>

              <button
                type="button"
                onClick={() => setConfirmEmergency(true)}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-red-300 bg-red-50 text-red-700 text-sm font-medium hover:bg-red-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <ShieldAlert className="w-4 h-4" />
                Evacuación
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* Today's Agenda + Recent Logs */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section className="lg:col-span-6 bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Agenda de hoy</h2>
              <p className="text-xs text-slate-500">
                {activeProfile?.name} · {todaySchedules.length} toques configurados hoy
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('festivos')}
              className="text-xs font-medium text-slate-600 hover:text-slate-900 underline underline-offset-4 whitespace-nowrap shrink-0 cursor-pointer"
            >
              Gestionar festivos
            </button>
          </div>

          {todaySchedules.length === 0 ? (
            <div className="p-8 text-center space-y-2">
              <p className="text-sm font-medium text-slate-700">No hay toques programados para hoy</p>
              <p className="text-xs text-slate-500">
                Los días de fin de semana o perfiles en silencio no emiten avisos automáticos.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {todaySchedules.map((item) => {
                const tone = state.tones.find((t) => t.id === item.toneId);
                const passed = item.time < currentHhMm;
                const isNext = nextBell?.isToday && nextBell.schedule.id === item.id;
                return (
                  <div
                    key={item.id}
                    className={`px-6 py-3 flex items-center justify-between gap-4 ${
                      isNext ? 'bg-emerald-50/70' : ''
                    }`}
                  >
                    <div className="flex items-center gap-4 min-w-0">
                      <span
                        className={`font-mono text-sm font-semibold tabular-nums shrink-0 ${
                          !item.enabled
                            ? 'text-slate-400 line-through'
                            : isNext
                              ? 'text-emerald-700'
                              : passed
                                ? 'text-slate-400'
                                : 'text-slate-900'
                        }`}
                      >
                        {item.time}
                      </span>
                      <div className="min-w-0">
                        <div className={`text-sm font-medium truncate ${passed ? 'text-slate-500' : 'text-slate-900'}`}>
                          {item.label}
                        </div>
                        <div className="text-xs text-slate-500 truncate">
                          {tone?.name ?? 'Timbre estándar'}
                          <span aria-hidden="true"> · </span>
                          {formatDaysSummary(item.days)}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <span
                        className={`text-xs font-medium whitespace-nowrap ${
                          !item.enabled
                            ? 'text-slate-400'
                            : activeHoliday
                              ? 'text-amber-700'
                              : isNext
                                ? 'text-emerald-700'
                                : passed
                                  ? 'text-slate-400'
                                  : 'text-slate-600'
                        }`}
                      >
                        {!item.enabled
                          ? 'Desactivado'
                          : activeHoliday
                            ? 'Omitido (festivo)'
                            : isNext
                              ? 'Siguiente'
                              : passed
                                ? 'Completado'
                                : 'Pendiente'}
                      </span>
                      <button
                        type="button"
                        onClick={() => onManualRing(item.toneId, `Prueba: ${item.label}`, 'manual')}
                        title="Probar este toque ahora"
                        className="p-2 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors cursor-pointer"
                      >
                        <Play className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="lg:col-span-6 bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Registro de ejecuciones</h2>
              <p className="text-xs text-slate-500">Últimos disparos automáticos y pruebas manuales</p>
            </div>
            {state.logs.length > 0 && (
              <button
                type="button"
                onClick={onClearLogs}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-red-600 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Limpiar
              </button>
            )}
          </div>

          {state.logs.length === 0 ? (
            <div className="p-8 text-center space-y-2">
              <p className="text-sm font-medium text-slate-700">Registro vacío</p>
              <p className="text-xs text-slate-500">
                Aquí aparecerán los toques ejecutados automáticamente o mediante prueba manual.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100 max-h-[380px] overflow-y-auto">
              {state.logs.slice(0, 20).map((log) => (
                <div key={log.id} className="px-6 py-3 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 truncate">{log.label}</div>
                    <div className="text-xs text-slate-500 truncate">
                      {log.toneName}
                      <span aria-hidden="true"> · </span>
                      {log.source === 'emergencia'
                        ? 'Emergencia'
                        : log.source === 'manual'
                          ? 'Manual'
                          : 'Automático'}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono text-xs font-medium tabular-nums text-slate-700">
                      {log.timeDisplay}
                    </div>
                    <div
                      className={`text-xs font-medium ${
                        log.status === 'completado'
                          ? 'text-emerald-700'
                          : 'text-amber-700'
                      }`}
                    >
                      {log.status === 'completado'
                        ? 'Ejecutado'
                        : log.status === 'omitido-festivo'
                          ? 'Omitido festivo'
                          : 'Silenciado'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Emergency Confirmation Modal */}
      {confirmEmergency && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl border border-slate-200 max-w-md w-full p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-lg bg-red-50 text-red-700 shrink-0">
                <ShieldAlert className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-semibold text-slate-900">
                  Confirmar señal de evacuación
                </h3>
                <p className="text-sm text-slate-600">
                  Esta acción emitirá la sirena de emergencia por la salida de audio conectada al ecualizador del centro.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmEmergency(false)}
                className="px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmEmergency(false);
                  onManualRing('evacuation', 'Alerta de Evacuación', 'emergencia');
                }}
                className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 cursor-pointer"
              >
                Activar sirena ahora
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
