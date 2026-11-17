import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bell,
  CalendarDays,
  Clock,
  Cpu,
  Download,
  Lock,
  LogOut,
  Menu,
  Terminal,
  Volume2,
  X,
} from 'lucide-react';
import type {
  AudioTone,
  BackupRestoreMode,
  BellAppState,
  BellBackupPayload,
  BellScheduleItem,
  HardwareConfig,
  HolidayException,
} from './types/bell.ts';
import { bellAudio } from './utils/bellAudio.ts';
import { getActiveHoliday } from './utils/scheduleHelpers.ts';
import { AuthGateModal } from './components/AuthGateModal.tsx';
import { DashboardView } from './components/DashboardView.tsx';
import { SchedulesView } from './components/SchedulesView.tsx';
import { HardwareAudioView } from './components/HardwareAudioView.tsx';
import { HolidaysView } from './components/HolidaysView.tsx';
import { LinuxDeployView } from './components/LinuxDeployView.tsx';

type NavTab = 'resumen' | 'horarios' | 'hardware' | 'festivos' | 'despliegue';

const NAV_ITEMS: { id: NavTab; label: string; icon: typeof Bell }[] = [
  { id: 'resumen', label: 'Panel Principal', icon: Bell },
  { id: 'horarios', label: 'Horarios y Toques', icon: Clock },
  { id: 'hardware', label: 'Audio y Red Local', icon: Volume2 },
  { id: 'festivos', label: 'Calendario y Festivos', icon: CalendarDays },
  { id: 'despliegue', label: 'Instalar en Linux / RPi', icon: Terminal },
];

