import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Check,
  CheckCircle2,
  Download,
  ExternalLink,
  FileUp,
  Globe,
  Info,
  Link2,
  Lock,
  Play,
  ShieldAlert,
  ShieldCheck,
  Speaker,
  Square,
  Trash2,
  Upload,
  Volume2,
  X,
} from 'lucide-react';
import {
  BACKUP_SCHEMA_VERSION,
  type AudioBackend,
  type AudioOutputDevice,
  type AudioTone,
  type BackupRestoreMode,
  type BellAppState,
  type BellBackupPayload,
  type HardwareConfig,
} from '../types/bell.ts';
import { analyzeBackupCompatibility } from '../utils/backupValidation.ts';

const SEASONAL_NAME_PRESETS = ['Horario Normal', 'Navidad', 'Carnaval', 'Fin de Curso'];

const FREE_MUSIC_SOURCES = [
  {
    name: 'Pixabay Music y Efectos',
    url: 'https://pixabay.com/music/',
    license: 'Licencia Pixabay gratuita sin atribución · MP3 directo',
    bestFor: 'Melodías instrumentales, villancicos, jazz suave y tonos de timbre escolar.',
  },
  {
    name: 'Freesound',
    url: 'https://freesound.org/',
    license: 'CC0 Dominio público y CC-BY · WAV / MP3',
    bestFor: 'Campanas escolares reales, gongs, carrillones Westminster y avisos cortos.',
  },
  {
    name: 'Wikimedia Commons (Audio)',
    url: 'https://commons.wikimedia.org/wiki/Category:Audio_files',
    license: 'Dominio público y Creative Commons · Enlaces directos OGG / MP3',
    bestFor: 'Música clásica histórica, himnos oficiales y grabaciones educativas libres.',
  },
  {
    name: 'Musopen',
    url: 'https://musopen.org/music/',
    license: 'Dominio público · Grabaciones orquestales MP3 / FLAC',
    bestFor: 'Piezas de Vivaldi, Mozart, Beethoven o Tchaikovsky para entradas relajadas.',
  },
  {
    name: 'Mixkit Free Music & SFX',
    url: 'https://mixkit.co/free-stock-music/',
    license: 'Licencia Mixkit gratuita sin registro · MP3 / WAV',
    bestFor: 'Cortinillas alegres, música ambiente de recreo y alertas limpias de megafonía.',
  },
  {
    name: 'Free Music Archive (FMA)',
    url: 'https://freemusicarchive.org/',
    license: 'Creative Commons filtrable por licencia · MP3 directo',
    bestFor: 'Repertorio independiente por géneros para semanas temáticas o proyectos.',
  },
  {
    name: 'Incompetech (Kevin MacLeod)',
    url: 'https://incompetech.com/music/royalty-free/music.html',
    license: 'CC-BY 4.0 (gratuita con mención escolar) · MP3 directo',
    bestFor: 'Piezas instrumentales alegres, música navideña y transiciones educativas.',
  },
];

interface HardwareAudioViewProps {
  state: BellAppState;
  playingToneId: string | null;
  onSaveHardware: (patch: Partial<HardwareConfig>) => Promise<void>;
  onSaveSecurity: (payload: {
    authEnabled: boolean;
    newPin?: string;
    currentPin?: string;
    lockReadOnlyPreview: boolean;
    hostnameMdns: string;
    webPort: number;
  }) => Promise<{ ok: boolean; error?: string }>;
  onPreviewTone: (tone: AudioTone) => void;
  onStopAudio: () => void;
  onUploadTone: (tone: {
    name: string;
    description: string;
    fileName: string;
    mimeType: string;
    dataUrl: string;
    durationSec: number;
  }) => Promise<void>;
  onImportToneFromUrl: (
    url: string,
    name?: string
  ) => Promise<{ ok: boolean; error?: string; toneName?: string }>;
  onDeleteTone: (id: string) => Promise<void>;
  onExportBackup: (backupName: string) => void;
  onImportBackup: (
    backup: BellBackupPayload,
    mode: BackupRestoreMode
  ) => Promise<{ ok: boolean; error?: string }>;
}

