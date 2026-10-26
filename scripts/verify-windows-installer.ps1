[CmdletBinding()]
param(
  [string]$InstallerPath = 'dist/Mini-Browser-Setup-User-Windows-x64.exe'
)

# CI only: provision a temporary standard account on the disposable Windows runner.
# The installer and uninstaller themselves run with that account's ordinary token.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This installer check requires Windows.' }
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$package = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json
$id = [guid]::NewGuid().ToString('N')
$accountName = 'mbtest' + $id.Substring(0, 12)
$fixture = Join-Path $env:ProgramData ('MiniBrowserInstallerCheck-' + $id)
$user = $null
$child = $null

try {
  # Never persist or print this disposable credential.
  $password = ConvertTo-SecureString ('Mb!7-' + [guid]::NewGuid().ToString('N')) -AsPlainText -Force
  $user = New-LocalUser -Name $accountName -Password $password -AccountNeverExpires -PasswordNeverExpires -Description 'Disposable installer validation account'
  $usersGroup = Get-LocalGroup -SID 'S-1-5-32-545'
  if (-not (Get-LocalGroupMember -Group $usersGroup | Where-Object { $_.SID.Value -eq $user.SID.Value })) {
    Add-LocalGroupMember -Group $usersGroup -Member $user
  }
  $credential = [pscredential]::new(($env:COMPUTERNAME + '\' + $accountName), $password)

  New-Item -ItemType Directory -Path $fixture | Out-Null
  $acl = Get-Acl -LiteralPath $fixture
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($user.SID, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $fixture -AclObject $acl
  $stagedInstaller = Join-Path $fixture 'setup.exe'
  Copy-Item -LiteralPath $installer -Destination $stagedInstaller
  $childScript = Join-Path $fixture 'check-as-standard-user.ps1'
  $resultPath = Join-Path $fixture 'result.json'

  @'
param([string]$Installer, [string]$Result, [string]$Version, [string]$ProductName, [string]$AppName)
$ErrorActionPreference = 'Stop'
$checks = [System.Collections.Generic.List[string]]::new()
function Confirm([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
  $checks.Add($Message)
}
function Wait-For([scriptblock]$Predicate, [string]$Message) {
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  while (-not (& $Predicate)) {
    if ([DateTime]::UtcNow -ge $deadline) { throw $Message }
    Start-Sleep -Milliseconds 200
  }
}
function Run-Silent([string]$File, [string]$Arguments) {
  $process = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru
  if (-not $process.WaitForExit(120000)) {
    & taskkill.exe /PID $process.Id /T /F | Out-Null
    throw 'The installer or uninstaller exceeded its two-minute timeout.'
  }
  if ($process.ExitCode -ne 0) { throw "Installer process failed with exit code $($process.ExitCode)." }
}
function Find-Registration([Microsoft.Win32.RegistryHive]$Hive) {
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($Hive, $view)
    try {
      $uninstall = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
      if ($null -eq $uninstall) { continue }
      try {
        foreach ($name in $uninstall.GetSubKeyNames()) {
          $entry = $uninstall.OpenSubKey($name)
          try {
            if ($entry.GetValue('DisplayName') -in @($ProductName, ($ProductName + ' ' + $Version))) {
              [pscustomobject]@{ Name = $name; View = $view.ToString(); Version = $entry.GetValue('DisplayVersion'); Command = $entry.GetValue('UninstallString') }
            }
          } finally { $entry.Dispose() }
        }
      } finally { $uninstall.Dispose() }
    } finally { $base.Dispose() }
  }
}

try {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
  Confirm (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) 'Installer process runs under a genuine non-administrator Windows account'
  $localData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  Confirm (-not [string]::IsNullOrWhiteSpace($localData)) 'The standard account has its own loaded user profile'
  # Alternate-user launches can inherit the runner's environment. Keep native
  # installer scratch files inside this actual user's writable profile instead.
  $env:LOCALAPPDATA = $localData
  $env:APPDATA = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
  $env:TEMP = Join-Path $localData 'Temp'
  $env:TMP = $env:TEMP
  New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
  Confirm (@(Find-Registration ([Microsoft.Win32.RegistryHive]::CurrentUser)).Count -eq 0) 'The test account starts without an existing installation'
  Confirm (@(Find-Registration ([Microsoft.Win32.RegistryHive]::LocalMachine)).Count -eq 0) 'The machine starts without a machine-wide installation'

  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class MiniBrowserManifest {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr FindResource(IntPtr module, IntPtr name, IntPtr type);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint SizeofResource(IntPtr module, IntPtr resource);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
  [DllImport("kernel32.dll")] static extern IntPtr LockResource(IntPtr resource);
  [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr module);
  public static string Read(string path) {
    IntPtr module = LoadLibraryEx(path, IntPtr.Zero, 0x22);
    if (module == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      IntPtr resource = FindResource(module, new IntPtr(1), new IntPtr(24));
      if (resource == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      uint size = SizeofResource(module, resource);
      byte[] bytes = new byte[checked((int)size)];
      IntPtr data = LockResource(LoadResource(module, resource));
      if (data == IntPtr.Zero || size == 0) throw new InvalidOperationException("The executable manifest is empty.");
      Marshal.Copy(data, bytes, 0, bytes.Length);
      return Encoding.UTF8.GetString(bytes).Trim('\0', '\uFEFF');
    } finally { FreeLibrary(module); }
  }
}
"@
  function Confirm-Manifest([string]$File, [string]$Label) {
    [xml]$manifest = [MiniBrowserManifest]::Read($File)
    $execution = $manifest.SelectSingleNode("//*[local-name()='requestedExecutionLevel']")
    Confirm ($null -ne $execution -and $execution.GetAttribute('level') -eq 'asInvoker' -and $execution.GetAttribute('uiAccess') -ne 'true') "$Label requests the caller's existing privileges (asInvoker)"
  }

  Confirm-Manifest $Installer 'Installer'
  Run-Silent $Installer '/S'
  $registrations = @(Find-Registration ([Microsoft.Win32.RegistryHive]::CurrentUser))
  Confirm ($registrations.Count -ge 1 -and @($registrations | Where-Object Version -ne $Version).Count -eq 0) 'The installed version registers its uninstaller only in the current user profile'
  $uninstallCommand = [string]$registrations[0].Command
  if ($uninstallCommand -notmatch '^"([^"]+)"') { throw 'The current-user uninstall command is invalid.' }
  $uninstaller = $Matches[1]
  $installDirectory = Split-Path -Parent $uninstaller
  $profilePrefix = $localData.TrimEnd('\') + '\'
  Confirm ($installDirectory.StartsWith($profilePrefix, [StringComparison]::OrdinalIgnoreCase)) 'Default installation stays inside the standard account LocalAppData directory'
  Confirm ($uninstallCommand -match '/currentuser') 'The registered uninstaller uses current-user mode'
  $appExecutable = Join-Path $installDirectory ($ProductName + '.exe')
  Confirm (Test-Path -LiteralPath $appExecutable -PathType Leaf) 'The application executable was installed successfully without administrator privileges'
  Confirm (Test-Path -LiteralPath (Join-Path $installDirectory 'resources/app.asar') -PathType Leaf) 'The application source archive was installed successfully'
  Confirm (@(Get-ChildItem -LiteralPath $installDirectory -Filter 'elevate.exe' -File -Recurse).Count -eq 0) 'The installed application contains no elevation helper'
  Confirm (@(Find-Registration ([Microsoft.Win32.RegistryHive]::LocalMachine)).Count -eq 0) 'Installation creates no machine-wide uninstall registration'
  Confirm-Manifest $appExecutable 'Installed browser'
  Confirm-Manifest $uninstaller 'Uninstaller'

  $profileDirectory = Join-Path $env:APPDATA $AppName
  New-Item -ItemType Directory -Path $profileDirectory -Force | Out-Null
  $sentinel = Join-Path $profileDirectory 'installer-check-profile.txt'
  'Existing browser data must survive uninstall.' | Set-Content -LiteralPath $sentinel -Encoding UTF8

  Run-Silent $uninstaller '/S /currentuser'
  Wait-For { -not (Test-Path -LiteralPath $appExecutable) -and @(Find-Registration ([Microsoft.Win32.RegistryHive]::CurrentUser)).Count -eq 0 } 'The standard account could not remove its installed application and uninstall registration.'
  Confirm (-not (Test-Path -LiteralPath $appExecutable)) 'The same standard account uninstalls the browser without elevation'
  Confirm (@(Find-Registration ([Microsoft.Win32.RegistryHive]::CurrentUser)).Count -eq 0) 'Uninstallation removes the current-user registration'
  Confirm ((Test-Path -LiteralPath $sentinel) -and (Get-Content -LiteralPath $sentinel -Raw).Trim() -eq 'Existing browser data must survive uninstall.') 'Uninstallation preserves the existing browser profile'
  [pscustomobject]@{ success = $true; checks = @($checks); installDirectory = $installDirectory } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Result -Encoding UTF8
} catch {
  [pscustomobject]@{ success = $false; checks = @($checks); error = $_.Exception.Message } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Result -Encoding UTF8
  exit 1
}
'@ | Set-Content -LiteralPath $childScript -Encoding UTF8

  $windowsPowerShell = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
  $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Installer "{1}" -Result "{2}" -Version "{3}" -ProductName "{4}" -AppName "{5}"' -f $childScript, $stagedInstaller, $resultPath, $package.version, $package.build.productName, $package.name
  $stderr = Join-Path $fixture 'stderr.txt'
  $child = Start-Process -FilePath $windowsPowerShell -ArgumentList $arguments -Credential $credential -LoadUserProfile -WorkingDirectory $fixture -WindowStyle Hidden -RedirectStandardOutput (Join-Path $fixture 'stdout.txt') -RedirectStandardError $stderr -PassThru
  if (-not $child.WaitForExit(330000)) {
    & taskkill.exe /PID $child.Id /T /F | Out-Null
    throw 'Standard-user installation validation exceeded its timeout.'
  }
  if (-not (Test-Path -LiteralPath $resultPath)) {
    if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr | Write-Host }
    throw "The standard-user check produced no result (exit $($child.ExitCode))."
  }
  $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  foreach ($check in $result.checks) { Write-Host "PASS $check" }
  if (-not $result.success -or $child.ExitCode -ne 0) { throw "Standard-user installer check failed: $($result.error)" }
  Write-Host ('Completed {0} installer checks under a non-administrator account.' -f @($result.checks).Count)
} finally {
  if ($null -ne $user) {
    $sid = $user.SID.Value
    Remove-LocalUser -SID $user.SID -ErrorAction SilentlyContinue
    Get-CimInstance Win32_UserProfile -Filter "SID='$sid'" -ErrorAction SilentlyContinue | Remove-CimInstance -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
}