export default function App() {
  const [state, setState] = useState<BellAppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<NavTab>('resumen');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [now, setNow] = useState<Date>(() => new Date());
  const [playingToneId, setPlayingToneId] = useState<string | null>(null);
  const [browserAudioEnabled, setBrowserAudioEnabled] = useState(false);
  const [showUnlockModal, setShowUnlockModal] = useState(false);

  const lastBrowserMinuteRef = useRef<string>('');

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) throw new Error('Error al conectar con el servidor de CampanaOS');
      const data = (await res.json()) as BellAppState;
      setState(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de conexión');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchState();
    const poll = window.setInterval(() => {
      void fetchState();
    }, 10000);
    return () => window.clearInterval(poll);
  }, [fetchState]);

  useEffect(() => {
    bellAudio.subscribe((toneId) => setPlayingToneId(toneId));
    return () => bellAudio.stop();
  }, []);

  // 1-second live clock & optional browser audio trigger
  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = new Date();
      setNow(current);

      if (!state || state.locked || !browserAudioEnabled) return;

      const hhmm = `${String(current.getHours()).padStart(2, '0')}:${String(current.getMinutes()).padStart(2, '0')}`;
      const minuteKey = `${current.toISOString().slice(0, 10)} ${hhmm}`;
      if (minuteKey === lastBrowserMinuteRef.current) return;

      const activeProfile = state.profiles.find((p) => p.id === state.activeProfileId);
      const holiday = getActiveHoliday(current, state.holidays);
      if (activeProfile?.isSilent || holiday) {
        lastBrowserMinuteRef.current = minuteKey;
        return;
      }

      const jsDay = current.getDay();
      const weekday = jsDay === 0 ? 7 : jsDay;

      const match = state.schedules.find(
        (s) =>
          s.enabled &&
          s.profileId === state.activeProfileId &&
          s.time === hhmm &&
          s.days.includes(weekday),
      );

      if (match) {
        lastBrowserMinuteRef.current = minuteKey;
        const tone = state.tones.find((t) => t.id === match.toneId);
        if (tone) {
          bellAudio.playTone(tone, state.hardware.masterVolume);
        }
        void fetchState();
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [state, browserAudioEnabled, fetchState]);

  const handleProtectedResponse = async (res: Response): Promise<boolean> => {
    if (res.status === 401) {
      setShowUnlockModal(true);
      return false;
    }
    return res.ok;
  };

  const handleUnlock = async (pin: string): Promise<{ ok: boolean; error?: string }> => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    const data = (await res.json()) as { authenticated?: boolean; state?: BellAppState; error?: string };
    if (!res.ok) {
      return { ok: false, error: data.error ?? 'PIN o contraseña incorrectos.' };
    }
    if (data.state) {
      setState(data.state);
    } else {
      await fetchState();
    }
    setShowUnlockModal(false);
    return { ok: true };
  };

  const handleLogout = async () => {
    const res = await fetch('/api/auth/logout', { method: 'POST' });
    if (res.ok) {
      const data = (await res.json()) as { state: BellAppState };
      setState(data.state);
    }
  };

  const handleToggleBrowserAudio = () => {
    const next = !browserAudioEnabled;
    setBrowserAudioEnabled(next);
    if (next && state) {
      const soft = state.tones.find((t) => t.id === 'recess-bell') ?? state.tones[0];
      if (soft) bellAudio.playTone(soft, Math.min(35, state.hardware.masterVolume));
    } else {
      bellAudio.stop();
    }
  };

  const handleSwitchProfile = async (profileId: string) => {
    const res = await fetch('/api/active-profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId }),
    });
    if (await handleProtectedResponse(res)) {
      const data = (await res.json()) as BellAppState;
      setState(data);
    }
  };

  const handleManualRing = async (toneId: string, label: string, source: 'manual' | 'emergencia') => {
    if (state?.security.authEnabled && !state.authenticated) {
      setShowUnlockModal(true);
      return;
    }
    if (state) {
      const tone = state.tones.find((t) => t.id === toneId) ?? state.tones[0];
      if (tone) {
        bellAudio.playTone(tone, state.hardware.masterVolume);
      }
    }
    const res = await fetch('/api/ring-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toneId, label, source }),
    });
    if (await handleProtectedResponse(res)) {
      const data = (await res.json()) as { state: BellAppState };
      setState(data.state);
    }
  };

  const handleCreateSchedule = async (item: Omit<BellScheduleItem, 'id'>) => {
    const res = await fetch('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    });
    if (await handleProtectedResponse(res)) {
      const data = (await res.json()) as { state: BellAppState };
      setState(data.state);
    }
  };

  const handleUpdateSchedule = async (id: string, patch: Partial<BellScheduleItem>) => {
    const res = await fetch(`/api/schedules/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (await handleProtectedResponse(res)) {
      const data = (await res.json()) as { state: BellAppState };
      setState(data.state);
    }
  };

  const handleDeleteSchedule = async (id: string) => {
    const res = await fetch(`/api/schedules/${id}`, { method: 'DELETE' });
    if (await handleProtectedResponse(res)) {
      const data = (await res.json()) as { state: BellAppState };
      setState(data.state);
    }
  };

  const handleCreateProfile = async (name: string, description: string) => {
    const res = await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, isSilent: false }),
    });
    if (await handleProtectedResponse(res)) {
      const data = (await res.json()) as { state: BellAppState };
      setState(data.state);
    }
  };

  const handleSaveHardware = async (patch: Partial<HardwareConfig>) => {
    const res = await fetch('/api/hardware', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (await handleProtectedResponse(res)) {
      const data = (await res.json()) as { state: BellAppState };
      setState(data.state);
    }
  };

  const handleSaveSecurity = async (payload: {
    authEnabled: boolean;
    newPin?: string;
    currentPin?: string;
    lockReadOnlyPreview: boolean;
    hostnameMdns: string;
    webPort: number;
  }): Promise<{ ok: boolean; error?: string }> => {
    const res = await fetch('/api/security', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) {
      setShowUnlockModal(true);
      return { ok: false, error: 'Se requiere iniciar sesión como administrador.' };
    }
    const data = (await res.json()) as { state?: BellAppState; error?: string };
    if (!res.ok) {
      return { ok: false, error: data.error ?? 'Error al guardar seguridad' };
    }
    if (data.state) setState(data.state);
    return { ok: true };
  };

  const handleUploadTone = async (tone: {
    name: string;
    description: string;
    fileName: string;
    mimeType: string;
    dataUrl: string;
    durationSec: number;
  }) => {
    const res = await fetch('/api/tones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tone),
    });
    if (await handleProtectedResponse(res)) {
      const data = (await res.json()) as { state: BellAppState };
      setState(data.state);
    }
  };

  const handleImportToneFromUrl = async (
    url: string,
    name?: string
  ): Promise<{ ok: boolean; error?: string; toneName?: string }> => {
    try {
      const res = await fetch('/api/tones/import-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, name }),
      });
      if (res.status === 401) {
        setShowUnlockModal(true);
        return { ok: false, error: 'Se requiere desbloquear con el PIN de administrador.' };
      }
      const data = (await res.json()) as { tone?: AudioTone; state?: BellAppState; error?: string };
      if (!res.ok || !data.state) {
        return { ok: false, error: data.error ?? 'No se pudo importar el audio desde el enlace.' };
      }
      setState(data.state);
      return { ok: true, toneName: data.tone?.name };
    } catch {
      return { ok: false, error: 'Error de conexión al intentar importar el enlace.' };
    }
  };

  const handleDeleteTone = async (id: string) => {
    const res = await fetch(`/api/tones/${id}`, { method: 'DELETE' });
    if (await handleProtectedResponse(res)) {
      const data = (await res.json()) as { state: BellAppState };
      setState(data.state);
    }
  };

  const handleCreateHoliday = async (holiday: Omit<HolidayException, 'id'>) => {
    const res = await fetch('/api/holidays', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(holiday),
    });
    if (await handleProtectedResponse(res)) {
      const data = (await res.json()) as { state: BellAppState };
      setState(data.state);
    }
  };

  const handleDeleteHoliday = async (id: string) => {
    const res = await fetch(`/api/holidays/${id}`, { method: 'DELETE' });
    if (await handleProtectedResponse(res)) {
      const data = (await res.json()) as { state: BellAppState };
      setState(data.state);
    }
  };

  const handleClearLogs = async () => {
    const res = await fetch('/api/logs', { method: 'DELETE' });
    if (await handleProtectedResponse(res)) {
      const data = (await res.json()) as { state: BellAppState };
      setState(data.state);
    }
  };

  const handleSyncTimers = async () => {
    const res = await fetch('/api/systemd/sync', { method: 'POST' });
    if (await handleProtectedResponse(res)) {
      const data = (await res.json()) as { state: BellAppState };
      setState(data.state);
    }
  };

  const handlePreviewToneById = (toneId: string) => {
    if (!state) return;
    const tone = state.tones.find((t) => t.id === toneId);
    if (tone) {
      bellAudio.playTone(tone, state.hardware.masterVolume);
    }
  };

  const handlePreviewTone = (tone: AudioTone) => {
    if (!state) return;
    bellAudio.playTone(tone, state.hardware.masterVolume);
  };

  const handleDownloadZip = () => {
    if (state?.security.authEnabled && !state.authenticated) {
      setShowUnlockModal(true);
      return;
    }
    const link = document.createElement('a');
    link.href = '/api/export/bundle';
    link.download = 'campana-os-linux-rpi.zip';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExportBackup = (backupName: string) => {
    if (state?.security.authEnabled && !state.authenticated) {
      setShowUnlockModal(true);
      return;
    }
    const cleanName = backupName.trim() || 'Horario Normal';
    const slug = cleanName
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'respaldo';
    const link = document.createElement('a');
    link.href = `/api/backup/export?name=${encodeURIComponent(cleanName)}`;
    link.download = `campana-${slug}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleImportBackup = async (
    backup: BellBackupPayload,
    mode: BackupRestoreMode
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/backup/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backup, mode }),
      });
      if (res.status === 401) {
        setShowUnlockModal(true);
        return { ok: false, error: 'Se requiere desbloquear con el PIN de administrador.' };
      }
      const data = (await res.json()) as { state?: BellAppState; error?: string };
      if (!res.ok || !data.state) {
        return { ok: false, error: data.error ?? 'Error al importar el respaldo JSON.' };
      }
      setState(data.state);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Error de conexión al enviar el archivo de respaldo.' };
    }
  };

  if (!loading && state?.locked) {
    return (
      <AuthGateModal
        mode="fullscreen"
        schoolName={state.hardware.schoolName}
        hostnameMdns={state.security.hostnameMdns}
        onUnlock={handleUnlock}
      />
    );
  }

  const currentNavLabel = NAV_ITEMS.find((i) => i.id === activeTab)?.label ?? 'Panel Principal';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Desktop Sidebar (256px) */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 bg-white border-r border-slate-200">
        <div className="h-16 px-6 flex items-center border-b border-slate-200">
          <span className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap">
            CampanaOS
          </span>
        </div>

        <nav className="flex-1 px-3 py-5 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {state && (
          <div className="p-4 border-t border-slate-200 text-xs text-slate-500 space-y-1">
            <div className="font-medium text-slate-800 truncate">{state.hardware.schoolName}</div>
            <div className="font-mono truncate">
              systemd .timer · {state.systemdSync.activeTimerCount} activos
            </div>
            <div className="font-mono truncate text-slate-400">
              {state.security.hostnameMdns}.local:{state.security.webPort}
            </div>
          </div>
        )}
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/50"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative w-64 max-w-full bg-white h-full border-r border-slate-200 flex flex-col">
            <div className="h-16 px-5 flex items-center justify-between border-b border-slate-200">
              <span className="font-display text-lg font-bold tracking-tight text-slate-900">
                CampanaOS
              </span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-2 rounded-lg text-slate-500 hover:text-slate-900 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                      active
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        <header className="h-16 bg-white border-b border-slate-200 px-4 sm:px-8 flex items-center justify-between gap-4 sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 rounded-lg text-slate-600 hover:bg-slate-100 cursor-pointer"
              aria-label="Abrir menú"
            >
              <Menu className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-2 text-sm text-slate-500 truncate">
              <span className="font-medium text-slate-900 truncate">
                {state?.hardware.schoolName ?? 'Controlador Escolar'}
              </span>
              <span aria-hidden="true">/</span>
              <span className="truncate">{currentNavLabel}</span>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {state?.security.authEnabled && (
              state.authenticated ? (
                <button
                  type="button"
                  onClick={() => void handleLogout()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 text-xs font-medium hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Bloquear
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowUnlockModal(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 text-xs font-medium hover:bg-amber-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Lock className="w-3.5 h-3.5" />
                  Desbloquear
                </button>
              )
            )}

            <button
              type="button"
              onClick={handleDownloadZip}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Descargar paquete Linux
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-8 max-w-6xl w-full mx-auto">
          {loading ? (
            <div className="space-y-6">
              <div className="h-44 rounded-xl bg-slate-200 animate-pulse" />
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="h-64 rounded-xl bg-slate-200 animate-pulse" />
                <div className="h-64 rounded-xl bg-slate-200 animate-pulse" />
              </div>
            </div>
          ) : error || !state ? (
            <div className="bg-white rounded-xl border border-red-200 p-8 text-center space-y-3">
              <p className="text-base font-semibold text-red-700">
                {error ?? 'No se pudo cargar la configuración del timbre'}
              </p>
              <button
                type="button"
                onClick={() => void fetchState()}
                className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 cursor-pointer"
              >
                Reintentar conexión
              </button>
            </div>
          ) : (
            <>
              {activeTab === 'resumen' && (
                <DashboardView
                  state={state}
                  now={now}
                  playingToneId={playingToneId}
                  browserAudioEnabled={browserAudioEnabled}
                  onToggleBrowserAudio={handleToggleBrowserAudio}
                  onSwitchProfile={(id) => void handleSwitchProfile(id)}
                  onManualRing={(toneId, label, source) => void handleManualRing(toneId, label, source)}
                  onStopAudio={() => bellAudio.stop()}
                  onClearLogs={() => void handleClearLogs()}
                  onNavigate={(tab) => setActiveTab(tab)}
                />
              )}

              {activeTab === 'horarios' && (
                <SchedulesView
                  state={state}
                  onCreateSchedule={handleCreateSchedule}
                  onUpdateSchedule={handleUpdateSchedule}
                  onDeleteSchedule={handleDeleteSchedule}
                  onCreateProfile={handleCreateProfile}
                  onPreviewTone={handlePreviewToneById}
                />
              )}

              {activeTab === 'hardware' && (
                <HardwareAudioView
                  state={state}
                  playingToneId={playingToneId}
                  onSaveHardware={handleSaveHardware}
                  onSaveSecurity={handleSaveSecurity}
                  onPreviewTone={handlePreviewTone}
                  onStopAudio={() => bellAudio.stop()}
                  onUploadTone={handleUploadTone}
                  onImportToneFromUrl={handleImportToneFromUrl}
                  onDeleteTone={handleDeleteTone}
                  onExportBackup={handleExportBackup}
                  onImportBackup={handleImportBackup}
                />
              )}

              {activeTab === 'festivos' && (
                <HolidaysView
                  state={state}
                  onCreateHoliday={handleCreateHoliday}
                  onDeleteHoliday={handleDeleteHoliday}
                />
              )}

              {activeTab === 'despliegue' && (
                <LinuxDeployView
                  state={state}
                  onDownloadZip={handleDownloadZip}
                  onSyncTimers={handleSyncTimers}
                />
              )}
            </>
          )}
        </main>
      </div>

      {showUnlockModal && state && (
        <AuthGateModal
          mode="modal"
          schoolName={state.hardware.schoolName}
          hostnameMdns={state.security.hostnameMdns}
          onUnlock={handleUnlock}
          onClose={() => setShowUnlockModal(false)}
        />
      )}
    </div>
  );
}
