# Fremkit's Windows host: answers the server's Windows system calls (server/src/win/powershell-host.ts).
#
# Started once by the server with `powershell.exe ... -Command -`; this script arrives on stdin as a
# single base64 line, never as a path or an argument. Then one JSON line per request on stdin,
# {"id":n,"op":"...","arg":...}, and one JSON line per answer on stdout,
# {"id":n,"ok":true,"value":...} or {"id":n,"ok":false,"code":"..."}. Both directions are ASCII
# (\uXXXX escapes), so no console code page mangles clipboard text or a distro name.
#
# A failure answers a short code and nothing else: no exception text, no path, no value. Every
# arg is type-checked here before use, whatever the server already checked.
#
#   op                 arg                    value                                         codes
#   clipboard.read     -                      string ('' when it holds no text)             -
#   clipboard.write    { text: string }       true (text up to 1 MiB characters)            busy
#   clipboard.private  -                      [] or ['private']                             -
#   volume.get         -                      { level: 0-100, muted: bool }                 no-device
#   volume.set         { level: number }      true (clamped to 0-100)                       no-device
#   volume.mute        { muted: bool }        true                                          no-device
#   battery            -                      { internal: null | { percent, charging,       -
#                                                 minutesLeft? }, devices: [{ name, percent }] }
#   network.wifi       -                      { ssid: string|null, signal: 0-100|null }     no-wifi, location-denied
#   sound              'chimes'|'chord'|'ding'|'notify'|'tada'   true                       no-sound
#   dpapi.protect      base64 string          base64 string (CurrentUser scope)             dpapi-failed
#   dpapi.unprotect    base64 string          base64 string                                 dpapi-failed
#   wsl.list           -                      [distro names matching ^[A-Za-z0-9._-]{1,64}$] no-wsl, tool-timeout
#
# Common codes: invalid-arg, unknown-op, failed (anything unexpected).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$FkUtf8 = New-Object System.Text.UTF8Encoding $false
$FkOut = New-Object System.IO.StreamWriter ([Console]::OpenStandardOutput(), $FkUtf8)
$FkOut.AutoFlush = $true
$FkIn = New-Object System.IO.StreamReader ([Console]::OpenStandardInput(), $FkUtf8)

