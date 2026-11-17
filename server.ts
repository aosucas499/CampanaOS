import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { build as buildVite, createServer as createViteServer } from 'vite';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
import type {
  AudioTone,
  BackupRestoreMode,
  BellAppState,
  BellBackupPayload,
  BellLogEntry,
  BellProfile,
  BellScheduleItem,
  HardwareConfig,
  HolidayException,
  SecurityNetworkConfig,
  SystemdSyncStatus,
} from './src/types/bell.ts';
import {
  generateInstallScript,
  generateReadme,
  generateRingServiceTemplate,
  generateScheduleJson,
  generateSingleTimerUnit,
  generateSudoersRule,
  generateSyncTimersPy,
  generateTimbreRunnerPy,
  generateWebPanelPy,
  generateWebServiceUnit,
  sanitizeUnitId,
} from './src/utils/linuxTemplates.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveServerPort(): number {
  const portFlagIdx = process.argv.indexOf('--port');
  if (portFlagIdx !== -1 && process.argv[portFlagIdx + 1]) {
    const cliPort = Number(process.argv[portFlagIdx + 1]);
    if (Number.isFinite(cliPort) && cliPort > 0) return cliPort;
  }
  const envPort = Number(process.env.PORT);
  const nginxPort = Number(process.env.NGINX_PORT);
  if (Number.isFinite(envPort) && envPort > 0 && envPort !== nginxPort) {
    return envPort;
  }
  const defaultAppPort = Number(process.env.DEFAULT_APP_PORT);
  if (Number.isFinite(defaultAppPort) && defaultAppPort > 0) {
    return defaultAppPort;
  }
  return 3000;
}

const PORT = resolveServerPort();
const DATA_DIR = path.join(__dirname, 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const STATE_FILE = path.join(DATA_DIR, 'school-bell.json');
const SECRETS_FILE = path.join(DATA_DIR, 'auth-secrets.json');
const DIST_DIR = path.join(__dirname, 'dist');
const OPT_SYNC_SCRIPT = '/opt/campana-os/sync_timers.py';
const OPT_SCHEDULE_FILE = '/opt/campana-os/schedule.json';
const OPT_RUNNER_SCRIPT = '/opt/campana-os/timbre_runner.py';
const SESSION_COOKIE_NAME = 'campana_session';

interface AuthSecrets {
  adminPinHash: string | null;
  adminPinSalt: string | null;
  sessionSecret: string;
}

function loadAuthSecrets(): AuthSecrets {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SECRETS_FILE)) {
    const initial: AuthSecrets = {
      adminPinHash: null,
      adminPinSalt: null,
      sessionSecret: crypto.randomBytes(32).toString('hex'),
    };
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(initial, null, 2), 'utf-8');
    return initial;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf-8')) as Partial<AuthSecrets>;
    return {
      adminPinHash: parsed.adminPinHash ?? null,
      adminPinSalt: parsed.adminPinSalt ?? null,
      sessionSecret: parsed.sessionSecret || crypto.randomBytes(32).toString('hex'),
    };
  } catch {
    return {
      adminPinHash: null,
      adminPinSalt: null,
      sessionSecret: crypto.randomBytes(32).toString('hex'),
    };
  }
}

function saveAuthSecrets(secrets: AuthSecrets) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2), 'utf-8');
}

function hashPin(pin: string, salt: string): string {
  return crypto.scryptSync(pin, salt, 64).toString('hex');
}

function verifyPin(pin: string, secrets: AuthSecrets): boolean {
  if (!secrets.adminPinHash || !secrets.adminPinSalt) return false;
  const candidate = Buffer.from(hashPin(pin, secrets.adminPinSalt), 'hex');
  const stored = Buffer.from(secrets.adminPinHash, 'hex');
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = decodeURIComponent(part.slice(idx + 1).trim());
    out[key] = val;
  }
  return out;
}

