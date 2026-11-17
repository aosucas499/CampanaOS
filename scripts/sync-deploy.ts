import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultBellState } from '../src/utils/defaultState.ts';
import {
  generateInstallScript,
  generateRingServiceTemplate,
  generateScheduleJson,
  generateSudoersRule,
  generateSyncTimersPy,
  generateTimbreRunnerPy,
  generateWebPanelPy,
  generateWebServiceUnit,
} from '../src/utils/linuxTemplates.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const DEPLOY_DIR = path.join(ROOT_DIR, 'deploy');
const WEBAPP_DIR = path.join(DEPLOY_DIR, 'webapp');

if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
  console.error('Error: dist/index.html no existe. Ejecuta "npm run build" primero o usa "npm run sync:deploy".');
  process.exit(1);
}

const defaultState = createDefaultBellState({
  systemdSupported: false,
  includeSeedLogs: false,
});

fs.mkdirSync(DEPLOY_DIR, { recursive: true });

// 1. Root install.sh (Git clone & update entry point)
const installShPath = path.join(ROOT_DIR, 'install.sh');
fs.writeFileSync(installShPath, generateInstallScript(defaultState, { mode: 'git' }), 'utf-8');
fs.chmodSync(installShPath, 0o755);

// 2. Python runtime & systemd templates inside deploy/
const executables: Array<[string, string]> = [
  ['timbre_runner.py', generateTimbreRunnerPy(defaultState)],
  ['sync_timers.py', generateSyncTimersPy()],
  ['web_panel.py', generateWebPanelPy()],
];

for (const [name, content] of executables) {
  const target = path.join(DEPLOY_DIR, name);
  fs.writeFileSync(target, content, 'utf-8');
  fs.chmodSync(target, 0o755);
}

const configFiles: Array<[string, string]> = [
  ['campana-ring@.service', generateRingServiceTemplate(defaultState, { mode: 'git' })],
  ['campana-web.service', generateWebServiceUnit(defaultState, { mode: 'git' })],
  ['campana-os.sudoers', generateSudoersRule(defaultState, { mode: 'git' })],
  ['schedule.json', generateScheduleJson(defaultState)],
];

for (const [name, content] of configFiles) {
  fs.writeFileSync(path.join(DEPLOY_DIR, name), content, 'utf-8');
}

// 3. Replace deploy/webapp/ cleanly with compiled Vite output from dist/
fs.rmSync(WEBAPP_DIR, { recursive: true, force: true });
fs.cpSync(DIST_DIR, WEBAPP_DIR, { recursive: true });

console.log('CampanaOS: árbol de despliegue GitHub actualizado correctamente:');
console.log(' - install.sh');
console.log(' - deploy/{timbre_runner.py,sync_timers.py,web_panel.py,campana-*.service,campana-os.sudoers,schedule.json}');
console.log(' - deploy/webapp/ (copiado desde dist/)');