$FkSystemRoot = 'C:\Windows'
if ($env:SystemRoot -match '^[A-Za-z]:\\') { $FkSystemRoot = $env:SystemRoot.TrimEnd('\') }

$FkSounds = @('chimes', 'chord', 'ding', 'notify', 'tada')
$FkPlayer = $null

$FkNative = $true
try {
  Add-Type -AssemblyName System.Security
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace Fremkit {
  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    void RegisterControlChangeNotify(IntPtr notify);
    void UnregisterControlChangeNotify(IntPtr notify);
    void GetChannelCount(out uint count);
    void SetMasterVolumeLevel(float level, ref Guid context);
    void SetMasterVolumeLevelScalar(float level, ref Guid context);
    void GetMasterVolumeLevel(out float level);
    void GetMasterVolumeLevelScalar(out float level);
    void SetChannelVolumeLevel(uint channel, float level, ref Guid context);
    void SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
    void GetChannelVolumeLevel(uint channel, out float level);
    void GetChannelVolumeLevelScalar(uint channel, out float level);
    void SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
    void GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    void Activate(ref Guid iid, int context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object endpoint);
  }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    void EnumAudioEndpoints(int flow, int mask, out IntPtr devices);
    void GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
  }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumerator { }

  public static class Audio {
    // The default render endpoint (eRender, eMultimedia), or null when there is none.
    static IAudioEndpointVolume Endpoint() {
      IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice device;
      try { enumerator.GetDefaultAudioEndpoint(0, 1, out device); } catch (COMException) { return null; }
      Guid iid = typeof(IAudioEndpointVolume).GUID;
      object endpoint;
      device.Activate(ref iid, 23, IntPtr.Zero, out endpoint);
      return (IAudioEndpointVolume)endpoint;
    }

    // { level 0-100, muted 0/1 }, or null when there is no output device.
    public static int[] Get() {
      IAudioEndpointVolume endpoint = Endpoint();
      if (endpoint == null) return null;
      float level; bool muted;
      endpoint.GetMasterVolumeLevelScalar(out level);
      endpoint.GetMute(out muted);
      return new int[] { (int)Math.Round(level * 100), muted ? 1 : 0 };
    }

    public static bool Set(int level) {
      IAudioEndpointVolume endpoint = Endpoint();
      if (endpoint == null) return false;
      Guid context = Guid.Empty;
      endpoint.SetMasterVolumeLevelScalar(level / 100f, ref context);
      return true;
    }

    public static bool Mute(bool muted) {
      IAudioEndpointVolume endpoint = Endpoint();
      if (endpoint == null) return false;
      Guid context = Guid.Empty;
      endpoint.SetMute(muted, ref context);
      return true;
    }
  }

  public static class Clipboard {
    [DllImport("user32.dll", SetLastError = true)] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] static extern bool CloseClipboard();
    [DllImport("user32.dll")] static extern bool EmptyClipboard();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterClipboardFormat(string name);
    [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr memory);

    static bool Open() {
      for (int i = 0; i < 10; i++) {
        if (OpenClipboard(IntPtr.Zero)) return true;
        Thread.Sleep(20);
      }
      return false;
    }

    // 1 when the copying app asked clipboard watchers to look away, 0 otherwise, -1 when busy.
    public static int IsPrivate() {
      if (IsClipboardFormatAvailable(RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing"))) return 1;
      if (IsClipboardFormatAvailable(RegisterClipboardFormat("Clipboard Viewer Ignore"))) return 1;
      uint history = RegisterClipboardFormat("CanIncludeInClipboardHistory");
      if (!IsClipboardFormatAvailable(history)) return 0;
      if (!Open()) return -1;
      try {
        IntPtr memory = GetClipboardData(history);
        if (memory == IntPtr.Zero) return 0;
        IntPtr data = GlobalLock(memory);
        if (data == IntPtr.Zero) return 0;
        try { return GlobalSize(memory).ToUInt64() >= 4 && Marshal.ReadInt32(data) == 0 ? 1 : 0; }
        finally { GlobalUnlock(memory); }
      } finally { CloseClipboard(); }
    }

    public static bool Clear() {
      if (!Open()) return false;
      try { return EmptyClipboard(); } finally { CloseClipboard(); }
    }
  }
}
'@
} catch {
  $FkNative = $false
}

function FkFail([string]$code) { throw (New-Object System.Exception "fremkit:$code") }

function FkSend($message) {
  $json = ConvertTo-Json -InputObject $message -Compress -Depth 6
  $json = [regex]::Replace($json, '[^\x20-\x7e]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  $FkOut.WriteLine($json)
}

function FkProp($object, [string]$name) {
  if ($object -isnot [System.Management.Automation.PSCustomObject]) { FkFail 'invalid-arg' }
  $property = $object.PSObject.Properties[$name]
  if ($null -eq $property) { FkFail 'invalid-arg' }
  $property.Value
}

function FkIsNumber($value) {
  ($value -is [int]) -or ($value -is [long]) -or ($value -is [double]) -or ($value -is [decimal])
}

# Runs a system tool by absolute path with constant arguments; its stderr is read and dropped.
function FkRunTool([string]$file, [string]$arguments, $encoding, [int]$timeoutMs) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $file
  $info.Arguments = $arguments
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  if ($null -ne $encoding) { $info.StandardOutputEncoding = $encoding }
  $info.EnvironmentVariables.Remove('WSL_UTF8')
  $process = [System.Diagnostics.Process]::Start($info)
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $null = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($timeoutMs)) {
    try { $process.Kill() } catch { }
    FkFail 'tool-timeout'
  }
  @{ exit = $process.ExitCode; out = $stdout.Result }
}

function FkClipboardRead {
  $text = Get-Clipboard -Format Text -Raw
  if ($null -eq $text) { return '' }
  [string]$text
}