function signSessionToken(secret: string): string {
  const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 7;
  const payload = `${expiresAt}.${crypto.randomBytes(8).toString('hex')}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifySessionToken(token: string | undefined, secret: string): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [expiresStr, nonce, sig] = parts;
  const expiresAt = Number(expiresStr);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  const payload = `${expiresStr}.${nonce}`;
  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expectedSig, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function countActiveTimers(s: BellAppState): number {
  const activeProfile = s.profiles.find((p) => p.id === s.activeProfileId);
  if (activeProfile?.isSilent) return 0;
  return s.schedules.filter(
    (item) => item.enabled && item.profileId === s.activeProfileId && item.days.length > 0,
  ).length;
}

function createDefaultState(): BellAppState {
  const profiles: BellProfile[] = [
    {
      id: 'prof-normal',
      name: 'Horario Lectivo Normal',
      description: 'Jornada escolar ordinaria de lunes a viernes con 6 periodos y recreo de 30 min.',
      isSilent: false,
    },
    {
      id: 'prof-exams',
      name: 'Semana de Exámenes',
      description: 'Bloques de evaluación extendidos de 90 minutos sin timbre intermedio.',
      isSilent: false,
    },
    {
      id: 'prof-intensive',
      name: 'Jornada Intensiva (Jun/Sep)',
      description: 'Horario reducido de mañana de 08:30 a 13:30.',
      isSilent: false,
    },
    {
      id: 'prof-silent',
      name: 'Modo Silencio (Vacaciones)',
      description: 'Desactiva temporalmente todos los toques automáticos manteniendo el sistema activo.',
      isSilent: true,
    },
  ];

  const tones: AudioTone[] = [
    {
      id: 'classic-bell',
      name: 'Timbre Clásico Escolar',
      category: 'built-in',
      description: 'Timbre tradicional nítido para entradas y salidas de clase.',
      durationSec: 3.5,
      synthPreset: 'classic-bell',
    },
    {
      id: 'westminster',
      name: 'Carrillón Westminster',
      category: 'built-in',
      description: 'Secuencia armónica de 4 notas tubulares para inicio y fin de jornada.',
      durationSec: 6.5,
      synthPreset: 'westminster',
    },
    {
      id: 'soft-chime',
      name: 'Melodía Suave Inclusiva',
      category: 'built-in',
      description: 'Arpegio cálido de baja estridencia recomendado para aulas TEA.',
      durationSec: 3.0,
      synthPreset: 'soft-chime',
    },
    {
      id: 'recess-bell',
      name: 'Aviso Dual de Recreo',
      category: 'built-in',
      description: 'Doble campana armónica para inicio y fin de patio.',
      durationSec: 2.2,
      synthPreset: 'recess-bell',
    },
    {
      id: 'evacuation',
      name: 'Sirena de Evacuación',
      category: 'built-in',
      description: 'Señal acústica modulada reservada para simulacros y emergencias.',
      durationSec: 4.8,
      synthPreset: 'evacuation',
    },
  ];

  const schedules: BellScheduleItem[] = [
    { id: 'sch-1', profileId: 'prof-normal', time: '08:15', label: 'Entrada y 1ª Hora', days: [1, 2, 3, 4, 5], toneId: 'westminster', enabled: true },
    { id: 'sch-2', profileId: 'prof-normal', time: '09:15', label: 'Cambio a 2ª Hora', days: [1, 2, 3, 4, 5], toneId: 'soft-chime', enabled: true },
    { id: 'sch-3', profileId: 'prof-normal', time: '10:15', label: 'Cambio a 3ª Hora', days: [1, 2, 3, 4, 5], toneId: 'soft-chime', enabled: true },
    { id: 'sch-4', profileId: 'prof-normal', time: '11:15', label: 'Inicio de Recreo', days: [1, 2, 3, 4, 5], toneId: 'recess-bell', enabled: true },
    { id: 'sch-5', profileId: 'prof-normal', time: '11:45', label: 'Fin de Recreo y 4ª Hora', days: [1, 2, 3, 4, 5], toneId: 'classic-bell', enabled: true },
    { id: 'sch-6', profileId: 'prof-normal', time: '12:45', label: 'Cambio a 5ª Hora', days: [1, 2, 3, 4, 5], toneId: 'soft-chime', enabled: true },
    { id: 'sch-7', profileId: 'prof-normal', time: '13:45', label: 'Cambio a 6ª Hora', days: [1, 2, 3, 4, 5], toneId: 'soft-chime', enabled: true },
    { id: 'sch-8', profileId: 'prof-normal', time: '14:45', label: 'Salida General', days: [1, 2, 3, 4, 5], toneId: 'westminster', enabled: true },
    { id: 'sch-ex-1', profileId: 'prof-exams', time: '08:30', label: 'Inicio Bloque 1 Evaluación', days: [1, 2, 3, 4, 5], toneId: 'westminster', enabled: true },
    { id: 'sch-ex-2', profileId: 'prof-exams', time: '10:00', label: 'Fin Bloque 1 / Descanso', days: [1, 2, 3, 4, 5], toneId: 'recess-bell', enabled: true },
    { id: 'sch-ex-3', profileId: 'prof-exams', time: '10:30', label: 'Inicio Bloque 2 Evaluación', days: [1, 2, 3, 4, 5], toneId: 'westminster', enabled: true },
    { id: 'sch-ex-4', profileId: 'prof-exams', time: '12:00', label: 'Fin de Jornada de Exámenes', days: [1, 2, 3, 4, 5], toneId: 'classic-bell', enabled: true },
    { id: 'sch-int-1', profileId: 'prof-intensive', time: '08:30', label: 'Entrada Jornada Intensiva', days: [1, 2, 3, 4, 5], toneId: 'westminster', enabled: true },
    { id: 'sch-int-2', profileId: 'prof-intensive', time: '10:45', label: 'Recreo Jornada Intensiva', days: [1, 2, 3, 4, 5], toneId: 'recess-bell', enabled: true },
    { id: 'sch-int-3', profileId: 'prof-intensive', time: '11:15', label: 'Regreso de Recreo', days: [1, 2, 3, 4, 5], toneId: 'classic-bell', enabled: true },
    { id: 'sch-int-4', profileId: 'prof-intensive', time: '13:30', label: 'Salida Jornada Intensiva', days: [1, 2, 3, 4, 5], toneId: 'westminster', enabled: true },
  ];

  const holidays: HolidayException[] = [
    { id: 'hol-1', name: 'Día de la Constitución e Inmaculada', startDate: '2026-12-06', endDate: '2026-12-08' },
    { id: 'hol-2', name: 'Vacaciones de Navidad', startDate: '2026-12-23', endDate: '2027-01-07' },
    { id: 'hol-3', name: 'Día del Trabajo', startDate: '2027-05-01', endDate: '2027-05-01' },
  ];

  const hardware: HardwareConfig = {
    schoolName: 'I.E.S. Sierra Norte',
    linuxUser: 'pi',
    audioBackend: 'mpv',
    audioOutput: 'default',
    masterVolume: 85,
    timezone: 'Europe/Madrid',
  };

  const security: SecurityNetworkConfig = {
    authEnabled: false,
    hasAdminPin: false,
    lockReadOnlyPreview: false,
    hostnameMdns: 'campana-escolar',
    webPort: 3000,
  };

  const systemdSync: SystemdSyncStatus = {
    supported: fs.existsSync(OPT_SYNC_SCRIPT),
    lastSyncedAt: null,
    activeTimerCount: 8,
    lastMessage: fs.existsSync(OPT_SYNC_SCRIPT)
      ? 'Listo para sincronizar unidades systemd .timer.'
      : 'Vista previa: descarga el paquete .zip para instalar systemd .timer y el panel web Python en Linux.',
  };

  const logs: BellLogEntry[] = [
    {
      id: 'log-seed-1',
      timestamp: new Date(Date.now() - 3600 * 1000 * 3).toISOString(),
      timeDisplay: '08:15:00',
      label: 'Entrada y 1ª Hora',
      toneName: 'Carrillón Westminster',
      source: 'automatico',
      status: 'completado',
    },
    {
      id: 'log-seed-2',
      timestamp: new Date(Date.now() - 3600 * 1000 * 2).toISOString(),
      timeDisplay: '09:15:00',
      label: 'Cambio a 2ª Hora',
      toneName: 'Melodía Suave Inclusiva',
      source: 'automatico',
      status: 'completado',
    },
  ];

  return {
    activeProfileId: 'prof-normal',
    profiles,
    schedules,
    holidays,
    tones,
    hardware,
    security,
    systemdSync,
    authenticated: true,
    logs,
    serverTimeIso: new Date().toISOString(),
  };
}

function loadState(secrets: AuthSecrets): BellAppState {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const defaults = createDefaultState();
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(defaults, null, 2), 'utf-8');
    return defaults;
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<BellAppState>;
    const rawHw = (parsed.hardware ?? {}) as Partial<HardwareConfig>;
    const normalizedSchedules: BellScheduleItem[] = (parsed.schedules ?? defaults.schedules).map((s) => ({
      id: s.id,
      profileId: s.profileId,
      time: s.time,
      label: s.label,
      days: s.days,
      toneId: s.toneId,
      enabled: s.enabled,
    }));
    const normalizedLogs: BellLogEntry[] = (parsed.logs ?? defaults.logs).map((l) => ({
      id: l.id,
      timestamp: l.timestamp,
      timeDisplay: l.timeDisplay,
      label: l.label,
      toneName: l.toneName,
      source: l.source,
      status: l.status,
    }));

    const merged: BellAppState = {
      ...defaults,
      ...parsed,
      schedules: normalizedSchedules,
      logs: normalizedLogs,
      hardware: {
        schoolName: rawHw.schoolName ?? defaults.hardware.schoolName,
        linuxUser: rawHw.linuxUser ?? defaults.hardware.linuxUser,
        audioBackend: rawHw.audioBackend ?? defaults.hardware.audioBackend,
        audioOutput: rawHw.audioOutput ?? defaults.hardware.audioOutput,
        masterVolume: rawHw.masterVolume ?? defaults.hardware.masterVolume,
        timezone: rawHw.timezone ?? defaults.hardware.timezone,
      },
      security: {
        ...defaults.security,
        ...(parsed.security ?? {}),
        hasAdminPin: Boolean(secrets.adminPinHash),
      },
      systemdSync: {
        ...defaults.systemdSync,
        ...(parsed.systemdSync ?? {}),
        supported: fs.existsSync(OPT_SYNC_SCRIPT),
      },
      serverTimeIso: new Date().toISOString(),
    };
    merged.systemdSync.activeTimerCount = countActiveTimers(merged);
    return merged;
  } catch {
    fs.writeFileSync(STATE_FILE, JSON.stringify(defaults, null, 2), 'utf-8');
    return defaults;
  }
}

function saveState(s: BellAppState) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  s.systemdSync.activeTimerCount = countActiveTimers(s);
  const toPersist = { ...s, serverTimeIso: new Date().toISOString() };
  fs.writeFileSync(STATE_FILE, JSON.stringify(toPersist, null, 2), 'utf-8');
}

async function syncSystemdTimersIfInstalled(s: BellAppState): Promise<SystemdSyncStatus> {
  const count = countActiveTimers(s);
  const supported = fs.existsSync(OPT_SYNC_SCRIPT);
  if (!supported) {
    s.systemdSync = {
      supported: false,
      lastSyncedAt: s.systemdSync.lastSyncedAt,
      activeTimerCount: count,
      lastMessage: `Lista de ${count} unidades .timer preparada para exportar e instalar en Ubuntu/Raspberry Pi.`,
    };
    saveState(s);
    return s.systemdSync;
  }

  try {
    fs.writeFileSync(OPT_SCHEDULE_FILE, generateScheduleJson(s), 'utf-8');
  } catch {
    // Ignore if /opt/campana-os is not directly writable
  }

  return await new Promise((resolve) => {
    execFile('sudo', ['-n', '/usr/bin/python3', OPT_SYNC_SCRIPT], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        s.systemdSync = {
          supported: true,
          lastSyncedAt: s.systemdSync.lastSyncedAt,
          activeTimerCount: count,
          lastMessage: `Error al sincronizar systemd: ${stderr?.trim() || err.message}`,
        };
      } else {
        s.systemdSync = {
          supported: true,
          lastSyncedAt: new Date().toISOString(),
          activeTimerCount: count,
          lastMessage: stdout?.trim() || `${count} unidades systemd .timer sincronizadas.`,
        };
      }
      saveState(s);
      resolve(s.systemdSync);
    });
  });
}

function triggerHostAudioPlayback(tone: AudioTone, hardware: HardwareConfig) {
  if (fs.existsSync(OPT_RUNNER_SCRIPT)) {
    const child = spawn('/usr/bin/python3', [OPT_RUNNER_SCRIPT, '--tone-id', tone.id], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return;
  }

  // Fallback if running directly on a Linux PC with custom audio file
  if (tone.category === 'custom' && tone.fileName) {
    const localFile = path.join(AUDIO_DIR, path.basename(tone.fileName));
    if (fs.existsSync(localFile)) {
      const cmd = hardware.audioBackend === 'mpg123' ? 'mpg123' : 'mpv';
      const args = cmd === 'mpv' ? ['--no-video', `--volume=${hardware.masterVolume}`, localFile] : ['-q', localFile];
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => {
        // Ignore when running inside a headless cloud container without audio tools
      });
      child.unref();
    }
  }
}

function addDirectoryToZip(zipFolder: JSZip, dirPath: string) {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const sub = zipFolder.folder(entry.name);
      if (sub) addDirectoryToZip(sub, fullPath);
    } else if (entry.isFile()) {
      zipFolder.file(entry.name, fs.readFileSync(fullPath));
    }
  }
}

function getLocalIsoDateAndMinute(now: Date): { dateIso: string; hhmm: string; weekday: number; timeDisplay: string } {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const jsDay = now.getDay();
  const weekday = jsDay === 0 ? 7 : jsDay;
  return {
    dateIso: `${year}-${month}-${day}`,
    hhmm: `${hours}:${minutes}`,
    weekday,
    timeDisplay: `${hours}:${minutes}:${seconds}`,
  };
}

function isDateHoliday(dateIso: string, holidays: HolidayException[]): HolidayException | undefined {
  return holidays.find((h) => dateIso >= h.startDate && dateIso <= (h.endDate || h.startDate));
}

let secrets = loadAuthSecrets();
let state = loadState(secrets);
let lastCheckedMinuteKey = '';

// Preview heartbeat so the dashboard agenda & logs update live even when running outside systemd
setInterval(() => {
  const now = new Date();
  const { dateIso, hhmm, weekday, timeDisplay } = getLocalIsoDateAndMinute(now);
  const minuteKey = `${dateIso} ${hhmm}`;
  if (minuteKey === lastCheckedMinuteKey) return;
  lastCheckedMinuteKey = minuteKey;

  const activeProfile = state.profiles.find((p) => p.id === state.activeProfileId);
  const holiday = isDateHoliday(dateIso, state.holidays);

  const matching = state.schedules.filter(
    (item) =>
      item.enabled &&
      item.profileId === state.activeProfileId &&
      item.time === hhmm &&
      item.days.includes(weekday),
  );

  if (matching.length === 0) return;

  for (const item of matching) {
    const tone = state.tones.find((t) => t.id === item.toneId);

    let status: BellLogEntry['status'] = 'completado';
    if (activeProfile?.isSilent) {
      status = 'silenciado';
    } else if (holiday) {
      status = 'omitido-festivo';
    }

    const log: BellLogEntry = {
      id: `log-${crypto.randomUUID().slice(0, 8)}`,
      timestamp: now.toISOString(),
      timeDisplay,
      label: holiday ? `${item.label} (${holiday.name})` : item.label,
      toneName: tone?.name ?? 'Timbre estándar',
      source: 'automatico',
      status,
    };

    state.logs = [log, ...state.logs].slice(0, 120);
  }
  saveState(state);
}, 1000);

function isRequestAuthenticated(req: Request): boolean {
  if (!state.security.authEnabled || !secrets.adminPinHash) return true;
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionToken(cookies[SESSION_COOKIE_NAME], secrets.sessionSecret);
}

function buildClientState(authenticated: boolean): BellAppState {
  if (state.security.authEnabled && state.security.lockReadOnlyPreview && !authenticated) {
    return {
      activeProfileId: state.activeProfileId,
      profiles: [],
      schedules: [],
      holidays: [],
      tones: [],
      hardware: {
        ...state.hardware,
        linuxUser: '***',
      },
      security: {
        ...state.security,
        hasAdminPin: Boolean(secrets.adminPinHash),
      },
      systemdSync: {
        supported: state.systemdSync.supported,
        lastSyncedAt: null,
        activeTimerCount: 0,
        lastMessage: 'Panel bloqueado. Inicia sesión como administrador.',
      },
      authenticated: false,
      locked: true,
      logs: [],
      serverTimeIso: new Date().toISOString(),
    };
  }

  return {
    ...state,
    security: {
      ...state.security,
      hasAdminPin: Boolean(secrets.adminPinHash),
    },
    authenticated,
    locked: false,
    serverTimeIso: new Date().toISOString(),
  };
}

function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  if (isRequestAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: 'Se requiere PIN o contraseña de administrador para realizar esta acción.' });
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  app.get('/api/state', (req, res) => {
    const auth = isRequestAuthenticated(req);
    res.json(buildClientState(auth));
  });

  app.post('/api/auth/login', (req, res) => {
    const { pin } = req.body as { pin?: string };
    if (!state.security.authEnabled || !secrets.adminPinHash) {
      res.json({ authenticated: true, state: buildClientState(true) });
      return;
    }
    if (!pin || !verifyPin(pin, secrets)) {
      res.status(401).json({ error: 'PIN o contraseña incorrectos.' });
      return;
    }
    const token = signSessionToken(secrets.sessionSecret);
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`,
    );
    res.json({ authenticated: true, state: buildClientState(true) });
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
    );
    res.json({ authenticated: !state.security.authEnabled, state: buildClientState(!state.security.authEnabled) });
  });

  app.put('/api/security', requireAdminAuth, (req, res) => {
    const {
      authEnabled,
      newPin,
      currentPin,
      lockReadOnlyPreview,
      hostnameMdns,
      webPort,
    } = req.body as {
      authEnabled?: boolean;
      newPin?: string;
      currentPin?: string;
      lockReadOnlyPreview?: boolean;
      hostnameMdns?: string;
      webPort?: number;
    };

    if (newPin !== undefined && newPin.trim().length > 0) {
      if (newPin.trim().length < 4) {
        res.status(400).json({ error: 'El PIN o contraseña debe tener al menos 4 caracteres.' });
        return;
      }
      if (secrets.adminPinHash && currentPin !== undefined && currentPin.length > 0 && !verifyPin(currentPin, secrets)) {
        res.status(403).json({ error: 'La contraseña actual no coincide.' });
        return;
      }
      const salt = crypto.randomBytes(16).toString('hex');
      secrets.adminPinSalt = salt;
      secrets.adminPinHash = hashPin(newPin.trim(), salt);
      saveAuthSecrets(secrets);
    }

    if (authEnabled && !secrets.adminPinHash) {
      res.status(400).json({ error: 'Debes definir un PIN o contraseña de administrador antes de activar el bloqueo.' });
      return;
    }

    const sanitizedHost = (hostnameMdns ?? state.security.hostnameMdns)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '') || 'campana-escolar';

    const parsedPort = Number(webPort);
    const validPort = Number.isInteger(parsedPort) && parsedPort >= 80 && parsedPort <= 65535
      ? parsedPort
      : state.security.webPort;

    state.security = {
      authEnabled: authEnabled !== undefined ? Boolean(authEnabled) : state.security.authEnabled,
      hasAdminPin: Boolean(secrets.adminPinHash),
      lockReadOnlyPreview:
        lockReadOnlyPreview !== undefined ? Boolean(lockReadOnlyPreview) : state.security.lockReadOnlyPreview,
      hostnameMdns: sanitizedHost,
      webPort: validPort,
    };

    saveState(state);

    if (state.security.authEnabled) {
      const token = signSessionToken(secrets.sessionSecret);
      res.setHeader(
        'Set-Cookie',
        `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`,
      );
    }

    res.json({ security: state.security, state: buildClientState(true) });
  });

  app.put('/api/active-profile', requireAdminAuth, async (req, res) => {
    const { profileId } = req.body as { profileId?: string };
    if (!profileId || !state.profiles.some((p) => p.id === profileId)) {
      res.status(400).json({ error: 'Perfil no válido' });
      return;
    }
    state.activeProfileId = profileId;
    saveState(state);
    await syncSystemdTimersIfInstalled(state);
    res.json(buildClientState(true));
  });

  app.post('/api/profiles', requireAdminAuth, (req, res) => {
    const { name, description, isSilent } = req.body as Partial<BellProfile>;
    if (!name || !name.trim()) {
      res.status(400).json({ error: 'El nombre del perfil es obligatorio' });
      return;
    }
    const created: BellProfile = {
      id: `prof-${crypto.randomUUID().slice(0, 8)}`,
      name: name.trim(),
      description: (description ?? '').trim() || 'Perfil horario personalizado.',
      isSilent: Boolean(isSilent),
    };
    state.profiles.push(created);
    saveState(state);
    res.status(201).json({ profile: created, state: buildClientState(true) });
  });

  app.post('/api/schedules', requireAdminAuth, async (req, res) => {
    const body = req.body as Partial<BellScheduleItem>;
    if (!body.time || !/^\d{2}:\d{2}$/.test(body.time) || !body.label?.trim()) {
      res.status(400).json({ error: 'Hora (HH:MM) y etiqueta son obligatorios' });
      return;
    }
    const created: BellScheduleItem = {
      id: `sch-${crypto.randomUUID().slice(0, 8)}`,
      profileId: body.profileId || state.activeProfileId,
      time: body.time,
      label: body.label.trim(),
      days: Array.isArray(body.days) && body.days.length > 0 ? body.days : [1, 2, 3, 4, 5],
      toneId: body.toneId || 'classic-bell',
      enabled: body.enabled !== undefined ? Boolean(body.enabled) : true,
    };
    state.schedules.push(created);
    state.schedules.sort((a, b) => a.time.localeCompare(b.time));
    saveState(state);
    await syncSystemdTimersIfInstalled(state);
    res.status(201).json({ schedule: created, state: buildClientState(true) });
  });

  app.put('/api/schedules/:id', requireAdminAuth, async (req, res) => {
    const { id } = req.params;
    const idx = state.schedules.findIndex((s) => s.id === id);
    if (idx === -1) {
      res.status(404).json({ error: 'Toque programado no encontrado' });
      return;
    }
    const patch = req.body as Partial<BellScheduleItem>;
    state.schedules[idx] = {
      ...state.schedules[idx],
      ...patch,
      id,
    };
    state.schedules.sort((a, b) => a.time.localeCompare(b.time));
    saveState(state);
    await syncSystemdTimersIfInstalled(state);
    res.json({ schedule: state.schedules[idx], state: buildClientState(true) });
  });

  app.delete('/api/schedules/:id', requireAdminAuth, async (req, res) => {
    const { id } = req.params;
    state.schedules = state.schedules.filter((s) => s.id !== id);
    saveState(state);
    await syncSystemdTimersIfInstalled(state);
    res.json({ state: buildClientState(true) });
  });

  app.post('/api/holidays', requireAdminAuth, async (req, res) => {
    const { name, startDate, endDate } = req.body as Partial<HolidayException>;
    if (!name?.trim() || !startDate) {
      res.status(400).json({ error: 'Nombre y fecha de inicio son obligatorios' });
      return;
    }
    const created: HolidayException = {
      id: `hol-${crypto.randomUUID().slice(0, 8)}`,
      name: name.trim(),
      startDate,
      endDate: endDate && endDate >= startDate ? endDate : startDate,
    };
    state.holidays.push(created);
    state.holidays.sort((a, b) => a.startDate.localeCompare(b.startDate));
    saveState(state);
    await syncSystemdTimersIfInstalled(state);
    res.status(201).json({ holiday: created, state: buildClientState(true) });
  });

  app.delete('/api/holidays/:id', requireAdminAuth, async (req, res) => {
    const { id } = req.params;
    state.holidays = state.holidays.filter((h) => h.id !== id);
    saveState(state);
    await syncSystemdTimersIfInstalled(state);
    res.json({ state: buildClientState(true) });
  });

  app.put('/api/hardware', requireAdminAuth, async (req, res) => {
    const patch = req.body as Partial<HardwareConfig>;
    state.hardware = {
      ...state.hardware,
      ...patch,
    };
    saveState(state);
    await syncSystemdTimersIfInstalled(state);
    res.json({ hardware: state.hardware, state: buildClientState(true) });
  });

  app.post('/api/tones', requireAdminAuth, (req, res) => {
    const { name, description, fileName, mimeType, dataUrl, durationSec } = req.body as Partial<AudioTone>;
    if (!name?.trim() || !dataUrl) {
      res.status(400).json({ error: 'Nombre y archivo de audio son obligatorios' });
      return;
    }
    const safeFileName = path.basename(fileName || `${Date.now()}.mp3`);
    const base64Part = dataUrl.split(',')[1];
    if (base64Part) {
      fs.mkdirSync(AUDIO_DIR, { recursive: true });
      fs.writeFileSync(path.join(AUDIO_DIR, safeFileName), Buffer.from(base64Part, 'base64'));
    }

    const created: AudioTone = {
      id: `custom-${crypto.randomUUID().slice(0, 8)}`,
      name: name.trim(),
      category: 'custom',
      description: (description ?? '').trim() || 'Archivo de audio personalizado.',
      durationSec: Number(durationSec) || 5,
      fileName: safeFileName,
      mimeType: mimeType || 'audio/mpeg',
      dataUrl,
    };
    state.tones.push(created);
    saveState(state);
    res.status(201).json({ tone: created, state: buildClientState(true) });
  });

  app.post('/api/tones/import-url', requireAdminAuth, async (req, res) => {
    const { url: rawUrl, name: rawName } = req.body as { url?: string; name?: string };
    const trimmedUrl = String(rawUrl ?? '').trim();
    const customName = String(rawName ?? '').trim();

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmedUrl);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('Protocolo no admitido');
      }
    } catch {
      res.status(400).json({ error: 'Introduce una URL válida que empiece por http:// o https://' });
      return;
    }

    const slugify = (v: string) =>
      v
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || `audio-${crypto.randomUUID().slice(0, 6)}`;

    fs.mkdirSync(AUDIO_DIR, { recursive: true });

    const isDirectAudio = /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(decodeURIComponent(parsedUrl.pathname));

    if (isDirectAudio) {
      try {
        const resp = await fetch(trimmedUrl, {
          headers: { 'User-Agent': 'CampanaOS/1.0' },
          redirect: 'follow',
          signal: AbortSignal.timeout(45000),
        });
        if (!resp.ok) {
          res.status(400).json({ error: `No se pudo descargar el enlace (HTTP ${resp.status}).` });
          return;
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length === 0) {
          res.status(400).json({ error: 'El enlace devolvió un archivo vacío.' });
          return;
        }
        if (buf.length > 20 * 1024 * 1024) {
          res.status(400).json({ error: 'El archivo de audio supera el límite permitido de 20 MB.' });
          return;
        }

        const origBase = path.basename(decodeURIComponent(parsedUrl.pathname)) || 'audio.mp3';
        const ext = path.extname(origBase).toLowerCase() || '.mp3';
        const stem =
          customName ||
          path.basename(origBase, ext).replace(/[_-]+/g, ' ').trim() ||
          'Audio importado';
        const safeFileName = `${slugify(stem)}-${crypto.randomUUID().slice(0, 6)}${ext}`;
        fs.writeFileSync(path.join(AUDIO_DIR, safeFileName), buf);

        const mimeType =
          resp.headers.get('content-type')?.split(';')[0].trim() ||
          (ext === '.wav' ? 'audio/wav' : ext === '.ogg' ? 'audio/ogg' : 'audio/mpeg');
        const dataUrl =
          buf.length <= 15 * 1024 * 1024
            ? `data:${mimeType};base64,${buf.toString('base64')}`
            : undefined;

        const created: AudioTone = {
          id: `custom-${crypto.randomUUID().slice(0, 8)}`,
          name: stem.slice(0, 80),
          category: 'custom',
          description: `Importado desde enlace directo (${parsedUrl.hostname})`,
          durationSec: 5,
          fileName: safeFileName,
          mimeType,
          dataUrl,
        };
        state.tones.push(created);
        saveState(state);
        res.status(201).json({ tone: created, state: buildClientState(true) });
        return;
      } catch (err) {
        res.status(500).json({
          error: `Error al descargar el audio directo: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    }

    // YouTube or web media page -> yt-dlp + ffmpeg
    const localYtDlp = path.join(DATA_DIR, 'bin', 'yt-dlp');
    let ytDlpBin: string | null = null;
    for (const candidate of ['/usr/local/bin/yt-dlp', localYtDlp]) {
      if (fs.existsSync(candidate)) {
        ytDlpBin = candidate;
        break;
      }
    }
    if (!ytDlpBin) {
      try {
        const { stdout } = await execFileAsync('which', ['yt-dlp']);
        if (stdout.trim()) ytDlpBin = stdout.trim();
      } catch {
        // Not on PATH yet
      }
    }
    if (!ytDlpBin) {
      try {
        const dl = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp', {
          redirect: 'follow',
          signal: AbortSignal.timeout(30000),
        });
        if (dl.ok) {
          fs.mkdirSync(path.dirname(localYtDlp), { recursive: true });
          fs.writeFileSync(localYtDlp, Buffer.from(await dl.arrayBuffer()));
          fs.chmodSync(localYtDlp, 0o755);
          ytDlpBin = localYtDlp;
        }
      } catch {
        // Ignore download failure; handled below
      }
    }

    if (!ytDlpBin) {
      res.status(400).json({
        error:
          'No se encontró yt-dlp en este servidor. En Ubuntu/Raspberry Pi el instalador install.sh lo configura automáticamente.',
      });
      return;
    }

    try {
      await execFileAsync('which', ['ffmpeg']);
    } catch {
      res.status(400).json({
        error: 'No se encontró ffmpeg en el sistema para convertir el vídeo a MP3.',
      });
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campana-yt-'));
    try {
      const outTpl = path.join(tmpDir, '%(id)s.%(ext)s');
      const { stdout } = await execFileAsync(
        ytDlpBin,
        [
          '--no-playlist',
          '--no-warnings',
          '--match-filter',
          'duration <= 900',
          '--max-filesize',
          '25M',
          '--extract-audio',
          '--audio-format',
          'mp3',
          '--audio-quality',
          '192K',
          '--print-json',
          '-o',
          outTpl,
          '--',
          trimmedUrl,
        ],
        { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }
      );

      let meta: { title?: string; duration?: number } = {};
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{')) {
          try {
            meta = JSON.parse(trimmed) as { title?: string; duration?: number };
          } catch {
            // Ignore non-JSON lines
          }
        }
      }

      const files = fs.readdirSync(tmpDir).filter((f) => f.toLowerCase().endsWith('.mp3'));
      if (files.length === 0) {
        res.status(400).json({
          error:
            'yt-dlp no generó ningún archivo MP3 (comprueba que el vídeo dure menos de 15 minutos y no sea privado).',
        });
        return;
      }

      const srcMp3 = path.join(tmpDir, files[0]);
      const mp3Buf = fs.readFileSync(srcMp3);
      const rawTitle = customName || meta.title || path.basename(files[0], '.mp3');
      const safeFileName = `${slugify(rawTitle)}-${crypto.randomUUID().slice(0, 6)}.mp3`;
      fs.writeFileSync(path.join(AUDIO_DIR, safeFileName), mp3Buf);

      const dataUrl =
        mp3Buf.length <= 15 * 1024 * 1024
          ? `data:audio/mpeg;base64,${mp3Buf.toString('base64')}`
          : undefined;

      const created: AudioTone = {
        id: `custom-${crypto.randomUUID().slice(0, 8)}`,
        name: rawTitle.slice(0, 80),
        category: 'custom',
        description: `Audio extraído con yt-dlp (${parsedUrl.hostname})`,
        durationSec: Math.max(1, Math.round(Number(meta.duration) || 10)),
        fileName: safeFileName,
        mimeType: 'audio/mpeg',
        dataUrl,
      };
      state.tones.push(created);
      saveState(state);
      res.status(201).json({ tone: created, state: buildClientState(true) });
    } catch (err: unknown) {
      const stderr =
        err && typeof err === 'object' && 'stderr' in err
          ? String((err as { stderr?: string }).stderr ?? '')
          : '';
      const lastLine = stderr.trim().split('\n').pop() || (err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: `Error al extraer audio con yt-dlp: ${lastLine}` });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  app.delete('/api/tones/:id', requireAdminAuth, (req, res) => {
    const { id } = req.params;
    const tone = state.tones.find((t) => t.id === id);
    if (!tone || tone.category === 'built-in') {
      res.status(400).json({ error: 'No se pueden eliminar los tonos integrados del sistema' });
      return;
    }
    if (tone.fileName) {
      const target = path.join(AUDIO_DIR, path.basename(tone.fileName));
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
    state.tones = state.tones.filter((t) => t.id !== id);
    state.schedules = state.schedules.map((s) => (s.toneId === id ? { ...s, toneId: 'classic-bell' } : s));
    saveState(state);
    res.json({ state: buildClientState(true) });
  });

  app.post('/api/ring-now', requireAdminAuth, (req, res) => {
    const { toneId, label, source } = req.body as {
      toneId?: string;
      label?: string;
      source?: 'manual' | 'emergencia';
    };
    const now = new Date();
    const { timeDisplay } = getLocalIsoDateAndMinute(now);
    const tone = state.tones.find((t) => t.id === (toneId || 'classic-bell')) ?? state.tones[0];

    triggerHostAudioPlayback(tone, state.hardware);

    const log: BellLogEntry = {
      id: `log-${crypto.randomUUID().slice(0, 8)}`,
      timestamp: now.toISOString(),
      timeDisplay,
      label: label || (source === 'emergencia' ? 'Alerta de Evacuación Manual' : 'Toque Manual de Prueba'),
      toneName: tone.name,
      source: source || 'manual',
      status: 'completado',
    };

    state.logs = [log, ...state.logs].slice(0, 120);
    saveState(state);
    res.json({ log, tone, state: buildClientState(true) });
  });

  app.delete('/api/logs', requireAdminAuth, (_req, res) => {
    state.logs = [];
    saveState(state);
    res.json({ state: buildClientState(true) });
  });

  app.post('/api/systemd/sync', requireAdminAuth, async (_req, res) => {
    const syncResult = await syncSystemdTimersIfInstalled(state);
    res.json({ systemdSync: syncResult, state: buildClientState(true) });
  });

  app.get('/audio/:filename', (req, res) => {
    const safeName = path.basename(req.params.filename || '');
    const target = path.join(AUDIO_DIR, safeName);
    if (!safeName || !fs.existsSync(target)) {
      res.status(404).json({ error: 'Archivo de audio no encontrado' });
      return;
    }
    res.sendFile(target);
  });

  app.get('/api/backup/export', requireAdminAuth, (req, res) => {
    const rawName = String(req.query.name || 'respaldo-campana-os').trim();
    const safeSlug =
      rawName
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'respaldo-campana-os';

    const exportedTones: AudioTone[] = state.tones.map((tone) => {
      if (tone.category === 'custom' && !tone.dataUrl && tone.fileName) {
        const diskPath = path.join(AUDIO_DIR, path.basename(tone.fileName));
        if (fs.existsSync(diskPath)) {
          const b64 = fs.readFileSync(diskPath).toString('base64');
          const mime = tone.mimeType || 'audio/mpeg';
          return { ...tone, dataUrl: `data:${mime};base64,${b64}` };
        }
      }
      return { ...tone };
    });

    const payload: BellBackupPayload = {
      format: 'campana-os-backup',
      version: 1,
      backupName: rawName || 'Respaldo CampanaOS',
      exportedAt: new Date().toISOString(),
      activeProfileId: state.activeProfileId,
      profiles: state.profiles,
      schedules: state.schedules,
      holidays: state.holidays,
      tones: exportedTones,
      hardware: state.hardware,
      security: {
        authEnabled: state.security.authEnabled,
        lockReadOnlyPreview: state.security.lockReadOnlyPreview,
        hostnameMdns: state.security.hostnameMdns,
        webPort: state.security.webPort,
      },
    };

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeSlug}.json"`);
    res.send(JSON.stringify(payload, null, 2));
  });

  app.post('/api/backup/import', requireAdminAuth, async (req, res) => {
    const { backup, mode } = req.body as {
      backup?: Partial<BellBackupPayload>;
      mode?: BackupRestoreMode;
    };

    if (!backup || backup.format !== 'campana-os-backup' || !Array.isArray(backup.profiles) || backup.profiles.length === 0) {
      res.status(400).json({ error: 'El archivo seleccionado no es un respaldo válido de CampanaOS.' });
      return;
    }

    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    const restoredTones: AudioTone[] = Array.isArray(backup.tones)
      ? backup.tones.map((tone) => {
          if (tone.category === 'custom' && tone.dataUrl) {
            const safeName = path.basename(tone.fileName || `${tone.id || Date.now()}.mp3`);
            const b64Part = tone.dataUrl.split(',')[1];
            if (b64Part) {
              fs.writeFileSync(path.join(AUDIO_DIR, safeName), Buffer.from(b64Part, 'base64'));
            }
            return { ...tone, fileName: safeName };
          }
          return { ...tone };
        })
      : state.tones;

    state.profiles = backup.profiles;
    state.activeProfileId = backup.profiles.some((p) => p.id === backup.activeProfileId)
      ? (backup.activeProfileId as string)
      : backup.profiles[0].id;
    state.schedules = Array.isArray(backup.schedules)
      ? backup.schedules
          .map((s) => ({
            id: s.id,
            profileId: s.profileId,
            time: s.time,
            label: s.label,
            days: Array.isArray(s.days) ? s.days : [1, 2, 3, 4, 5],
            toneId: s.toneId || 'classic-bell',
            enabled: s.enabled !== undefined ? Boolean(s.enabled) : true,
          }))
          .sort((a, b) => a.time.localeCompare(b.time))
      : [];
    state.holidays = Array.isArray(backup.holidays)
      ? [...backup.holidays].sort((a, b) => a.startDate.localeCompare(b.startDate))
      : [];
    if (restoredTones.length > 0) {
      state.tones = restoredTones;
    }

    if (mode === 'full') {
      if (backup.hardware) {
        state.hardware = {
          ...state.hardware,
          ...backup.hardware,
        };
      }
      if (backup.security) {
        state.security = {
          ...state.security,
          hostnameMdns: backup.security.hostnameMdns || state.security.hostnameMdns,
          webPort: Number(backup.security.webPort) || state.security.webPort,
          lockReadOnlyPreview: Boolean(backup.security.lockReadOnlyPreview),
        };
      }
    }

    saveState(state);
    await syncSystemdTimersIfInstalled(state);
    res.json({ state: buildClientState(true) });
  });

  app.get('/api/export/bundle', requireAdminAuth, async (_req, res) => {
    try {
      // Ensure compiled static frontend exists in dist/ so Python web_panel.py can serve it directly
      if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
        await buildVite({ logLevel: 'silent' });
      }

      const zip = new JSZip();
      zip.file('schedule.json', generateScheduleJson(state));
      zip.file('timbre_runner.py', generateTimbreRunnerPy(state));
      zip.file('sync_timers.py', generateSyncTimersPy());
      zip.file('web_panel.py', generateWebPanelPy());
      zip.file('campana-ring@.service', generateRingServiceTemplate(state));
      zip.file('campana-web.service', generateWebServiceUnit(state));
      zip.file('campana-os.sudoers', generateSudoersRule(state));
      zip.file('install.sh', generateInstallScript(state));
      zip.file('README.md', generateReadme(state));

      const webappFolder = zip.folder('webapp');
      if (webappFolder) {
        addDirectoryToZip(webappFolder, DIST_DIR);
      }

      const timersFolder = zip.folder('timers');
      const activeProfile = state.profiles.find((p) => p.id === state.activeProfileId);
      if (timersFolder && !activeProfile?.isSilent) {
        for (const item of state.schedules) {
          if (item.enabled && item.profileId === state.activeProfileId && item.days.length > 0) {
            const filename = `campana-ring-${sanitizeUnitId(item.id)}.timer`;
            timersFolder.file(filename, generateSingleTimerUnit(item));
          }
        }
      }

      const audioFolder = zip.folder('audio');
      if (audioFolder) {
        for (const tone of state.tones) {
          if (tone.category === 'custom' && tone.dataUrl && tone.fileName) {
            const base64Part = tone.dataUrl.split(',')[1];
            if (base64Part) {
              audioFolder.file(path.basename(tone.fileName), Buffer.from(base64Part, 'base64'));
            }
          }
        }
      }

      const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="campana-os-linux-rpi.zip"');
      res.send(buffer);
    } catch (error) {
      res.status(500).json({ error: `No se pudo generar el paquete: ${String(error)}` });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ...(hmrDisabled ? { hmr: false, ws: false } : {}),
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(DIST_DIR));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`CampanaOS servidor escuchando en http://0.0.0.0:${PORT}`);
  });
  server.on('error', (err) => {
    console.error(`Error al iniciar el servidor HTTP en puerto ${PORT}:`, err);
    process.exit(1);
  });
}

startServer().catch((err) => {
  console.error('Error fatal al iniciar CampanaOS:', err);
  process.exit(1);
});