export function HardwareAudioView({
  state,
  playingToneId,
  onSaveHardware,
  onSaveSecurity,
  onPreviewTone,
  onStopAudio,
  onUploadTone,
  onImportToneFromUrl,
  onDeleteTone,
  onExportBackup,
  onImportBackup,
}: HardwareAudioViewProps) {
  const [form, setForm] = useState<HardwareConfig>(state.hardware);
  const [savedNotice, setSavedNotice] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [importUrl, setImportUrl] = useState('');
  const [importUrlName, setImportUrlName] = useState('');
  const [importingUrl, setImportingUrl] = useState(false);
  const [importUrlError, setImportUrlError] = useState<string | null>(null);
  const [importUrlSuccess, setImportUrlSuccess] = useState<string | null>(null);

  const [hostnameMdns, setHostnameMdns] = useState(state.security.hostnameMdns);
  const [webPort, setWebPort] = useState(state.security.webPort);
  const [authEnabled, setAuthEnabled] = useState(state.security.authEnabled);
  const [lockReadOnlyPreview, setLockReadOnlyPreview] = useState(state.security.lockReadOnlyPreview);
  const [newPin, setNewPin] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [secSaved, setSecSaved] = useState(false);
  const [secError, setSecError] = useState<string | null>(null);

  const [backupName, setBackupName] = useState('Horario Normal');
  const [pendingBackup, setPendingBackup] = useState<{
    fileName: string;
    payload: BellBackupPayload;
  } | null>(null);
  const [restoreMode, setRestoreMode] = useState<BackupRestoreMode>('schedules-and-audio');
  const [ackIncompatibilities, setAckIncompatibilities] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupSuccess, setBackupSuccess] = useState<string | null>(null);
  const [importingBackup, setImportingBackup] = useState(false);
  const backupFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setForm(state.hardware);
  }, [state.hardware]);

  useEffect(() => {
    setHostnameMdns(state.security.hostnameMdns);
    setWebPort(state.security.webPort);
    setAuthEnabled(state.security.authEnabled);
    setLockReadOnlyPreview(state.security.lockReadOnlyPreview);
  }, [state.security]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSaveHardware(form);
    setSavedNotice(true);
    window.setTimeout(() => setSavedNotice(false), 2500);
  };

  const handleSaveSecuritySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSecError(null);
    setSecSaved(false);
    const result = await onSaveSecurity({
      authEnabled,
      newPin: newPin.trim() || undefined,
      currentPin: currentPin.trim() || undefined,
      lockReadOnlyPreview,
      hostnameMdns,
      webPort,
    });
    if (!result.ok) {
      setSecError(result.error ?? 'No se pudo guardar la configuración de seguridad.');
      return;
    }
    setNewPin('');
    setCurrentPin('');
    setSecSaved(true);
    window.setTimeout(() => setSecSaved(false), 2500);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setUploadError(null);
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
      setUploadError('El archivo supera el límite recomendado de 10 MB.');
      return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      const cleanName = file.name.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ');
      await onUploadTone({
        name: cleanName,
        description: `Audio personalizado (${file.name})`,
        fileName: file.name,
        mimeType: file.type || 'audio/mpeg',
        dataUrl,
        durationSec: 5,
      });
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    reader.readAsDataURL(file);
  };

  const handleImportUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanUrl = importUrl.trim();
    if (!cleanUrl) return;
    setImportUrlError(null);
    setImportUrlSuccess(null);
    setImportingUrl(true);
    try {
      const result = await onImportToneFromUrl(cleanUrl, importUrlName.trim() || undefined);
      if (!result.ok) {
        setImportUrlError(result.error ?? 'No se pudo importar el audio desde esa URL.');
        return;
      }
      setImportUrl('');
      setImportUrlName('');
      setImportUrlSuccess(`Audio "${result.toneName ?? 'importado'}" añadido correctamente a la biblioteca.`);
    } finally {
      setImportingUrl(false);
    }
  };

  const handleBackupFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setBackupError(null);
    setBackupSuccess(null);
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 45 * 1024 * 1024) {
      setBackupError('El archivo JSON supera el límite permitido de 45 MB.');
      if (backupFileInputRef.current) backupFileInputRef.current.value = '';
      return;
    }

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Partial<BellBackupPayload>;
      if (
        !parsed ||
        parsed.format !== 'campana-os-backup' ||
        !Array.isArray(parsed.profiles) ||
        !Array.isArray(parsed.schedules) ||
        !Array.isArray(parsed.holidays) ||
        !Array.isArray(parsed.tones)
      ) {
        setBackupError('El archivo seleccionado no es un respaldo válido de CampanaOS.');
        setPendingBackup(null);
        return;
      }

      setPendingBackup({
        fileName: file.name,
        payload: parsed as BellBackupPayload,
      });
      setRestoreMode('schedules-and-audio');
      setAckIncompatibilities(false);
    } catch {
      setBackupError('No se pudo leer el archivo JSON. Verifica que no esté dañado.');
      setPendingBackup(null);
    } finally {
      if (backupFileInputRef.current) backupFileInputRef.current.value = '';
    }
  };

  const handleConfirmImportBackup = async () => {
    if (!pendingBackup) return;
    setBackupError(null);
    setBackupSuccess(null);
    setImportingBackup(true);
    try {
      const result = await onImportBackup(pendingBackup.payload, restoreMode);
      if (!result.ok) {
        setBackupError(result.error ?? 'No se pudo importar el archivo de respaldo.');
        return;
      }
      const importedLabel = pendingBackup.payload.backupName || pendingBackup.fileName;
      setPendingBackup(null);
      setAckIncompatibilities(false);
      setBackupSuccess(
        `Configuración "${importedLabel}" importada (${
          restoreMode === 'full' ? 'restauración completa' : 'horarios, festivos y audios'
        }).`
      );
    } finally {
      setImportingBackup(false);
    }
  };

  const customTonesCount = state.tones.filter((t) => t.category === 'custom').length;
  const previewCustomTones = pendingBackup
    ? pendingBackup.payload.tones.filter((t) => t.category === 'custom')
    : [];

  const compatibility = useMemo(() => {
    if (!pendingBackup) return null;
    return analyzeBackupCompatibility(
      pendingBackup.payload as unknown as Partial<BellBackupPayload> & Record<string, unknown>,
      state,
      restoreMode
    );
  }, [pendingBackup, state, restoreMode]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Audio Linux y Acceso en Red Local
        </h1>
        <p className="text-sm text-slate-500">
          Configura la salida de audio hacia el ecualizador o megafonía del centro y el acceso web seguro desde otros equipos.
        </p>
      </div>

      {/* Audio Output Configuration */}
      <form onSubmit={handleSave} className="bg-white rounded-xl border border-slate-200 p-6 space-y-6">
        <div className="flex items-center gap-2.5">
          <Speaker className="w-5 h-5 text-slate-700" />
          <h2 className="text-base font-semibold text-slate-900">Equipo anfitrión y salida de audio</h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label htmlFor="hw-school" className="block text-xs font-medium text-slate-700 mb-1">
              Nombre del centro educativo
            </label>
            <input
              id="hw-school"
              type="text"
              required
              value={form.schoolName}
              onChange={(e) => setForm({ ...form, schoolName: e.target.value })}
              className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
            />
          </div>

          <div>
            <label htmlFor="hw-user" className="block text-xs font-medium text-slate-700 mb-1">
              Usuario Linux del sistema
            </label>
            <input
              id="hw-user"
              type="text"
              required
              value={form.linuxUser}
              onChange={(e) => setForm({ ...form, linuxUser: e.target.value })}
              placeholder="pi o usuario"
              className="w-full h-10 px-3 rounded-lg border border-slate-300 font-mono text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
            />
          </div>

          <div>
            <label htmlFor="hw-backend" className="block text-xs font-medium text-slate-700 mb-1">
              Reproductor Linux
            </label>
            <select
              id="hw-backend"
              value={form.audioBackend}
              onChange={(e) => setForm({ ...form, audioBackend: e.target.value as AudioBackend })}
              className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-slate-900"
            >
              <option value="mpv">mpv (Recomendado)</option>
              <option value="aplay">aplay (ALSA directo WAV)</option>
              <option value="paplay">paplay (PulseAudio / PipeWire)</option>
              <option value="mpg123">mpg123 (MP3 ligero)</option>
            </select>
          </div>

          <div>
            <label htmlFor="hw-output" className="block text-xs font-medium text-slate-700 mb-1">
              Salida hacia ecualizador
            </label>
            <select
              id="hw-output"
              value={form.audioOutput}
              onChange={(e) => setForm({ ...form, audioOutput: e.target.value as AudioOutputDevice })}
              className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-slate-900"
            >
              <option value="default">Predeterminada del sistema</option>
              <option value="hw:0,0">Jack 3.5 mm / Línea (hw:0,0)</option>
              <option value="hdmi">Salida HDMI</option>
              <option value="usb-audio">Tarjeta de sonido USB</option>
            </select>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-1">
          <div className="flex-1 max-w-md">
            <div className="flex items-center justify-between text-xs font-medium text-slate-700 mb-1.5">
              <span>Volumen maestro de salida</span>
              <span className="font-mono tabular-nums text-slate-900">{form.masterVolume}%</span>
            </div>
            <input
              type="range"
              min={10}
              max={100}
              step={5}
              value={form.masterVolume}
              onChange={(e) => setForm({ ...form, masterVolume: Number(e.target.value) })}
              className="w-full accent-slate-900"
            />
          </div>

          <button
            type="submit"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {savedNotice ? <Check className="w-4 h-4 text-emerald-400" /> : null}
            {savedNotice ? 'Audio guardado' : 'Guardar configuración de audio'}
          </button>
        </div>
      </form>

      {/* LAN Administration & Security PIN Configuration */}
      <form onSubmit={handleSaveSecuritySubmit} className="bg-white rounded-xl border border-slate-200 p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-5 h-5 text-slate-700" />
            <div>
              <h2 className="text-base font-semibold text-slate-900">Acceso Web Local, Red Local (LAN) y PIN</h2>
              <p className="text-xs text-slate-500">
                Accede en el propio equipo o desde cualquier ordenador de Dirección/Conserjería sin instalar Node.js.
              </p>
            </div>
          </div>
          <span className="font-mono text-xs text-slate-600 whitespace-nowrap">
            http://{hostnameMdns || 'campana-escolar'}.local:{webPort}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label htmlFor="sec-mdns" className="block text-xs font-medium text-slate-700 mb-1">
              Nombre mDNS en red local
            </label>
            <input
              id="sec-mdns"
              type="text"
              required
              value={hostnameMdns}
              onChange={(e) => setHostnameMdns(e.target.value)}
              placeholder="campana-escolar"
              className="w-full h-10 px-3 rounded-lg border border-slate-300 font-mono text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
            />
          </div>

          <div>
            <label htmlFor="sec-port" className="block text-xs font-medium text-slate-700 mb-1">
              Puerto HTTP del panel web
            </label>
            <input
              id="sec-port"
              type="number"
              min={80}
              max={65535}
              required
              value={webPort}
              onChange={(e) => setWebPort(Number(e.target.value))}
              className="w-full h-10 px-3 rounded-lg border border-slate-300 font-mono text-sm tabular-nums text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
            />
          </div>

          <div>
            <label htmlFor="sec-new-pin" className="block text-xs font-medium text-slate-700 mb-1">
              {state.security.hasAdminPin ? 'Cambiar PIN / contraseña (opcional)' : 'Definir PIN / contraseña (mín. 4)'}
            </label>
            <input
              id="sec-new-pin"
              type="password"
              value={newPin}
              onChange={(e) => setNewPin(e.target.value)}
              placeholder={state.security.hasAdminPin ? 'Dejar vacío para mantener' : 'Ej: 4821'}
              className="w-full h-10 px-3 rounded-lg border border-slate-300 font-mono text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
            />
          </div>

          {state.security.hasAdminPin ? (
            <div>
              <label htmlFor="sec-cur-pin" className="block text-xs font-medium text-slate-700 mb-1">
                PIN actual (solo si lo cambias)
              </label>
              <input
                id="sec-cur-pin"
                type="password"
                value={currentPin}
                onChange={(e) => setCurrentPin(e.target.value)}
                placeholder="••••"
                className="w-full h-10 px-3 rounded-lg border border-slate-300 font-mono text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>
          ) : (
            <div className="flex items-end">
              <div className="text-xs text-slate-500 pb-2">Sin PIN definido todavía.</div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
          <label className="flex items-start gap-3 p-3.5 rounded-lg bg-slate-50 border border-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={authEnabled}
              onChange={(e) => setAuthEnabled(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-slate-900"
            />
            <div>
              <div className="text-sm font-medium text-slate-900">
                Exigir PIN o contraseña para cambios y toques manuales
              </div>
              <div className="text-xs text-slate-500">
                Impide editar horarios, cambiar perfiles, pulsar el timbre o descargar el paquete sin autenticación.
              </div>
            </div>
          </label>

          <label className="flex items-start gap-3 p-3.5 rounded-lg bg-slate-50 border border-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={lockReadOnlyPreview}
              disabled={!authEnabled}
              onChange={(e) => setLockReadOnlyPreview(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-slate-900 disabled:opacity-50"
            />
            <div>
              <div className="text-sm font-medium text-slate-900">
                Ocultar horarios y bloquear pantalla completa al entrar
              </div>
              <div className="text-xs text-slate-500">
                Si está desactivado, cualquier PC del centro puede consultar la hora del próximo toque en modo solo lectura.
              </div>
            </div>
          </label>
        </div>

        {secError && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs font-medium text-red-700">
            {secError}
          </div>
        )}

        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Lock className="w-3.5 h-3.5" />
            <span>
              {state.security.authEnabled
                ? 'Protección de administrador activa en red local'
                : 'Acceso abierto en red local (sin PIN)'}
            </span>
          </div>

          <button
            type="submit"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {secSaved ? <Check className="w-4 h-4 text-emerald-400" /> : null}
            {secSaved ? 'Seguridad guardada' : 'Guardar seguridad y red'}
          </button>
        </div>
      </form>

      {/* Audio Library & Upload */}
      <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Volume2 className="w-5 h-5 text-slate-700" />
            <div>
              <h2 className="text-base font-semibold text-slate-900">Biblioteca de tonos y melodías</h2>
              <p className="text-xs text-slate-500">
                Audiciona los timbres integrados o sube archivos MP3/WAV propios para reproducir por el ecualizador.
              </p>
            </div>
          </div>

          <div className="shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept=".mp3,.wav,.ogg,audio/*"
              onChange={handleFileChange}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Upload className="w-4 h-4" />
              Subir audio MP3 / WAV
            </button>
          </div>
        </div>

        {uploadError && (
          <div className="px-6 py-3 bg-red-50 border-b border-red-200 text-xs font-medium text-red-700">
            {uploadError}
          </div>
        )}

        {/* Direct URL or YouTube Importer (yt-dlp + ffmpeg) */}
        <form
          onSubmit={(e) => void handleImportUrlSubmit(e)}
          className="px-6 py-4 bg-slate-50/70 border-b border-slate-200 space-y-3"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Link2 className="w-4 h-4 text-slate-700 shrink-0" />
              <span className="text-xs font-semibold text-slate-900">
                Importar desde enlace de YouTube o URL directa de audio (yt-dlp + ffmpeg)
              </span>
            </div>
            <span className="text-xs text-slate-500 tabular-nums">
              Máx. 15 min · 20 MB · Conversión automática a MP3
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            <div className="md:col-span-6">
              <label htmlFor="import-audio-url" className="sr-only">
                Enlace de YouTube o archivo MP3/WAV/OGG
              </label>
              <input
                id="import-audio-url"
                type="url"
                required
                value={importUrl}
                onChange={(e) => setImportUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=... o https://.../melodia.mp3"
                className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>
            <div className="md:col-span-4">
              <label htmlFor="import-audio-name" className="sr-only">
                Nombre personalizado (opcional)
              </label>
              <input
                id="import-audio-name"
                type="text"
                value={importUrlName}
                onChange={(e) => setImportUrlName(e.target.value)}
                placeholder="Nombre en la biblioteca (opcional)"
                className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>
            <div className="md:col-span-2 flex">
              <button
                type="submit"
                disabled={importingUrl || !importUrl.trim()}
                className="w-full inline-flex items-center justify-center gap-2 px-4 h-10 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                {importingUrl ? 'Importando...' : 'Importar audio'}
              </button>
            </div>
          </div>

          <p className="text-xs text-slate-500">
            Usa preferiblemente audios con licencia libre, dominio público o grabaciones educativas del centro.
          </p>

          {importUrlError && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs font-medium text-red-700">
              {importUrlError}
            </div>
          )}

          {importUrlSuccess && (
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs font-medium text-emerald-800 flex items-center gap-2">
              <Check className="w-4 h-4 shrink-0" />
              <span>{importUrlSuccess}</span>
            </div>
          )}
        </form>

        <div className="divide-y divide-slate-100">
          {state.tones.map((tone) => {
            const isPlaying = playingToneId === tone.id;
            return (
              <div key={tone.id} className="px-6 py-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900 truncate">{tone.name}</span>
                    <span className="text-xs text-slate-400">·</span>
                    <span className="text-xs text-slate-500 whitespace-nowrap">
                      {tone.category === 'built-in' ? 'Integrado' : 'Personalizado'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5 truncate">{tone.description}</p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {isPlaying ? (
                    <button
                      type="button"
                      onClick={onStopAudio}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-medium hover:bg-amber-500 cursor-pointer"
                    >
                      <Square className="w-3.5 h-3.5 fill-current" />
                      Detener
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onPreviewTone(tone)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 text-xs font-medium hover:bg-slate-50 cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5" />
                      Escuchar
                    </button>
                  )}

                  {tone.category === 'custom' && (
                    <button
                      type="button"
                      onClick={() => void onDeleteTone(tone.id)}
                      title="Eliminar audio"
                      className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Curated Free & Royalty-Free Music Sources Directory */}
      <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-start gap-2.5">
          <Globe className="w-5 h-5 text-slate-700 mt-0.5 shrink-0" />
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Fuentes gratuitas de música y efectos libres de uso
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Catálogos legales y gratuitos para centros educativos. Descarga el MP3/WAV o copia la URL directa del audio en el importador superior.
            </p>
          </div>
        </div>

        <div className="divide-y divide-slate-100">
          {FREE_MUSIC_SOURCES.map((source) => (
            <div
              key={source.name}
              className="px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-sm font-semibold text-slate-900">{source.name}</span>
                  <span className="text-xs text-slate-400" aria-hidden="true">·</span>
                  <span className="text-xs text-slate-500">{source.license}</span>
                </div>
                <p className="text-xs text-slate-600 mt-0.5">{source.bestFor}</p>
              </div>

              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 self-start sm:self-auto"
              >
                <span>Abrir catálogo</span>
                <ExternalLink className="w-3.5 h-3.5 text-slate-500" />
              </a>
            </div>
          ))}
        </div>
      </section>

      {/* Seasonal JSON Backup & Restore */}
      <section className="bg-white rounded-xl border border-slate-200 p-6 space-y-6">
        <div className="flex items-start gap-2.5">
          <Archive className="w-5 h-5 text-slate-700 mt-0.5 shrink-0" />
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Copias de seguridad por época (JSON)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Exporta e importa la configuración completa (perfiles, toques, festivos y archivos de audio MP3/WAV incrustados) para alternar rápidamente entre Navidad, Horario Normal u otras épocas del curso.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Export Panel */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-5 flex flex-col justify-between gap-4">
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Exportar configuración actual</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Descarga un único archivo <span className="font-mono">.json</span> autocontenido sin incluir tu PIN actual.
                </p>
              </div>

              <div>
                <label htmlFor="backup-name" className="block text-xs font-medium text-slate-700 mb-1">
                  Nombre de la copia de seguridad
                </label>
                <input
                  id="backup-name"
                  type="text"
                  value={backupName}
                  onChange={(e) => setBackupName(e.target.value)}
                  placeholder="Ej: Navidad 2026"
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <span className="text-xs text-slate-500">Plantillas de nombre:</span>
                  {SEASONAL_NAME_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setBackupName(preset)}
                      className="px-2.5 py-1 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              <div className="text-xs text-slate-600 tabular-nums border-t border-slate-200 pt-3">
                Contenido actual:{' '}
                <span className="font-medium text-slate-900">{state.profiles.length}</span> perfiles ·{' '}
                <span className="font-medium text-slate-900">{state.schedules.length}</span> toques ·{' '}
                <span className="font-medium text-slate-900">{state.holidays.length}</span> festivos ·{' '}
                <span className="font-medium text-slate-900">{customTonesCount}</span> audios personalizados
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => onExportBackup(backupName)}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="w-4 h-4" />
                Exportar JSON completo
              </button>
            </div>
          </div>

          {/* Import Panel */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 flex flex-col justify-between gap-4">
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Importar copia de seguridad</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Selecciona un archivo <span className="font-mono">.json</span> exportado previamente para revisar su contenido antes de aplicarlo.
                </p>
              </div>

              <div>
                <input
                  ref={backupFileInputRef}
                  type="file"
                  accept=".json,application/json"
                  onChange={handleBackupFileSelected}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => backupFileInputRef.current?.click()}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-slate-300 bg-white text-sm font-medium text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <FileUp className="w-4 h-4" />
                  Seleccionar archivo .json
                </button>
              </div>

              {backupError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs font-medium text-red-700">
                  {backupError}
                </div>
              )}

              {backupSuccess && (
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs font-medium text-emerald-800 flex items-center gap-2">
                  <Check className="w-4 h-4 shrink-0" />
                  <span>{backupSuccess}</span>
                </div>
              )}

              {!pendingBackup && !backupError && !backupSuccess && (
                <p className="text-xs text-slate-500 border-t border-slate-100 pt-3">
                  Al elegir un archivo verás una vista previa con los toques, festivos y músicas antes de sobrescribir nada.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Inline Backup Preview, Schema Comparison & Restore Mode Selector */}
        {pendingBackup && compatibility && (
          <div className="rounded-xl border border-slate-300 bg-slate-50 p-5 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
              <div>
                <div className="text-xs font-medium text-slate-500">Vista previa del respaldo</div>
                <div className="text-base font-semibold text-slate-900 mt-0.5">
                  {pendingBackup.payload.backupName || pendingBackup.fileName}
                </div>
                <div className="text-xs text-slate-500 mt-0.5 tabular-nums">
                  Archivo: <span className="font-mono">{pendingBackup.fileName}</span> · Exportado:{' '}
                  {pendingBackup.payload.exportedAt
                    ? new Date(pendingBackup.payload.exportedAt).toLocaleString('es-ES')
                    : 'Fecha desconocida'}
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
                  setPendingBackup(null);
                  setAckIncompatibilities(false);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap shrink-0 self-start sm:self-auto cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
                Cancelar
              </button>
            </div>

            {/* Schema Version & Configuration Comparison */}
            <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 bg-slate-50/70">
                <span className="text-xs font-semibold text-slate-800">
                  Comparativa de esquema y configuración
                </span>
                <div className="inline-flex items-center gap-1.5 text-xs font-medium tabular-nums">
                  {compatibility.versionStatus === 'match' && (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      <span className="text-emerald-700">
                        Esquema v{compatibility.fileVersion} compatible con v{compatibility.currentVersion}
                      </span>
                    </>
                  )}
                  {(compatibility.versionStatus === 'older' || compatibility.versionStatus === 'missing') && (
                    <>
                      <AlertTriangle className="w-4 h-4 text-amber-600" />
                      <span className="text-amber-800">
                        {compatibility.fileVersion !== null
                          ? `Versión anterior (v${compatibility.fileVersion} vs actual v${compatibility.currentVersion})`
                          : `Versión no declarada (actual v${compatibility.currentVersion})`}
                      </span>
                    </>
                  )}
                  {compatibility.versionStatus === 'newer' && (
                    <>
                      <ShieldAlert className="w-4 h-4 text-red-600" />
                      <span className="text-red-700">
                        Versión más reciente (v{compatibility.fileVersion} &gt; actual v{compatibility.currentVersion})
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      <th className="py-2 px-4 font-medium">Elemento</th>
                      <th className="py-2 px-4 font-medium">Configuración actual</th>
                      <th className="py-2 px-4 font-medium">Archivo cargado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 tabular-nums">
                    <tr>
                      <td className="py-2 px-4 font-medium text-slate-700">Versión de esquema</td>
                      <td className="py-2 px-4 font-mono text-slate-900">
                        v{BACKUP_SCHEMA_VERSION}
                      </td>
                      <td
                        className={`py-2 px-4 font-mono font-semibold ${
                          compatibility.versionStatus === 'match'
                            ? 'text-emerald-700'
                            : compatibility.versionStatus === 'newer'
                            ? 'text-red-700'
                            : 'text-amber-700'
                        }`}
                      >
                        {compatibility.fileVersion !== null ? `v${compatibility.fileVersion}` : 'No indicada'}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 px-4 font-medium text-slate-700">Perfiles horarios</td>
                      <td className="py-2 px-4 text-slate-600">{state.profiles.length}</td>
                      <td className="py-2 px-4 font-medium text-slate-900">
                        {pendingBackup.payload.profiles.length}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 px-4 font-medium text-slate-700">Toques programados</td>
                      <td className="py-2 px-4 text-slate-600">{state.schedules.length}</td>
                      <td className="py-2 px-4 font-medium text-slate-900">
                        {pendingBackup.payload.schedules.length}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 px-4 font-medium text-slate-700">Festivos</td>
                      <td className="py-2 px-4 text-slate-600">{state.holidays.length}</td>
                      <td className="py-2 px-4 font-medium text-slate-900">
                        {pendingBackup.payload.holidays.length}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 px-4 font-medium text-slate-700">Audios personalizados</td>
                      <td className="py-2 px-4 text-slate-600">{customTonesCount}</td>
                      <td className="py-2 px-4 font-medium text-slate-900">
                        {previewCustomTones.length}
                      </td>
                    </tr>
                    {restoreMode === 'full' && (
                      <>
                        <tr>
                          <td className="py-2 px-4 font-medium text-slate-700">Salida de audio Linux</td>
                          <td className="py-2 px-4 font-mono text-slate-600">
                            {state.hardware.audioBackend} · {state.hardware.audioOutput}
                          </td>
                          <td className="py-2 px-4 font-mono font-medium text-slate-900">
                            {pendingBackup.payload.hardware
                              ? `${pendingBackup.payload.hardware.audioBackend ?? '—'} · ${pendingBackup.payload.hardware.audioOutput ?? '—'}`
                              : 'Sin datos (conserva actual)'}
                          </td>
                        </tr>
                        <tr>
                          <td className="py-2 px-4 font-medium text-slate-700">Dirección mDNS y puerto</td>
                          <td className="py-2 px-4 font-mono text-slate-600">
                            {state.security.hostnameMdns}.local:{state.security.webPort}
                          </td>
                          <td className="py-2 px-4 font-mono font-medium text-slate-900">
                            {pendingBackup.payload.security
                              ? `${pendingBackup.payload.security.hostnameMdns || state.security.hostnameMdns}.local:${pendingBackup.payload.security.webPort || state.security.webPort}`
                              : 'Sin datos (conserva actual)'}
                          </td>
                        </tr>
                      </>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Compatibility Warnings / Verification */}
            {compatibility.issues.length > 0 ? (
              <div className="space-y-2.5">
                <div className="text-xs font-semibold text-slate-800">
                  Comprobación de compatibilidad antes de importar
                </div>
                {compatibility.issues.map((issue) => {
                  const boxClass =
                    issue.severity === 'error'
                      ? 'bg-red-50 border-red-200 text-red-900'
                      : issue.severity === 'warning'
                      ? 'bg-amber-50 border-amber-200 text-amber-900'
                      : 'bg-white border-slate-200 text-slate-700';
                  return (
                    <div
                      key={issue.id}
                      className={`p-3.5 rounded-lg border flex items-start gap-2.5 text-xs ${boxClass}`}
                    >
                      {issue.severity === 'error' ? (
                        <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
                      ) : issue.severity === 'warning' ? (
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
                      ) : (
                        <Info className="w-4 h-4 shrink-0 mt-0.5 text-slate-500" />
                      )}
                      <div>
                        <div className="font-semibold">{issue.title}</div>
                        <div className="mt-0.5 opacity-90">{issue.detail}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-700" />
                <span>
                  Esquema v{compatibility.currentVersion} verificado sin advertencias ni incompatibilidades en perfiles, toques, festivos ni audios.
                </span>
              </div>
            )}

            {previewCustomTones.length > 0 && (
              <div className="bg-white rounded-lg border border-slate-200 p-4 space-y-2">
                <div className="text-xs font-semibold text-slate-700">
                  Melodías y audios personalizados incluidos
                </div>
                <div className="divide-y divide-slate-100">
                  {previewCustomTones.map((tone) => {
                    const hasAudioData = Boolean(tone.dataUrl && tone.dataUrl.includes(','));
                    return (
                      <div key={tone.id} className="py-1.5 flex items-center justify-between gap-4 text-xs">
                        <span className="font-medium text-slate-900 truncate">{tone.name}</span>
                        <span className="font-mono text-slate-500 truncate">
                          {tone.fileName}
                          {!hasAudioData ? ' · Sin datos Base64' : ''}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="space-y-2.5">
              <div className="text-xs font-semibold text-slate-800">Alcance de la importación</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="flex items-start gap-3 p-3.5 rounded-lg bg-white border border-slate-200 cursor-pointer">
                  <input
                    type="radio"
                    name="restoreMode"
                    value="schedules-and-audio"
                    checked={restoreMode === 'schedules-and-audio'}
                    onChange={() => setRestoreMode('schedules-and-audio')}
                    className="mt-0.5 accent-slate-900"
                  />
                  <div>
                    <div className="text-sm font-medium text-slate-900">
                      Solo horarios, festivos y audios (Recomendado)
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      Cambia toques, festivos y melodías; conserva la salida de audio del equipo, mDNS, puerto y PIN actual.
                    </div>
                  </div>
                </label>

                <label className="flex items-start gap-3 p-3.5 rounded-lg bg-white border border-slate-200 cursor-pointer">
                  <input
                    type="radio"
                    name="restoreMode"
                    value="full"
                    checked={restoreMode === 'full'}
                    onChange={() => setRestoreMode('full')}
                    className="mt-0.5 accent-slate-900"
                  />
                  <div>
                    <div className="text-sm font-medium text-slate-900">Restauración completa</div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      Restaura también centro, usuario Linux, salida de audio, mDNS y puerto web (mantiene tu PIN actual).
                    </div>
                  </div>
                </label>
              </div>
            </div>

            {compatibility.requiresAck && pendingBackup.payload.profiles.length > 0 && (
              <label className="flex items-start gap-2.5 p-3.5 rounded-lg bg-amber-50 border border-amber-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ackIncompatibilities}
                  onChange={(e) => setAckIncompatibilities(e.target.checked)}
                  className="mt-0.5 w-4 h-4 accent-slate-900"
                />
                <span className="text-xs font-medium text-amber-900">
                  Entiendo las advertencias de versión o compatibilidad anteriores y deseo aplicar la importación igualmente.
                </span>
              </label>
            )}

            <div className="flex items-center justify-end gap-3 pt-1">
              <button
                type="button"
                onClick={() => {
                  setPendingBackup(null);
                  setAckIncompatibilities(false);
                }}
                disabled={importingBackup}
                className="px-4 py-2 rounded-lg border border-slate-300 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmImportBackup()}
                disabled={
                  importingBackup ||
                  pendingBackup.payload.profiles.length === 0 ||
                  (compatibility.requiresAck && !ackIncompatibilities)
                }
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Check className="w-4 h-4" />
                {importingBackup ? 'Importando...' : 'Confirmar e importar respaldo'}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
