export type AudioBackend = 'mpv' | 'aplay' | 'paplay' | 'mpg123';

export type AudioOutputDevice = 'default' | 'hw:0,0' | 'hdmi' | 'usb-audio';

export interface BellProfile {
  id: string;
  name: string;
  description: string;
  isSilent?: boolean;
}

export interface BellScheduleItem {
  id: string;
  profileId: string;
  time: string; // HH:MM (24h)
  label: string;
  days: number[]; // 1 = Lunes ... 7 = Domingo
  toneId: string;
  enabled: boolean;
}

export interface HolidayException {
  id: string;
  name: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
}

export interface AudioTone {
  id: string;
  name: string;
  category: 'built-in' | 'custom';
  description: string;
  durationSec: number;
  synthPreset?: 'classic-bell' | 'westminster' | 'soft-chime' | 'recess-bell' | 'evacuation';
  fileName?: string;
  mimeType?: string;
  dataUrl?: string;
}

export interface HardwareConfig {
  schoolName: string;
  linuxUser: string;
  audioBackend: AudioBackend;
  audioOutput: AudioOutputDevice;
  masterVolume: number; // 0 - 100
  timezone: string;
}

export interface SecurityNetworkConfig {
  authEnabled: boolean;
  hasAdminPin: boolean;
  lockReadOnlyPreview: boolean;
  hostnameMdns: string;
  webPort: number;
}

export interface SystemdSyncStatus {
  supported: boolean;
  lastSyncedAt: string | null;
  activeTimerCount: number;
  lastMessage: string;
}

export interface BellLogEntry {
  id: string;
  timestamp: string; // ISO string
  timeDisplay: string; // HH:MM:SS
  label: string;
  toneName: string;
  source: 'automatico' | 'manual' | 'emergencia';
  status: 'completado' | 'omitido-festivo' | 'silenciado';
}

export interface BellAppState {
  activeProfileId: string;
  profiles: BellProfile[];
  schedules: BellScheduleItem[];
  holidays: HolidayException[];
  tones: AudioTone[];
  hardware: HardwareConfig;
  security: SecurityNetworkConfig;
  systemdSync: SystemdSyncStatus;
  authenticated: boolean;
  locked?: boolean;
  lanIps?: string[];
  hasYoutubeCookies?: boolean;
  logs: BellLogEntry[];
  serverTimeIso: string;
}

export const BACKUP_SCHEMA_VERSION = 1;

export type BackupRestoreMode = 'schedules-and-audio' | 'full';

export interface BellBackupPayload {
  format: 'campana-os-backup';
  version: number;
  backupName: string;
  exportedAt: string;
  activeProfileId: string;
  profiles: BellProfile[];
  schedules: BellScheduleItem[];
  holidays: HolidayException[];
  tones: AudioTone[];
  hardware: HardwareConfig;
  security: {
    authEnabled: boolean;
    lockReadOnlyPreview: boolean;
    hostnameMdns: string;
    webPort: number;
  };
}

