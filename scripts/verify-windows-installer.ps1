[CmdletBinding()]
param(
  [string]$InstallerPath = 'dist/Mini-Browser-Setup-User-Windows-x64.exe',
  [switch]$ProfileOnly
)

# CI only: provision a temporary standard account on the disposable Windows runner.
# The installer and uninstaller themselves run with that account's ordinary token.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This installer check requires Windows.' }
$installer = if ($ProfileOnly) { $null } else { (Resolve-Path -LiteralPath $InstallerPath).Path }
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
  if (-not $ProfileOnly) { Copy-Item -LiteralPath $installer -Destination $stagedInstaller }
  $childScript = Join-Path $fixture 'check-as-standard-user.ps1'
  $resultPath = Join-Path $fixture 'result.json'

  @'
param([string]$Installer, [string]$Result, [string]$Version, [string]$ProductName, [string]$AppName, [switch]$ProfileOnly, [switch]$FreshProfile)
$ErrorActionPreference = 'Stop'
$checks = [System.Collections.Generic.List[string]]::new()
$diagnostics = @{}
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
  $diagnostics.identity = $identity.Name
  $diagnostics.sid = $identity.User.Value
  Confirm (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) 'Installer process runs under a genuine non-administrator Windows account'
  # Alternate credentials load the new hive but inherit the runner environment.
  # Initialize this disposable user's first-logon shell-folder registry values,
  # rather than accepting a runner directory fallback. No existing account or
  # browser settings are changed by this isolated test fixture.
  $profileRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile, [Environment+SpecialFolderOption]::Create)
  $diagnostics.profile = $profileRoot
  if ([string]::IsNullOrWhiteSpace($profileRoot) -or -not (Test-Path ('Registry::HKEY_USERS\' + $identity.User.Value))) {
    throw 'Windows did not load the actual standard-account profile and registry hive.'
  }
  $env:USERPROFILE = $profileRoot
  $env:HOMEDRIVE = [IO.Path]::GetPathRoot($profileRoot).TrimEnd('\')
  $env:HOMEPATH = $profileRoot.Substring($env:HOMEDRIVE.Length)
  $env:LOCALAPPDATA = Join-Path $profileRoot 'AppData\Local'
  $env:APPDATA = Join-Path $profileRoot 'AppData\Roaming'
  $env:TEMP = Join-Path $env:LOCALAPPDATA 'Temp'
  $env:TMP = $env:TEMP
  New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
  New-Item -ItemType Directory -Path $env:APPDATA -Force | Out-Null
  $diagnostics.phase = 'Initialize the disposable user shell-folder registry'
  $shellFolders = @{
    'Local AppData' = '%USERPROFILE%\AppData\Local'
    'AppData' = '%USERPROFILE%\AppData\Roaming'
    'Desktop' = '%USERPROFILE%\Desktop'
    'Start Menu' = '%USERPROFILE%\AppData\Roaming\Microsoft\Windows\Start Menu'
    'Programs' = '%USERPROFILE%\AppData\Roaming\Microsoft\Windows\Start Menu\Programs'
  }
  $explorer = 'Software\Microsoft\Windows\CurrentVersion\Explorer\'
  $expandable = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($explorer + 'User Shell Folders')
  $expanded = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($explorer + 'Shell Folders')
  try {
    foreach ($name in $shellFolders.Keys) {
      $rawPath = $shellFolders[$name]
      $actualPath = [Environment]::ExpandEnvironmentVariables($rawPath)
      New-Item -ItemType Directory -Path $actualPath -Force | Out-Null
      $expandable.SetValue($name, $rawPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
      $expanded.SetValue($name, $actualPath, [Microsoft.Win32.RegistryValueKind]::String)
    }
  } finally { $expandable.Dispose(); $expanded.Dispose() }
  if (-not $FreshProfile) {
    # Start once more with the corrected standard-account environment. Shell
    # APIs may have cached inherited runner folders at PowerShell startup.
    $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Installer "{1}" -Result "{2}" -Version "{3}" -ProductName "{4}" -AppName "{5}" -FreshProfile' -f $PSCommandPath, $Installer, $Result, $Version, $ProductName, $AppName
    if ($ProfileOnly) { $arguments += ' -ProfileOnly' }
    $fresh = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WorkingDirectory $PSScriptRoot -PassThru
    if (-not $fresh.WaitForExit(300000)) {
      & taskkill.exe /PID $fresh.Id /T /F | Out-Null
      throw 'The fresh standard-account check exceeded its timeout.'
    }
    exit $fresh.ExitCode
  }
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class MiniBrowserKnownFolders {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHGetFolderPath(IntPtr owner, int folder, IntPtr token, uint flags, StringBuilder path);
  public static string Read(int identifier) {
    StringBuilder path = new StringBuilder(32768);
    int status = SHGetFolderPath(IntPtr.Zero, identifier | 0x8000, IntPtr.Zero, 0, path);
    if (status < 0) throw new InvalidOperationException("SHGetFolderPath CSIDL " + identifier + " failed with HRESULT 0x" + status.ToString("X8"));
    return path.ToString();
  }
}
"@
  $diagnostics.phase = 'Read the actual user native shell folders'
  $localData = [MiniBrowserKnownFolders]::Read(28)
  $roamingData = [MiniBrowserKnownFolders]::Read(26)
  $diagnostics.localData = $localData
  $diagnostics.roamingData = $roamingData
  $nativeLocalData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData, [Environment+SpecialFolderOption]::Create)
  Confirm (-not [string]::IsNullOrWhiteSpace($localData) -and $localData -eq $nativeLocalData -and $localData.StartsWith(($profileRoot.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) -and $roamingData.StartsWith(($profileRoot.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) 'The standard account has its own loaded user profile'
  if ($ProfileOnly) {
    [pscustomobject]@{ success = $true; checks = @($checks) } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Result -Encoding UTF8
    exit 0
  }
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
  [pscustomobject]@{ success = $false; checks = @($checks); error = $_.Exception.Message; diagnostics = $diagnostics } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Result -Encoding UTF8
  exit 1
}
'@ | Set-Content -LiteralPath $childScript -Encoding UTF8

  $windowsPowerShell = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
  $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Installer "{1}" -Result "{2}" -Version "{3}" -ProductName "{4}" -AppName "{5}"' -f $childScript, $stagedInstaller, $resultPath, $package.version, $package.build.productName, $package.name
  if ($ProfileOnly) { $arguments += ' -ProfileOnly' }
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
  if (-not $result.success -or $child.ExitCode -ne 0) {
    if ($result.diagnostics) { Write-Host ('Standard-account profile diagnostics: ' + ($result.diagnostics | ConvertTo-Json -Compress)) }
    throw "Standard-user installer check failed: $($result.error)"
  }
  $checkKind = if ($ProfileOnly) { 'profile' } else { 'installer' }
  Write-Host ('Completed {0} {1} checks under a non-administrator account.' -f @($result.checks).Count, $checkKind)
} finally {
  if ($null -ne $user) {
    $sid = $user.SID.Value
    Remove-LocalUser -SID $user.SID -ErrorAction SilentlyContinue
    Get-CimInstance Win32_UserProfile -Filter "SID='$sid'" -ErrorAction SilentlyContinue | Remove-CimInstance -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
}