function FkClipboardWrite($arg) {
  $text = FkProp $arg 'text'
  if ($text -isnot [string] -or $text.Length -gt 1048576) { FkFail 'invalid-arg' }
  if ($text.Length -eq 0) {
    if (-not $FkNative -or -not [Fremkit.Clipboard]::Clear()) { FkFail 'busy' }
  } else {
    Set-Clipboard -Value $text
  }
  $true
}

function FkClipboardPrivate {
  if (-not $FkNative) { FkFail 'failed' }
  $private = [Fremkit.Clipboard]::IsPrivate()
  # A clipboard another app holds open is treated as private: better one missed entry than a leak.
  if ($private -ne 0) { 'private' }
}

function FkVolumeGet {
  if (-not $FkNative) { FkFail 'failed' }
  $state = [Fremkit.Audio]::Get()
  if ($null -eq $state) { FkFail 'no-device' }
  [ordered]@{ level = $state[0]; muted = ($state[1] -eq 1) }
}

function FkVolumeSet($arg) {
  $level = FkProp $arg 'level'
  if (-not (FkIsNumber $level) -or [double]::IsNaN([double]$level) -or [double]::IsInfinity([double]$level)) { FkFail 'invalid-arg' }
  $level = [int][Math]::Round([Math]::Max(0, [Math]::Min(100, [double]$level)))
  if (-not $FkNative) { FkFail 'failed' }
  if (-not [Fremkit.Audio]::Set($level)) { FkFail 'no-device' }
  $true
}

function FkVolumeMute($arg) {
  $muted = FkProp $arg 'muted'
  if ($muted -isnot [bool]) { FkFail 'invalid-arg' }
  if (-not $FkNative) { FkFail 'failed' }
  if (-not [Fremkit.Audio]::Mute($muted)) { FkFail 'no-device' }
  $true
}

function FkBattery {
  $internal = $null
  $battery = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $battery) {
    # BatteryStatus 6-9 are the charging states; many laptops report 2 ("on AC") while charging,
    # which root\wmi's BatteryStatus.Charging gets right where it exists.
    $status = [int]$battery.BatteryStatus
    $charging = $status -ge 6 -and $status -le 9
    try {
      $wmi = Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus -ErrorAction Stop | Select-Object -First 1
      if ($null -ne $wmi) { $charging = [bool]$wmi.Charging }
    } catch { }
    $internal = [ordered]@{ percent = [int]$battery.EstimatedChargeRemaining; charging = $charging }
    $run = $battery.EstimatedRunTime
    # 71582788 is "unknown"; the estimate means something only while on battery.
    if ($status -eq 1 -and $null -ne $run -and $run -gt 0 -and $run -lt 71582788) { $internal.minutesLeft = [int]$run }
  }
  $devices = @()
  $seen = @{}
  $nodes = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object {
    $_.InstanceId -like 'BTHENUM\*' -or $_.InstanceId -like 'BTHLE*' -or $_.InstanceId -like 'BTHHFENUM\*'
  })
  foreach ($node in $nodes) {
    $property = Get-PnpDeviceProperty -InstanceId $node.InstanceId -KeyName '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2' -ErrorAction SilentlyContinue
    if ($null -eq $property -or $null -eq $property.Data) { continue }
    $name = [string]$node.FriendlyName
    if ($name -eq '' -or $seen.ContainsKey($name)) { continue }
    $seen[$name] = $true
    $devices += [ordered]@{ name = $name; percent = [int]$property.Data }
  }
  [ordered]@{ internal = $internal; devices = @($devices) }
}

