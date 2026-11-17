import {
  BACKUP_SCHEMA_VERSION,
  type AudioBackend,
  type AudioOutputDevice,
  type BackupRestoreMode,
  type BellAppState,
  type BellBackupPayload,
} from '../types/bell.ts';

export type SchemaVersionStatus = 'match' | 'older' | 'newer' | 'missing';

export interface BackupCompatibilityIssue {
  id: string;
  severity: 'error' | 'warning' | 'info';
  appliesTo: 'all' | 'full';
  title: string;
  detail: string;
}

export interface BackupCompatibilityReport {
  fileVersion: number | null;
  currentVersion: number;
  versionStatus: SchemaVersionStatus;
  issues: BackupCompatibilityIssue[];
  missingAudioDataCount: number;
  orphanToneScheduleCount: number;
  invalidScheduleCount: number;
  invalidHolidayCount: number;
  deprecatedFieldNames: string[];
  requiresAck: boolean;
}

const VALID_BACKENDS: AudioBackend[] = ['mpv', 'aplay', 'paplay', 'mpg123'];
const VALID_OUTPUTS: AudioOutputDevice[] = ['default', 'hw:0,0', 'hdmi', 'usb-audio'];
const DEPRECATED_HW_KEYS = ['gpioPin', 'useRelay', 'relayPin', 'relayPulseMs', 'smartlife', 'tuyaDeviceId'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function analyzeBackupCompatibility(
  rawBackup: Partial<BellBackupPayload> & Record<string, unknown>,
  currentState: BellAppState,
  mode: BackupRestoreMode
): BackupCompatibilityReport {
  const issues: BackupCompatibilityIssue[] = [];
  const rawVersion = rawBackup.version;
  const fileVersion =
    typeof rawVersion === 'number' && Number.isFinite(rawVersion) ? rawVersion : null;

  let versionStatus: SchemaVersionStatus = 'match';
  if (fileVersion === null) {
    versionStatus = 'missing';
    issues.push({
      id: 'version-missing',
      severity: 'warning',
      appliesTo: 'all',
      title: 'Versión de esquema no especificada',
      detail: `El archivo no incluye el campo "version" (el esquema actual es v${BACKUP_SCHEMA_VERSION}). Se aplicarán valores predeterminados en campos ausentes.`,
    });
  } else if (fileVersion < BACKUP_SCHEMA_VERSION) {
    versionStatus = 'older';
    issues.push({
      id: 'version-older',
      severity: 'warning',
      appliesTo: 'all',
      title: `Esquema anterior detectado (archivo v${fileVersion} vs actual v${BACKUP_SCHEMA_VERSION})`,
      detail:
        'Este respaldo procede de una versión antigua de CampanaOS. Se adaptarán automáticamente las propiedades nuevas al importar.',
    });
  } else if (fileVersion > BACKUP_SCHEMA_VERSION) {
    versionStatus = 'newer';
    issues.push({
      id: 'version-newer',
      severity: 'error',
      appliesTo: 'all',
      title: `Versión más reciente incompatible (archivo v${fileVersion} > actual v${BACKUP_SCHEMA_VERSION})`,
      detail:
        'El respaldo fue creado en una versión superior de CampanaOS. Podrían perderse campos nuevos o fallar estructuras no reconocidas.',
    });
  }

  const profiles = Array.isArray(rawBackup.profiles) ? rawBackup.profiles : [];
  const schedules = Array.isArray(rawBackup.schedules) ? rawBackup.schedules : [];
  const holidays = Array.isArray(rawBackup.holidays) ? rawBackup.holidays : [];
  const tones = Array.isArray(rawBackup.tones) ? rawBackup.tones : [];

  const profileIds = new Set(profiles.map((p) => p?.id).filter(Boolean));
  const toneIds = new Set([
    ...currentState.tones.filter((t) => t.category === 'built-in').map((t) => t.id),
    ...tones.map((t) => t?.id).filter(Boolean),
  ]);

  if (profiles.length === 0) {
    issues.push({
      id: 'no-profiles',
      severity: 'error',
      appliesTo: 'all',
      title: 'Sin perfiles horarios',
      detail: 'El archivo no contiene ningún perfil horario válido.',
    });
  } else if (!rawBackup.activeProfileId || !profileIds.has(String(rawBackup.activeProfileId))) {
    issues.push({
      id: 'active-profile-fallback',
      severity: 'info',
      appliesTo: 'all',
      title: 'Perfil activo ausente en el respaldo',
      detail: `El identificador activeProfileId no coincide con ningún perfil del archivo; se activará "${profiles[0]?.name ?? 'el primero'}".`,
    });
  }

  let missingAudioDataCount = 0;
  for (const tone of tones) {
    if (tone?.category === 'custom' && (!tone.dataUrl || !String(tone.dataUrl).includes(','))) {
      missingAudioDataCount += 1;
    }
  }
  if (missingAudioDataCount > 0) {
    issues.push({
      id: 'missing-audio-data',
      severity: 'warning',
      appliesTo: 'all',
      title: `${missingAudioDataCount} audio(s) personalizado(s) sin datos incrustados`,
      detail:
        'Uno o más tonos personalizados no contienen el archivo MP3/WAV en Base64; solo se restaurará su referencia si el archivo ya existe en el equipo.',
    });
  }

  let orphanToneScheduleCount = 0;
  let invalidScheduleCount = 0;
  let orphanProfileScheduleCount = 0;
  for (const sch of schedules) {
    if (!sch || !TIME_RE.test(String(sch.time ?? '')) || !Array.isArray(sch.days) || sch.days.length === 0) {
      invalidScheduleCount += 1;
    }
    if (sch?.profileId && !profileIds.has(sch.profileId)) {
      orphanProfileScheduleCount += 1;
    }
    if (sch?.toneId && !toneIds.has(sch.toneId)) {
      orphanToneScheduleCount += 1;
    }
  }

  if (orphanToneScheduleCount > 0) {
    issues.push({
      id: 'orphan-tone-schedules',
      severity: 'warning',
      appliesTo: 'all',
      title: `${orphanToneScheduleCount} toque(s) referencian un tono inexistente`,
      detail:
        'Hay horarios que apuntan a un ID de audio que no figura en la biblioteca del respaldo; sonarán con el timbre clásico de reserva.',
    });
  }

  if (orphanProfileScheduleCount > 0 || invalidScheduleCount > 0) {
    issues.push({
      id: 'invalid-schedules',
      severity: 'warning',
      appliesTo: 'all',
      title: 'Toques horarios con formato incompleto',
      detail: `${invalidScheduleCount} toque(s) con hora/días no válidos y ${orphanProfileScheduleCount} asociado(s) a un perfil inexistente.`,
    });
  }

  let invalidHolidayCount = 0;
  for (const h of holidays) {
    if (
      !h ||
      !DATE_RE.test(String(h.startDate ?? '')) ||
      !DATE_RE.test(String(h.endDate ?? '')) ||
      String(h.endDate) < String(h.startDate)
    ) {
      invalidHolidayCount += 1;
    }
  }
  if (invalidHolidayCount > 0) {
    issues.push({
      id: 'invalid-holidays',
      severity: 'warning',
      appliesTo: 'all',
      title: `${invalidHolidayCount} festivo(s) con fechas incoherentes`,
      detail: 'Alguna excepción del calendario tiene un formato de fecha no estándar o fecha final anterior a la inicial.',
    });
  }

  const hw = (rawBackup.hardware ?? null) as Record<string, unknown> | null;
  const deprecatedFieldNames: string[] = [];
  if (hw) {
    for (const key of DEPRECATED_HW_KEYS) {
      if (key in hw) deprecatedFieldNames.push(key);
    }
  }
  if (deprecatedFieldNames.length > 0) {
    issues.push({
      id: 'deprecated-hw-fields',
      severity: 'info',
      appliesTo: 'all',
      title: 'Campos obsoletos de hardware ignorados',
      detail: `El respaldo incluye propiedades heredadas (${deprecatedFieldNames.join(', ')}) que ya no se utilizan en esta versión solo por audio.`,
    });
  }

  if (mode === 'full') {
    if (!hw) {
      issues.push({
        id: 'missing-hardware-full',
        severity: 'warning',
        appliesTo: 'full',
        title: 'Sin bloque de configuración de audio Linux',
        detail: 'Has elegido restauración completa pero el archivo no incluye sección "hardware"; se conservará la configuración actual del equipo.',
      });
    } else {
      const backend = hw.audioBackend as AudioBackend;
      const output = hw.audioOutput as AudioOutputDevice;
      if (backend && !VALID_BACKENDS.includes(backend)) {
        issues.push({
          id: 'unknown-backend',
          severity: 'warning',
          appliesTo: 'full',
          title: `Reproductor "${String(backend)}" no soportado`,
          detail: `Los reproductores compatibles en v${BACKUP_SCHEMA_VERSION} son: ${VALID_BACKENDS.join(', ')}.`,
        });
      }
      if (output && !VALID_OUTPUTS.includes(output)) {
        issues.push({
          id: 'unknown-output',
          severity: 'warning',
          appliesTo: 'full',
          title: `Salida de audio "${String(output)}" desconocida`,
          detail: `Las salidas reconocidas son: ${VALID_OUTPUTS.join(', ')}.`,
        });
      }
    }

    const sec = (rawBackup.security ?? null) as Record<string, unknown> | null;
    if (sec) {
      const nextPort = Number(sec.webPort);
      const nextHost = String(sec.hostnameMdns || '').trim();
      if (
        (Number.isFinite(nextPort) && nextPort !== currentState.security.webPort) ||
        (nextHost && nextHost !== currentState.security.hostnameMdns)
      ) {
        issues.push({
          id: 'network-url-change',
          severity: 'info',
          appliesTo: 'full',
          title: 'Cambio en la dirección web de red local',
          detail: `La restauración completa cambiará la dirección mDNS/puerto a http://${nextHost || currentState.security.hostnameMdns}.local:${Number.isFinite(nextPort) ? nextPort : currentState.security.webPort} (tras reiniciar el servicio web en Linux).`,
        });
      }
    }
  }

  const requiresAck =
    versionStatus === 'newer' ||
    issues.some((i) => i.severity === 'error') ||
    missingAudioDataCount > 0;

  return {
    fileVersion,
    currentVersion: BACKUP_SCHEMA_VERSION,
    versionStatus,
    issues,
    missingAudioDataCount,
    orphanToneScheduleCount,
    invalidScheduleCount,
    invalidHolidayCount,
    deprecatedFieldNames,
    requiresAck,
  };
}
