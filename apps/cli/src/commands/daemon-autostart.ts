import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { userInfo, homedir } from 'node:os';
import { runCommandTextLegacy, type CommandSpec } from '@lody/shared/node/process';
import { toShared } from '@/platform/process-options';

type Run = (command: string, args: readonly string[]) => Promise<void>;
export async function runInstallCommand(
  command: string,
  args: readonly string[],
  timeout = 30000
): Promise<void> {
  const result = await runCommandTextLegacy(
    {
      command,
      args,
      timeout,
      maxOutputBytes: 1024 * 1024,
      check: 'exit-0',
    } satisfies CommandSpec & { check: 'exit-0' },
    toShared()
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const ps = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const unit = (value: string) => JSON.stringify(value.replaceAll('%', '%%'));

/** Refuse foreign or modified registrations; never replace a user-owned service. */
async function publishOwnedFile(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temporary, file);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || (await fs.readFile(file, 'utf8')) !== content)
        throw new Error(`Existing service configuration was preserved: ${file}`);
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Register the next login/boot only. The initial start uses the existing ready handshake. */
export async function registerDaemonAutostart(options: {
  service: string;
  dataDir: string;
  platform?: NodeJS.Platform;
  home?: string;
  systemdDirectory?: string;
  run?: Run;
}): Promise<string> {
  const { service, dataDir } = options;
  if ([service, dataDir].some((value) => /[\x00-\x1f\x7f]/.test(value)))
    throw new Error('Autostart paths cannot contain control characters');
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const run = options.run ?? runInstallCommand;
  const id = createHash('sha256').update(dataDir).digest('hex').slice(0, 12);
  const name = `lody-daemon-${id}`;
  if (platform === 'darwin') {
    const system = !options.home && process.getuid?.() === 0;
    const file = path.join(
      system ? '/Library/LaunchDaemons' : path.join(home, 'Library', 'LaunchAgents'),
      `ai.lody.${name}.plist`
    );
    await publishOwnedFile(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>ai.lody.${name}</string>
<key>ProgramArguments</key><array><string>${xml(service)}</string><string>daemon-runner</string></array>
<key>EnvironmentVariables</key><dict><key>LODY_DATA_DIR</key><string>${xml(dataDir)}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n`
    );
    return `${system ? 'Boot' : 'Login'} autostart registered: ${file}`;
  }
  if (platform === 'linux') {
    // A root install uses a boot service; regular users keep their own user unit.
    const system = !options.home && process.getuid?.() === 0;
    const flags = system ? [] : ['--user'];
    await run('systemctl', [...flags, 'show', '--property=Version', '--value']);
    const directory =
      options.systemdDirectory ??
      (system ? '/etc/systemd/system' : path.join(home, '.config', 'systemd', 'user'));
    const file = path.join(directory, `${name}.service`);
    await publishOwnedFile(
      file,
      `[Unit]\nDescription=Lody managed daemon\n[Service]\nType=simple\nExecStart=${unit(service)} daemon-runner\nEnvironment=${unit(`LODY_DATA_DIR=${dataDir}`)}\nRestart=on-failure\nRestartSec=10\n[Install]\nWantedBy=${system ? 'multi-user.target' : 'default.target'}\n`
    );
    await run('systemctl', [...flags, 'daemon-reload']);
    await run('systemctl', [...flags, 'enable', `${name}.service`]);
    return system
      ? `Boot autostart registered: ${file}`
      : `Login autostart registered: ${file}. Headless persistence after logout requires user lingering.`;
  }
  if (platform === 'win32') {
    const marker = `Lody managed daemon ${id}`;
    const launch = `$env:LODY_DATA_DIR=${ps(dataDir)}; & ${ps(service)} daemon-runner; exit $LASTEXITCODE`;
    const argumentsText = `-NoProfile -NonInteractive -EncodedCommand ${Buffer.from(launch, 'utf16le').toString('base64')}`;
    const executable = path.win32.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    const script = `$ErrorActionPreference='Stop'
$name=${ps(name)}; $marker=${ps(marker)}; $exe=${ps(executable)}; $argsText=${ps(argumentsText)}
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$existing=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if($existing) {
  $owner=$existing.Principal.UserId
  if($owner -notlike 'S-1-*'){$owner=([System.Security.Principal.NTAccount]::new($owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value}
  if($owner -ne $sid -or $existing.Settings.ExecutionTimeLimit -ne 'PT0S' -or $existing.Settings.DisallowStartIfOnBatteries -or $existing.Settings.StopIfGoingOnBatteries){throw 'Existing scheduled task was preserved'}
  if($existing.Description -ne $marker -or @($existing.Actions).Count -ne 1 -or $existing.Actions[0].Execute -ne $exe -or $existing.Actions[0].Arguments -ne $argsText){throw 'Existing scheduled task was preserved'}
} else {
  $action=New-ScheduledTaskAction -Execute $exe -Argument $argsText
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User $sid
  $principal=New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $name -Description $marker -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
}`;
    await run(executable, [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ]);
    return `Login autostart registered: ${name} (${userInfo().username})`;
  }
  throw new Error('Autostart is unavailable on this operating system');
}