function FkWifi {
  $result = FkRunTool (Join-Path $FkSystemRoot 'System32\netsh.exe') 'wlan show interfaces' $null 4000
  # Windows 11 24H2 refuses WLAN details without location access; its message links the setting.
  if ($result.out -match 'ms-settings:privacy-location') { FkFail 'location-denied' }
  if ($result.exit -ne 0) { FkFail 'no-wifi' }
  $ssid = $null
  $signal = $null
  $fields = 0
  foreach ($line in ($result.out -split "`r?`n")) {
    if ($line -match '^\s+\S[^:]*?\s:\s') { $fields++ }
    if ($null -eq $ssid -and $line -match '^\s*SSID\s+:\s?(.*?)\s*$') { $ssid = $Matches[1] }
    if ($null -eq $signal -and $line -match '^\s*\S+\s+:\s*(\d{1,3})\s*%\s*$') { $signal = [int]$Matches[1] }
  }
  if ($fields -eq 0) { FkFail 'no-wifi' }
  if ($ssid -eq '') { $ssid = $null }
  [ordered]@{ ssid = $ssid; signal = $signal }
}

function FkSound($arg) {
  if ($arg -isnot [string] -or $FkSounds -cnotcontains $arg) { FkFail 'invalid-arg' }
  $path = Join-Path $FkSystemRoot "Media\$arg.wav"
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { FkFail 'no-sound' }
  # Kept in script scope: Play() returns at once and the player must outlive this call.
  $script:FkPlayer = New-Object System.Media.SoundPlayer $path
  $script:FkPlayer.Play()
  $true
}

function FkDpapi($arg, [bool]$protect) {
  if ($arg -isnot [string] -or $arg.Length -gt 90000) { FkFail 'invalid-arg' }
  try { $bytes = [Convert]::FromBase64String($arg) } catch { FkFail 'invalid-arg' }
  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  try {
    if ($protect) { $out = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope) }
    else { $out = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope) }
  } catch {
    FkFail 'dpapi-failed'
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
  $encoded = [Convert]::ToBase64String($out)
  [Array]::Clear($out, 0, $out.Length)
  $encoded
}

function FkWslList {
  $wsl = Join-Path $FkSystemRoot 'System32\wsl.exe'
  if (-not (Test-Path -LiteralPath $wsl -PathType Leaf)) { FkFail 'no-wsl' }
  # wsl.exe writes UTF-16LE (unless WSL_UTF8 is set, which FkRunTool removes).
  $result = FkRunTool $wsl '--list --quiet' ([System.Text.Encoding]::Unicode) 4000
  if ($result.exit -ne 0) { FkFail 'no-wsl' }
  foreach ($line in ($result.out -split "`r?`n")) {
    $name = $line.Trim([char]0, ' ', "`t")
    if ($name -cmatch '^[A-Za-z0-9._-]{1,64}$') { $name }
  }
}

FkSend ([ordered]@{ ready = $true })

while ($true) {
  $line = $FkIn.ReadLine()
  if ($null -eq $line) { break }
  try { $request = ConvertFrom-Json -InputObject $line } catch { continue }
  if ($request -isnot [System.Management.Automation.PSCustomObject]) { continue }
  $id = $request.id
  if ($id -isnot [int] -and $id -isnot [long]) { continue }
  $arg = $request.arg
  try {
    $value = $null
    switch -CaseSensitive -Exact ([string]$request.op) {
      'clipboard.read' { $value = FkClipboardRead; break }
      'clipboard.write' { $value = FkClipboardWrite $arg; break }
      'clipboard.private' { $value = @(FkClipboardPrivate); break }
      'volume.get' { $value = FkVolumeGet; break }
      'volume.set' { $value = FkVolumeSet $arg; break }
      'volume.mute' { $value = FkVolumeMute $arg; break }
      'battery' { $value = FkBattery; break }
      'network.wifi' { $value = FkWifi; break }
      'sound' { $value = FkSound $arg; break }
      'dpapi.protect' { $value = FkDpapi $arg $true; break }
      'dpapi.unprotect' { $value = FkDpapi $arg $false; break }
      'wsl.list' { $value = @(FkWslList); break }
      default { FkFail 'unknown-op' }
    }
    FkSend ([ordered]@{ id = $id; ok = $true; value = $value })
  } catch {
    $code = 'failed'
    if ($_.Exception.Message -cmatch '^fremkit:([a-z][a-z0-9-]{0,39})$') { $code = $Matches[1] }
    FkSend ([ordered]@{ id = $id; ok = $false; code = $code })
  }
  $value = $null
}
