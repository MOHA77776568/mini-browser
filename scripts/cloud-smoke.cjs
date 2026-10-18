// A disposable X11 display for CI. This never changes normal desktop startup.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

async function main() {
  if (process.platform !== 'linux') throw new Error('Use npm run test:e2e on a desktop.');
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-browser-display-'));
  const display = `:${100 + process.pid % 500}`;
  const auth = path.join(runtime, 'Xauthority');
  const config = path.join(runtime, 'xorg.conf');
  fs.writeFileSync(auth, '', { mode: 0o600 });
  fs.writeFileSync(config, `Section "ServerFlags"
  Option "AutoAddDevices" "false"
  Option "AutoEnableDevices" "false"
  Option "DontVTSwitch" "true"
EndSection
Section "Device"
  Identifier "DummyDevice"
  Driver "dummy"
  VideoRam 192000
EndSection
Section "Monitor"
  Identifier "DummyMonitor"
  HorizSync 5.0-1000.0
  VertRefresh 5.0-200.0
  Modeline "1440x900" 106.50 1440 1520 1672 1904 900 903 909 934 -HSync +VSync
EndSection
Section "Screen"
  Identifier "DummyScreen"
  Device "DummyDevice"
  Monitor "DummyMonitor"
  DefaultDepth 24
  SubSection "Display"
    Depth 24
    Modes "1440x900"
  EndSubSection
EndSection
`);
  const authResult = spawnSync('xauth', ['-f', auth, 'add', display, '.', crypto.randomBytes(16).toString('hex')]);
  if (authResult.status !== 0) throw new Error('xauth is required for the CI display.');
  const displayLog = fs.openSync(path.join(runtime, 'display.log'), 'w');
  const server = spawn('/usr/lib/xorg/Xorg', [display, '-config', config, '-logfile', path.join(runtime, 'Xorg.log'), '-auth', auth, '-nolisten', 'tcp', '-noreset'], { stdio: ['ignore', displayLog, displayLog] });
  let serverError;
  server.on('error', error => { serverError = error; });
  const env = { ...process.env, DISPLAY: display, XAUTHORITY: auth, XDG_CACHE_HOME: path.join(runtime, 'cache'), XDG_CONFIG_HOME: path.join(runtime, 'config'), MINI_BROWSER_CI_NO_SANDBOX: '1' };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (serverError) throw serverError;
      if (server.exitCode !== null) throw new Error(`Xorg failed. See ${runtime}`);
      if (spawnSync('xdpyinfo', [], { env, stdio: 'ignore' }).status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`Xorg did not become ready. See ${runtime}`);
    console.log('Cloud CI: isolated virtual display; Chromium OS sandbox disabled only for this disposable test.');
    const child = spawn(process.execPath, [path.join(__dirname, 'smoke.cjs')], { env, stdio: 'inherit' });
    process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)); });
  } finally {
    if (server.exitCode === null && !serverError) {
      server.kill('SIGTERM');
      await new Promise(resolve => { server.once('exit', resolve); setTimeout(resolve, 3000).unref(); });
    }
    fs.closeSync(displayLog);
    fs.rmSync(runtime, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
