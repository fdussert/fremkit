# Fremkit's Windows host: answers the server's Windows system calls (server/src/win/powershell-host.ts).
#
# Started once by the server with `powershell.exe ... -Command -`; this script arrives on stdin as a
# single base64 line, never as a path or an argument. Then one JSON line per request on stdin,
# {"id":n,"op":"...","arg":...}, and one JSON line per answer on stdout,
# {"id":n,"ok":true,"value":...} or {"id":n,"ok":false,"code":"..."}. Both directions are ASCII
# (\uXXXX escapes), so no console code page mangles clipboard text or a distro name.
#
# THE RULE: no cmdlet ever receives a value from a request, or a secret, as a parameter or on its
# pipeline. Module Logging (event 4103, turned on by policy) records cmdlet parameter bindings, so
# a DPAPI value passed to ConvertTo-Json or clipboard text passed to Set-Clipboard would land in
# the event log. Requests are parsed, answers written, the clipboard read and written and DPAPI
# called through the C# below (method calls, which nothing logs); the script's own functions
# receive only the non-secret args of volume and sound, and pass them on to .NET only. The same
# goes for what identifies someone: the batteries and the Bluetooth devices (whose instance ids
# carry their address) are read in C#, and no cmdlet is fed a pipeline of objects, since Module
# Logging records what a cmdlet is given and what it returns.
#
# A failure answers a short code and nothing else: no exception text, no path, no value. Every arg
# is type-checked here before use, whatever the server already checked. A line that does not
# parse answers `bad-request` when its leading `{"id":<n>,` can still be read, and is ignored
# otherwise (as is a request whose id is not a non-negative integer); the server's own timer then
# fails that call.
#
#   op                 arg                      value                                       codes
#   clipboard.read     -                        string ('' when it holds no text)           busy, too-large (> 1 MiB chars), private
#                                                    (the copying app asked not to be recorded, checked while the clipboard is open; the text is never returned)
#   clipboard.write    { text: string }         true (text up to 1 MiB chars; '' empties)   busy
#   clipboard.private  -                        [] or ['private'] (held open elsewhere: ['private'])
#   volume.get         -                        { level: 0-100, muted: bool }               no-device
#   volume.set         { level: number }        true (clamped to 0-100)                     no-device
#   volume.mute        { muted: bool }          true                                        no-device
#   battery            -                        { internal: null | { percent, charging,     -
#                                                   minutesLeft? }, devices: [{ name, percent }] }
#   network.wifi       -                        { ssid: string|null, signal: 0-100|null }   no-wifi, location-denied, tool-timeout
#   network.default    -                        null | { name, kind: 'wifi'|'ethernet'|'other', -
#                                                   ip4: string|null, rx, tx } (the default route's adapter, its byte counters)
#   sound              'chimes'|'chord'|'ding'|'notify'|'tada'   true                       no-sound
#   dpapi.protect      base64 (<= 90000 chars)  base64 (CurrentUser scope)                  dpapi-failed
#   dpapi.unprotect    base64 (<= 90000 chars)  base64                                      dpapi-foreign (never opens here:
#                                                   another user or machine, altered), dpapi-failed (may pass)
#   wsl.list           -                        [names matching ^[A-Za-z0-9._-]{1,64}$]     no-wsl, tool-timeout
#   memory             -                        { total, available, swapTotal, swapUsed }   -
#                                                   (bytes, GlobalMemoryStatusEx; swap is the commit charge past RAM)
#   drives             -                        [{ mount: 'C:', network: bool, size, available }]  -
#                                                   (fixed and mapped network drives that answer within the call; bytes)
#   processes          -                        [{ pid, name, cpuMs: number|null, ws }]     -
#                                                   (total CPU time in ms, null when the process cannot be opened; working set in bytes)
#
# Common codes: invalid-arg, unknown-op, bad-request, failed (anything unexpected).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$FkSystemRoot = 'C:\Windows'
if ($env:SystemRoot -match '^[A-Za-z]:\\') { $FkSystemRoot = $env:SystemRoot.TrimEnd('\') }

$FkSounds = @('chimes', 'chord', 'ding', 'notify', 'tada')
$FkPlayer = $null

# The wire is needed for everything: without it the host cannot even answer, so a failed compile
# ends the script and the server sees `host-exited`.
Add-Type -ReferencedAssemblies System.Web.Extensions, System.Security, System.Management -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace Fremkit {
  // A failure the script answers as its code, never with any other text.
  public class CodeException : Exception {
    public CodeException(string code) : base("fremkit:" + code) { }
  }

  public static class Wire {
    static readonly StreamWriter Out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
    static readonly StreamReader In = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024, RecursionLimit = 16 };
    static readonly Regex LeadingId = new Regex("^\\{\"id\":([0-9]{1,15})[,}]");

    public static string ReadLine() { return In.ReadLine(); }

    // The request as a dictionary, or null when the line is not a JSON object.
    public static IDictionary<string, object> Parse(string line) {
      try { return Json.DeserializeObject(line) as IDictionary<string, object>; } catch { return null; }
    }

    // The request's id, read from the parsed object or, failing that, from the line's start; -1 if none.
    public static long Id(IDictionary<string, object> request, string line) {
      if (request != null) {
        object id;
        if (!request.TryGetValue("id", out id)) return -1;
        if (id is int && (int)id >= 0) return (int)id;
        if (id is long && (long)id >= 0) return (long)id;
        return -1;
      }
      Match match = LeadingId.Match(line);
      return match.Success ? long.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture) : -1;
    }

    public static object Get(IDictionary<string, object> dictionary, string key) {
      object value;
      return dictionary != null && dictionary.TryGetValue(key, out value) ? value : null;
    }

    // A named field of an object arg; invalid-arg when the arg is not an object or lacks it.
    public static object Prop(object arg, string key) {
      IDictionary<string, object> dictionary = arg as IDictionary<string, object>;
      object value;
      if (dictionary == null || !dictionary.TryGetValue(key, out value)) throw new CodeException("invalid-arg");
      return value;
    }

    public static string CodeOf(Exception error) {
      for (Exception e = error; e != null; e = e.InnerException) {
        Match match = Regex.Match(e.Message, "^fremkit:([a-z][a-z0-9-]{0,39})$");
        if (match.Success) return match.Groups[1].Value;
      }
      return "failed";
    }

    public static void Send(object message) {
      StringBuilder line = new StringBuilder();
      Write(line, message, 0);
      Out.WriteLine(line.ToString());
    }

    // JSON in printable ASCII only: everything else is a \uXXXX escape.
    static void Write(StringBuilder s, object v, int depth) {
      if (depth > 16) throw new CodeException("failed");
      System.Management.Automation.PSObject wrapped = v as System.Management.Automation.PSObject;
      if (wrapped != null) v = wrapped.BaseObject;
      if (v == null) { s.Append("null"); return; }
      if (v is bool) { s.Append((bool)v ? "true" : "false"); return; }
      if (v is string) { WriteString(s, (string)v); return; }
      if (v is int || v is long || v is short || v is byte || v is uint || v is ulong || v is decimal) {
        s.Append(Convert.ToString(v, CultureInfo.InvariantCulture)); return;
      }
      if (v is double || v is float) {
        double d = Convert.ToDouble(v, CultureInfo.InvariantCulture);
        s.Append(double.IsNaN(d) || double.IsInfinity(d) ? "null" : d.ToString("R", CultureInfo.InvariantCulture)); return;
      }
      IDictionary map = v as IDictionary;
      if (map != null) {
        s.Append('{');
        bool first = true;
        foreach (DictionaryEntry entry in map) {
          if (!first) s.Append(',');
          first = false;
          WriteString(s, Convert.ToString(entry.Key, CultureInfo.InvariantCulture));
          s.Append(':');
          Write(s, entry.Value, depth + 1);
        }
        s.Append('}');
        return;
      }
      IEnumerable list = v as IEnumerable;
      if (list != null) {
        s.Append('[');
        bool first = true;
        foreach (object item in list) {
          if (!first) s.Append(',');
          first = false;
          Write(s, item, depth + 1);
        }
        s.Append(']');
        return;
      }
      throw new CodeException("failed");
    }

    static void WriteString(StringBuilder s, string text) {
      s.Append('"');
      foreach (char c in text) {
        if (c == '"') s.Append("\\\"");
        else if (c == '\\') s.Append("\\\\");
        else if (c < 0x20 || c > 0x7e) s.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
        else s.Append(c);
      }
      s.Append('"');
    }
  }

  public static class Dpapi {
    // What Unprotect answers for a blob this user on this machine will never open, checked in the
    // VM: NTE_BAD_KEY_STATE, its master key is not this user's (another user or machine, measured by
    // altering the blob's master key id); ERROR_INVALID_DATA, altered data or another entropy;
    // E_INVALIDARG, a truncated or empty blob; NTE_BAD_DATA, bad data at the provider.
    static readonly int[] Foreign = { unchecked((int)0x8009000B), unchecked((int)0x8007000D), unchecked((int)0x80070057), unchecked((int)0x80090005) };

    static bool IsForeign(int hresult) { return Array.IndexOf(Foreign, hresult) >= 0; }

    public static string Run(object arg, bool protect) {
      string text = arg as string;
      if (text == null || text.Length > 90000) throw new CodeException("invalid-arg");
      byte[] input;
      try { input = Convert.FromBase64String(text); } catch (FormatException) { throw new CodeException("invalid-arg"); }
      byte[] output = null;
      try {
        output = protect
          ? ProtectedData.Protect(input, null, DataProtectionScope.CurrentUser)
          : ProtectedData.Unprotect(input, null, DataProtectionScope.CurrentUser);
        return Convert.ToBase64String(output);
      } catch (CryptographicException e) {
        // Only an unprotect can meet a blob that will never open here; everything else (a profile
        // not loaded, the master key out of reach) may pass, and is answered as such.
        throw new CodeException(!protect && IsForeign(e.HResult) ? "dpapi-foreign" : "dpapi-failed");
      } finally {
        Array.Clear(input, 0, input.Length);
        if (output != null) Array.Clear(output, 0, output.Length);
      }
    }
  }

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
    const uint CF_UNICODETEXT = 13;
    const uint GMEM_MOVEABLE = 0x0002;
    public const int MaxChars = 1048576;

    [DllImport("user32.dll", SetLastError = true)] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] static extern bool CloseClipboard();
    [DllImport("user32.dll")] static extern bool EmptyClipboard();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterClipboardFormat(string name);
    [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint format, IntPtr memory);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateWindowEx(int exStyle, string className, string name, int style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr memory);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr memory);

    // SetClipboardData fails after EmptyClipboard when the clipboard was opened with no owner, so a
    // write opens it with a message-only window, made for that write and destroyed after it. A
    // window left owning the clipboard would stall the next app that copies: EmptyClipboard sends
    // the owner WM_DESTROYCLIPBOARD, and this thread pumps no messages while it waits on stdin.
    static IntPtr NewOwner() {
      return CreateWindowEx(0, "STATIC", "", 0, 0, 0, 0, 0, new IntPtr(-3), IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    }

    static void Open(IntPtr window) {
      for (int i = 0; i < 10; i++) {
        if (OpenClipboard(window)) return;
        Thread.Sleep(20);
      }
      throw new CodeException("busy");
    }

    public static string Read() {
      if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) return "";
      Open(IntPtr.Zero);
      try {
        // Checked while the clipboard is held open, so the text read is the text checked: a copy
        // landing between a separate check and this read cannot slip a password through. Any
        // failure of the check answers private too.
        bool concealed;
        try { concealed = PrivateOpen(); } catch (Exception) { concealed = true; }
        if (concealed) throw new CodeException("private");
        IntPtr memory = GetClipboardData(CF_UNICODETEXT);
        if (memory == IntPtr.Zero) return "";
        IntPtr data = GlobalLock(memory);
        if (data == IntPtr.Zero) return "";
        try {
          // Bounded by the allocation: another app's text need not end with a NUL.
          ulong chars = GlobalSize(memory).ToUInt64() / 2;
          string text = Marshal.PtrToStringUni(data, (int)Math.Min(chars, (ulong)MaxChars + 1));
          int end = text.IndexOf('\0');
          if (end >= 0) text = text.Substring(0, end);
          if (text.Length > MaxChars) throw new CodeException("too-large");
          return text;
        } finally { GlobalUnlock(memory); }
      } finally { CloseClipboard(); }
    }

    public static bool Write(object arg) {
      string text = Wire.Prop(arg, "text") as string;
      if (text == null || text.Length > MaxChars) throw new CodeException("invalid-arg");
      // Without an owner the write would fail after emptying the user's clipboard: refuse first.
      IntPtr window = NewOwner();
      if (window == IntPtr.Zero) throw new CodeException("failed");
      try {
        Put(window, text);
      } finally {
        DestroyWindow(window);
      }
      return true;
    }

    static void Put(IntPtr window, string text) {
      Open(window);
      try {
        if (!EmptyClipboard()) throw new CodeException("busy");
        if (text.Length == 0) return;
        IntPtr memory = GlobalAlloc(GMEM_MOVEABLE, new UIntPtr((ulong)(text.Length + 1) * 2));
        if (memory == IntPtr.Zero) throw new CodeException("failed");
        IntPtr data = GlobalLock(memory);
        if (data == IntPtr.Zero) { GlobalFree(memory); throw new CodeException("failed"); }
        bool copied = false;
        try {
          Marshal.Copy(text.ToCharArray(), 0, data, text.Length);
          Marshal.WriteInt16(data, text.Length * 2, 0);
          copied = true;
        } finally {
          GlobalUnlock(memory);
          if (!copied) GlobalFree(memory);
        }
        // The system owns the memory once SetClipboardData succeeds, and not before.
        if (SetClipboardData(CF_UNICODETEXT, memory) == IntPtr.Zero) { GlobalFree(memory); throw new CodeException("failed"); }
      } finally { CloseClipboard(); }
    }

    // True when the copying app asked clipboard watchers to look away. Needs the clipboard open.
    static bool PrivateOpen() {
      if (IsClipboardFormatAvailable(RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing"))) return true;
      if (IsClipboardFormatAvailable(RegisterClipboardFormat("Clipboard Viewer Ignore"))) return true;
      uint history = RegisterClipboardFormat("CanIncludeInClipboardHistory");
      if (!IsClipboardFormatAvailable(history)) return false;
      IntPtr memory = GetClipboardData(history);
      if (memory == IntPtr.Zero) return false;
      IntPtr data = GlobalLock(memory);
      if (data == IntPtr.Zero) return false;
      try { return GlobalSize(memory).ToUInt64() >= 4 && Marshal.ReadInt32(data) == 0; }
      finally { GlobalUnlock(memory); }
    }

    // 1 when the copying app asked clipboard watchers to look away, 0 otherwise, -1 when busy.
    public static int IsPrivate() {
      if (IsClipboardFormatAvailable(RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing"))) return 1;
      if (IsClipboardFormatAvailable(RegisterClipboardFormat("Clipboard Viewer Ignore"))) return 1;
      if (!IsClipboardFormatAvailable(RegisterClipboardFormat("CanIncludeInClipboardHistory"))) return 0;
      try { Open(IntPtr.Zero); } catch (CodeException) { return -1; }
      try { return PrivateOpen() ? 1 : 0; }
      catch (Exception) { return 1; }
      finally { CloseClipboard(); }
    }
  }

  // The internal battery, through WMI from here rather than Get-CimInstance: Module Logging would
  // record the objects a cmdlet returns, battery names included.
  public static class Power {
    // { percent, charging, minutesLeft? }, or null without an internal battery. A failing WMI
    // query (a COMException, access denied) also answers null: it must cost the internal battery
    // and not the Bluetooth devices answered beside it.
    public static System.Collections.Specialized.OrderedDictionary Internal() {
      try {
        using (System.Management.ManagementObjectSearcher searcher = new System.Management.ManagementObjectSearcher(
            "root\\CIMV2", "SELECT BatteryStatus, EstimatedChargeRemaining, EstimatedRunTime FROM Win32_Battery")) {
          foreach (System.Management.ManagementBaseObject battery in searcher.Get()) {
            int status = Number(battery["BatteryStatus"]);
            // BatteryStatus 6-9 are the charging states; many laptops report 2 ("on AC") while
            // charging, which root\WMI's BatteryStatus.Charging gets right where it exists.
            bool charging = status >= 6 && status <= 9;
            bool? wmi = Charging();
            if (wmi.HasValue) charging = wmi.Value;
            System.Collections.Specialized.OrderedDictionary result = new System.Collections.Specialized.OrderedDictionary();
            result["percent"] = Math.Max(0, Math.Min(100, Number(battery["EstimatedChargeRemaining"])));
            result["charging"] = charging;
            long run = Number(battery["EstimatedRunTime"]);
            // 71582788 is "unknown"; the estimate means something only while on battery.
            if (status == 1 && run > 0 && run < 71582788) result["minutesLeft"] = (int)run;
            return result;
          }
        }
      } catch (Exception) { }
      return null;
    }

    static bool? Charging() {
      try {
        using (System.Management.ManagementObjectSearcher searcher = new System.Management.ManagementObjectSearcher(
            "root\\WMI", "SELECT Charging FROM BatteryStatus")) {
          foreach (System.Management.ManagementBaseObject status in searcher.Get()) {
            object charging = status["Charging"];
            if (charging is bool) return (bool)charging;
          }
        }
      } catch (Exception) { }
      return null;
    }

    static int Number(object value) {
      return value == null ? -1 : (int)Math.Min(int.MaxValue, Convert.ToInt64(value, CultureInfo.InvariantCulture));
    }
  }

  // Bluetooth devices that report a battery level, read with SetupAPI. Not with Get-PnpDevice:
  // Module Logging would record every device's instance id (it carries the device's address) and
  // name as cmdlet parameters.
  public static class Bluetooth {
    [StructLayout(LayoutKind.Sequential)]
    struct DeviceInfo { public int Size; public Guid ClassGuid; public int DevInst; public IntPtr Reserved; }

    [StructLayout(LayoutKind.Sequential)]
    struct PropertyKey {
      public Guid Format; public int Id;
      public PropertyKey(string format, int id) { Format = new Guid(format); Id = id; }
    }

    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr SetupDiGetClassDevs(IntPtr classGuid, string enumerator, IntPtr parent, int flags);
    [DllImport("setupapi.dll", SetLastError = true)]
    static extern bool SetupDiEnumDeviceInfo(IntPtr set, int index, ref DeviceInfo info);
    [DllImport("setupapi.dll", SetLastError = true)]
    static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool SetupDiGetDeviceInstanceId(IntPtr set, ref DeviceInfo info, StringBuilder id, int size, out int required);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool SetupDiGetDeviceProperty(IntPtr set, ref DeviceInfo info, ref PropertyKey key, out int type, byte[] buffer, int size, out int required, int flags);

    const int DIGCF_PRESENT = 0x2, DIGCF_ALLCLASSES = 0x4;
    const int DEVPROP_TYPE_BYTE = 0x3, DEVPROP_TYPE_STRING = 0x12;
    static readonly string[] Prefixes = { "BTHENUM\\", "BTHLE", "BTHHFENUM\\" };
    static PropertyKey BatteryLevel = new PropertyKey("104EA319-6EE2-4701-BD47-8DDBF425BBE5", 2);
    static PropertyKey FriendlyName = new PropertyKey("A45C254E-DF1C-4EFD-8020-67D146A850E0", 14);
    static PropertyKey DeviceDesc = new PropertyKey("A45C254E-DF1C-4EFD-8020-67D146A850E0", 2);

    // [{ name, percent }], one per name.
    public static ArrayList Levels() {
      ArrayList devices = new ArrayList();
      HashSet<string> seen = new HashSet<string>();
      IntPtr set = SetupDiGetClassDevs(IntPtr.Zero, null, IntPtr.Zero, DIGCF_PRESENT | DIGCF_ALLCLASSES);
      if (set == new IntPtr(-1)) return devices;
      try {
        DeviceInfo info = new DeviceInfo();
        info.Size = Marshal.SizeOf(typeof(DeviceInfo));
        StringBuilder id = new StringBuilder(512);
        for (int i = 0; SetupDiEnumDeviceInfo(set, i, ref info); i++) {
          int required;
          if (!SetupDiGetDeviceInstanceId(set, ref info, id, id.Capacity, out required)) continue;
          string instance = id.ToString();
          bool bluetooth = false;
          foreach (string prefix in Prefixes) {
            if (instance.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) { bluetooth = true; break; }
          }
          if (!bluetooth) continue;
          byte[] level = Property(set, ref info, BatteryLevel, DEVPROP_TYPE_BYTE);
          if (level == null || level.Length < 1) continue;
          string name = Text(Property(set, ref info, FriendlyName, DEVPROP_TYPE_STRING)) ?? Text(Property(set, ref info, DeviceDesc, DEVPROP_TYPE_STRING));
          if (string.IsNullOrEmpty(name) || !seen.Add(name)) continue;
          System.Collections.Specialized.OrderedDictionary device = new System.Collections.Specialized.OrderedDictionary();
          device["name"] = name;
          device["percent"] = Math.Min(100, (int)level[0]);
          devices.Add(device);
        }
      } finally {
        SetupDiDestroyDeviceInfoList(set);
      }
      return devices;
    }

    static byte[] Property(IntPtr set, ref DeviceInfo info, PropertyKey key, int expected) {
      byte[] buffer = new byte[1024];
      int type, required;
      if (!SetupDiGetDeviceProperty(set, ref info, ref key, out type, buffer, buffer.Length, out required, 0)) return null;
      if (type != expected || required > buffer.Length) return null;
      Array.Resize(ref buffer, required);
      return buffer;
    }

    static string Text(byte[] bytes) {
      if (bytes == null) return null;
      string text = Encoding.Unicode.GetString(bytes).TrimEnd('\0').Trim();
      return text.Length == 0 ? null : text;
    }
  }

  public static class Route {
    [DllImport("iphlpapi.dll")]
    static extern int GetBestInterface(uint destAddr, out uint bestIfIndex);

    // The adapter the IPv4 default route goes out of, as { name, kind, ip4, rx, tx }, or null when
    // there is no default route. `name` is the adapter's friendly name, the key Node's
    // os.networkInterfaces() uses ("Ethernet", "Wi-Fi"). The route table answers the lookup for
    // 0.0.0.0 with the default route alone; nothing is run and no cmdlet sees anything.
    public static System.Collections.Specialized.OrderedDictionary Default() {
      uint index;
      if (GetBestInterface(0, out index) != 0) return null;
      foreach (System.Net.NetworkInformation.NetworkInterface adapter in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces()) {
        System.Net.NetworkInformation.IPInterfaceProperties properties;
        System.Net.NetworkInformation.IPv4InterfaceProperties v4;
        try {
          properties = adapter.GetIPProperties();
          v4 = properties.GetIPv4Properties();
        } catch (Exception) { continue; }
        if (v4 == null || (uint)v4.Index != index) continue;
        string ip4 = null;
        foreach (System.Net.NetworkInformation.UnicastIPAddressInformation address in properties.UnicastAddresses) {
          if (address.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork) { ip4 = address.Address.ToString(); break; }
        }
        System.Net.NetworkInformation.IPInterfaceStatistics counters = adapter.GetIPStatistics();
        System.Collections.Specialized.OrderedDictionary result = new System.Collections.Specialized.OrderedDictionary();
        result["name"] = adapter.Name;
        result["kind"] = Kind(adapter.NetworkInterfaceType);
        result["ip4"] = ip4;
        result["rx"] = counters.BytesReceived;
        result["tx"] = counters.BytesSent;
        return result;
      }
      return null;
    }

    static string Kind(System.Net.NetworkInformation.NetworkInterfaceType type) {
      switch (type) {
        case System.Net.NetworkInformation.NetworkInterfaceType.Wireless80211: return "wifi";
        case System.Net.NetworkInformation.NetworkInterfaceType.Ethernet:
        case System.Net.NetworkInformation.NetworkInterfaceType.Ethernet3Megabit:
        case System.Net.NetworkInformation.NetworkInterfaceType.FastEthernetT:
        case System.Net.NetworkInformation.NetworkInterfaceType.FastEthernetFx:
        case System.Net.NetworkInformation.NetworkInterfaceType.GigabitEthernet: return "ethernet";
        default: return "other";
      }
    }
  }

  // Memory, drives and processes: what `systeminformation` would read through a powershell.exe of
  // its own on every poll. Nothing here takes an argument or runs a program.
  public static class Sys {
    [StructLayout(LayoutKind.Sequential)]
    class MemoryStatusEx {
      public uint dwLength = (uint)Marshal.SizeOf(typeof(MemoryStatusEx));
      public uint dwMemoryLoad;
      public ulong ullTotalPhys;
      public ulong ullAvailPhys;
      public ulong ullTotalPageFile;
      public ulong ullAvailPageFile;
      public ulong ullTotalVirtual;
      public ulong ullAvailVirtual;
      public ulong ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GlobalMemoryStatusEx([In, Out] MemoryStatusEx buffer);

    // RAM and swap in bytes. Windows has no swap total as such: the commit limit is RAM plus the
    // page files, so what lies past RAM is the page files' size, and the commit charge past what
    // RAM holds is what they hold.
    public static System.Collections.Specialized.OrderedDictionary Memory() {
      MemoryStatusEx status = new MemoryStatusEx();
      if (!GlobalMemoryStatusEx(status)) throw new CodeException("failed");
      ulong swapTotal = status.ullTotalPageFile > status.ullTotalPhys ? status.ullTotalPageFile - status.ullTotalPhys : 0;
      ulong committed = status.ullTotalPageFile - status.ullAvailPageFile;
      ulong inRam = status.ullTotalPhys - status.ullAvailPhys;
      ulong swapUsed = committed > inRam ? Math.Min(committed - inRam, swapTotal) : 0;
      System.Collections.Specialized.OrderedDictionary result = new System.Collections.Specialized.OrderedDictionary();
      result["total"] = status.ullTotalPhys;
      result["available"] = status.ullAvailPhys;
      result["swapTotal"] = swapTotal;
      result["swapUsed"] = swapUsed;
      return result;
    }

    // A disconnected mapped drive can hold a size query for many seconds. Each drive is read on
    // its own task and waited for briefly; one that does not answer is left out, and is not asked
    // again while its earlier query is still stuck.
    const int DRIVE_WAIT_MS = 1500;
    static readonly Dictionary<string, System.Threading.Tasks.Task<long[]>> Stuck = new Dictionary<string, System.Threading.Tasks.Task<long[]>>();

    public static ArrayList Drives() {
      ArrayList result = new ArrayList();
      DateTime deadline = DateTime.UtcNow.AddMilliseconds(DRIVE_WAIT_MS);
      foreach (DriveInfo drive in DriveInfo.GetDrives()) {
        DriveType type = drive.DriveType;
        if (type != DriveType.Fixed && type != DriveType.Network) continue;
        string mount = drive.Name.TrimEnd('\\');
        if (!Regex.IsMatch(mount, "^[A-Za-z]:$")) continue;
        System.Threading.Tasks.Task<long[]> query;
        if (Stuck.TryGetValue(mount, out query)) {
          if (!query.IsCompleted) continue;
          Stuck.Remove(mount);
        }
        DriveInfo captured = drive;
        query = System.Threading.Tasks.Task.Run(() => {
          if (!captured.IsReady) return null;
          return new long[] { captured.TotalSize, captured.TotalFreeSpace };
        });
        int wait = Math.Max(0, (int)(deadline - DateTime.UtcNow).TotalMilliseconds);
        bool done;
        try { done = query.Wait(wait); } catch { continue; }
        if (!done) { Stuck[mount] = query; continue; }
        long[] sizes = query.Result;
        if (sizes == null) continue;
        System.Collections.Specialized.OrderedDictionary entry = new System.Collections.Specialized.OrderedDictionary();
        entry["mount"] = mount;
        entry["network"] = type == DriveType.Network;
        entry["size"] = sizes[0];
        entry["available"] = sizes[1];
        result.Add(entry);
      }
      return result;
    }

    const int MAX_PROCESSES = 4096;

    // Every process as { pid, name, cpuMs, ws }. A process this account cannot open (the System
    // process, a protected service) still has a name and a working set; its CPU time is null.
    public static ArrayList Processes() {
      ArrayList result = new ArrayList();
      foreach (System.Diagnostics.Process process in System.Diagnostics.Process.GetProcesses()) {
        try {
          if (result.Count >= MAX_PROCESSES) continue;
          object cpu = null;
          try { cpu = (long)process.TotalProcessorTime.TotalMilliseconds; } catch { }
          long ws = 0;
          try { ws = process.WorkingSet64; } catch { }
          string name = null;
          try { name = process.ProcessName; } catch { }
          if (name == null) continue;
          System.Collections.Specialized.OrderedDictionary entry = new System.Collections.Specialized.OrderedDictionary();
          entry["pid"] = process.Id;
          entry["name"] = name;
          entry["cpuMs"] = cpu;
          entry["ws"] = ws;
          result.Add(entry);
        } finally {
          process.Dispose();
        }
      }
      return result;
    }
  }
}
'@

function FkFail([string]$code) { throw (New-Object Fremkit.CodeException $code) }

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

function FkClipboardPrivate {
  # A clipboard another app holds open is treated as private: better one missed entry than a leak.
  if ([Fremkit.Clipboard]::IsPrivate() -ne 0) { 'private' }
}

function FkVolumeGet {
  $state = [Fremkit.Audio]::Get()
  if ($null -eq $state) { FkFail 'no-device' }
  [ordered]@{ level = $state[0]; muted = ($state[1] -eq 1) }
}

function FkVolumeSet($arg) {
  $level = [Fremkit.Wire]::Prop($arg, 'level')
  if (-not (FkIsNumber $level) -or [double]::IsNaN([double]$level) -or [double]::IsInfinity([double]$level)) { FkFail 'invalid-arg' }
  $level = [int][Math]::Round([Math]::Max(0, [Math]::Min(100, [double]$level)))
  if (-not [Fremkit.Audio]::Set($level)) { FkFail 'no-device' }
  $true
}

function FkVolumeMute($arg) {
  $muted = [Fremkit.Wire]::Prop($arg, 'muted')
  if ($muted -isnot [bool]) { FkFail 'invalid-arg' }
  if (-not [Fremkit.Audio]::Mute($muted)) { FkFail 'no-device' }
  $true
}

function FkWifi {
  $netsh = Join-Path $FkSystemRoot 'System32\netsh.exe'
  $result = FkRunTool $netsh 'wlan show interfaces' $null 4000
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
  $path = [System.IO.Path]::Combine($FkSystemRoot, 'Media', "$arg.wav")
  if (-not [System.IO.File]::Exists($path)) { FkFail 'no-sound' }
  # Kept in script scope: Play() returns at once and the player must outlive this call.
  $script:FkPlayer = New-Object System.Media.SoundPlayer $path
  $script:FkPlayer.Play()
  $true
}

function FkWslList {
  $wsl = Join-Path $FkSystemRoot 'System32\wsl.exe'
  if (-not [System.IO.File]::Exists($wsl)) { FkFail 'no-wsl' }
  # wsl.exe writes UTF-16LE (unless WSL_UTF8 is set, which FkRunTool removes).
  $result = FkRunTool $wsl '--list --quiet' ([System.Text.Encoding]::Unicode) 4000
  if ($result.exit -ne 0) { FkFail 'no-wsl' }
  foreach ($line in ($result.out -split "`r?`n")) {
    $name = $line.Trim([char]0, ' ', "`t")
    if ($name -cmatch '^[A-Za-z0-9._-]{1,64}$') { $name }
  }
}

[Fremkit.Wire]::Send([ordered]@{ ready = $true })

while ($true) {
  $line = [Fremkit.Wire]::ReadLine()
  if ($null -eq $line) { break }
  $request = [Fremkit.Wire]::Parse($line)
  $id = [Fremkit.Wire]::Id($request, $line)
  $line = $null
  if ($id -lt 0) { continue }
  if ($null -eq $request) {
    [Fremkit.Wire]::Send([ordered]@{ id = $id; ok = $false; code = 'bad-request' })
    continue
  }
  $arg = [Fremkit.Wire]::Get($request, 'arg')
  $op = [Fremkit.Wire]::Get($request, 'op')
  $request = $null
  try {
    $value = $null
    switch -CaseSensitive -Exact ([string]$op) {
      'clipboard.read' { $value = [Fremkit.Clipboard]::Read(); break }
      'clipboard.write' { $value = [Fremkit.Clipboard]::Write($arg); break }
      'clipboard.private' { $value = @(FkClipboardPrivate); break }
      'volume.get' { $value = FkVolumeGet; break }
      'volume.set' { $value = FkVolumeSet $arg; break }
      'volume.mute' { $value = FkVolumeMute $arg; break }
      'battery' { $value = [ordered]@{ internal = [Fremkit.Power]::Internal(); devices = [Fremkit.Bluetooth]::Levels() }; break }
      'network.wifi' { $value = FkWifi; break }
      'network.default' { $value = [Fremkit.Route]::Default(); break }
      'sound' { $value = FkSound $arg; break }
      'dpapi.protect' { $value = [Fremkit.Dpapi]::Run($arg, $true); break }
      'dpapi.unprotect' { $value = [Fremkit.Dpapi]::Run($arg, $false); break }
      'wsl.list' { $value = @(FkWslList); break }
      'memory' { $value = [Fremkit.Sys]::Memory(); break }
      'drives' { $value = [Fremkit.Sys]::Drives(); break }
      'processes' { $value = [Fremkit.Sys]::Processes(); break }
      default { FkFail 'unknown-op' }
    }
    [Fremkit.Wire]::Send([ordered]@{ id = $id; ok = $true; value = $value })
  } catch {
    [Fremkit.Wire]::Send([ordered]@{ id = $id; ok = $false; code = [Fremkit.Wire]::CodeOf($_.Exception) })
  }
  $value = $null
  $arg = $null
}
