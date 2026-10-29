[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$PipeName,[Parameter(Mandatory=$true)][int]$ParentPid,[int]$QualificationDelayMs=0)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
function Write-StartupFailure([string]$Code,[int]$NativeError=0) {
  $text='{"code":"'+$Code+'","nativeError":'+$NativeError+',"schema":"trigger-fork-native-startup-error/v1"}'
  $body=[Text.Encoding]::UTF8.GetBytes($text);$prefix=[BitConverter]::GetBytes([int]$body.Length)
  $output=[Console]::OpenStandardOutput();$output.Write($prefix,0,4);$output.Write($body,0,$body.Length);$output.Flush()
}
try {
  # .NET Framework delegates this documented special-folder lookup to Windows,
  # not inherited LOCALAPPDATA. Reject before CodeDom/temp compilation.
  $trustedLocal=[IO.Path]::GetFullPath([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)).TrimEnd('\')
  if(-not [string]::Equals([IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\'),$trustedLocal,[StringComparison]::OrdinalIgnoreCase)){Write-StartupFailure 'NATIVE_KNOWN_FOLDER_ENV_MISMATCH';exit 3}
  $approved=[IO.Path]::GetFullPath((Join-Path $trustedLocal 'Temp\opencode')).TrimEnd('\')
  $resolved=[IO.Path]::GetFullPath($Root).TrimEnd('\')
  if(-not $resolved.StartsWith($approved+'\',[StringComparison]::OrdinalIgnoreCase) -or -not [IO.Directory]::Exists($resolved)){Write-StartupFailure 'NATIVE_ROOT_REFUSED';exit 3}
  $current=[IO.DirectoryInfo]$resolved
  while($null -ne $current){if(($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){Write-StartupFailure 'NATIVE_REPARSE_ANCESTOR';exit 3};$current=$current.Parent}
  if($QualificationDelayMs -lt 0 -or $QualificationDelayMs -gt 2000){throw 'DELAY'}
  $env:TEMP=$resolved;$env:TMP=$resolved
  $source=@'
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public sealed class EpochNativeFailure:Exception {
 public readonly string Code; public readonly long NativeError;
 public EpochNativeFailure(string code,long nativeError=0){Code=code;NativeError=nativeError;}
}
public static class EpochNativeHost {
 const int MAX=1100000; const long SAFE=9007199254740991L;
 const uint READ=0x80000000,WRITE=0x40000000,ATTR=0x80,BACKUP=0x02000000,REPARSE=0x00200000;
 static readonly IntPtr INVALID=new IntPtr(-1);
 [StructLayout(LayoutKind.Sequential)] struct FT {public uint Low,High; public ulong Value {get{return ((ulong)High<<32)|Low;}}}
 [StructLayout(LayoutKind.Sequential)] struct INFO {public uint Attributes; public FT Creation,Access,Write;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
 [StructLayout(LayoutKind.Sequential)] struct PBI {public IntPtr Reserved1,Peb,Reserved2a,Reserved2b,UniquePid,ParentPid;}
 [StructLayout(LayoutKind.Sequential)] struct SA {public int Length;public IntPtr Descriptor;public int Inherit;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string p,uint access,uint share,IntPtr sa,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr h,out INFO info);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr h,StringBuilder b,uint count,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(IntPtr h,byte[] b,uint n,out uint written,IntPtr overlapped);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(IntPtr h,byte[] b,uint n,out uint read,IntPtr overlapped);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFilePointerEx(IntPtr h,long distance,out long position,uint method);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out FT c,out FT e,out FT k,out FT u);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h,int kind,out PBI p,int size,out int length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryPerformanceCounter(out long value);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryPerformanceFrequency(out long value);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateMutexW(IntPtr sa,bool own,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReleaseMutex(IntPtr h);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateNamedPipeW(string name,uint openMode,uint pipeMode,uint max,uint output,uint input,uint timeout,ref SA sa);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeClientProcessId(IntPtr h,out uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeServerProcessId(IntPtr h,out uint pid);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s,uint rev,out IntPtr p,out uint n);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {public long ProcessTime,JobTime;public uint Flags;public UIntPtr MinWorking,MaxWorking;public uint ActiveLimit;public UIntPtr Affinity;public uint Priority,Scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct IOCOUNT {public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes;}
 [StructLayout(LayoutKind.Sequential)] struct EXT_LIMIT {public BASIC_LIMIT Basic;public IOCOUNT IO;public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob;}
 [StructLayout(LayoutKind.Sequential)] struct ACCOUNT {public long User,Kernel,PeriodUser,PeriodKernel;public uint Faults,Total,Active,Terminated;}
 [StructLayout(LayoutKind.Sequential)] struct STARTUP {public uint cb;public IntPtr Reserved,Desktop,Title;public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;public ushort Show,ReservedBytes;public IntPtr ReservedPtr,StdIn,StdOut,StdErr;}
 [StructLayout(LayoutKind.Sequential)] struct STARTUP_EX {public STARTUP Basic;public IntPtr Attributes;}
 [StructLayout(LayoutKind.Sequential)] struct PROC {public IntPtr Process,Thread;public uint Pid,Tid;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr sa,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref EXT_LIMIT limits,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr info,uint size,out uint returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref UIntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,UIntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUP_EX startup,out PROC process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr process,uint flags,StringBuilder path,ref uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetStdHandle(int kind);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetConsoleMode(IntPtr h,out uint mode);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetConsoleProcessList([Out] uint[] ids,uint count);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNumberOfConsoleInputEvents(IntPtr h,out uint count);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool WriteConsoleW(IntPtr h,string text,uint count,out uint written,IntPtr reserved);
 [StructLayout(LayoutKind.Explicit,Size=20)] struct INPUT { [FieldOffset(0)]public ushort Type;[FieldOffset(4)]public int Down;[FieldOffset(8)]public ushort Repeat;[FieldOffset(10)]public ushort Key;[FieldOffset(14)]public char Character; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ReadConsoleInputExW(IntPtr h,[Out] INPUT[] events,uint count,out uint read,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ProcessIdToSessionId(uint pid,out uint session);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);
 [DllImport("kernel32.dll",CharSet=CharSet.Ansi,ExactSpelling=true)] static extern IntPtr GetProcAddress(IntPtr module,string name);
 [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern int SHGetKnownFolderPath(ref Guid folder,uint flags,IntPtr token,out IntPtr path);
 [StructLayout(LayoutKind.Sequential)] struct DISPOSITION {[MarshalAs(UnmanagedType.U1)]public bool Delete;}
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(IntPtr h,int kind,ref DISPOSITION info,uint size);
 static EpochNativeFailure Native(string code){return new EpochNativeFailure(code,Marshal.GetLastWin32Error());}
 static void Need(bool yes,string code){if(!yes)throw new EpochNativeFailure(code);}
 static Dictionary<string,object> D(params object[] values){var d=new Dictionary<string,object>(StringComparer.Ordinal);for(int i=0;i<values.Length;i+=2)d.Add((string)values[i],values[i+1]);return d;}
 static void Keys(Dictionary<string,object> d,params string[] keys){Need(d.Count==keys.Length,"NATIVE_COMMAND_INVALID");foreach(string k in keys)Need(d.ContainsKey(k),"NATIVE_COMMAND_INVALID");}
 static string S(Dictionary<string,object> d,string key,int max){object v;Need(d.TryGetValue(key,out v)&&v is string,"NATIVE_COMMAND_INVALID");string s=(string)v;Need(s.Length<=max,"NATIVE_COMMAND_INVALID");return s;}
 static long N(Dictionary<string,object> d,string key,long min,long max){object v;Need(d.TryGetValue(key,out v)&&v is long,"NATIVE_COMMAND_INVALID");long n=(long)v;Need(n>=min&&n<=max,"NATIVE_COMMAND_INVALID");return n;}
 static bool B(Dictionary<string,object> d,string key){object v;Need(d.TryGetValue(key,out v)&&v is bool,"NATIVE_COMMAND_INVALID");return (bool)v;}
 // Strict bounded canonical JSON; no JavaScriptSerializer duplicate-key coercion.
 sealed class Json {
  readonly string s;int i,nodes;Json(string text){s=text;}
   public static object Parse(string text){var p=new Json(text);object v=p.Value(0);Need(p.i==text.Length&&Write(v)==text,"NATIVE_PROTOCOL_INVALID");return v;}
   public static object ParseDocument(string text){var p=new Json(text);object v=p.Value(0);Need(p.i==text.Length,"NATIVE_PROTOCOL_INVALID");return v;}
  object Value(int depth){Need(depth<=12&&++nodes<=32768&&i<s.Length,"NATIVE_PROTOCOL_INVALID");char c=s[i];
   if(c=='"')return String();
   if(c=='{'){i++;var d=new Dictionary<string,object>(StringComparer.Ordinal);if(Take('}'))return d;do{Need(i<s.Length&&s[i]=='"',"NATIVE_PROTOCOL_INVALID");string k=String();Need(k!="__proto__"&&k!="constructor"&&k!="prototype"&&k!="toJSON"&&!d.ContainsKey(k)&&Take(':'),"NATIVE_PROTOCOL_INVALID");d.Add(k,Value(depth+1));Need(d.Count<=4096,"NATIVE_PROTOCOL_INVALID");if(Take('}'))return d;Need(Take(','),"NATIVE_PROTOCOL_INVALID");}while(true);}
   if(c=='['){i++;var a=new List<object>();if(Take(']'))return a;do{a.Add(Value(depth+1));Need(a.Count<=4096,"NATIVE_PROTOCOL_INVALID");if(Take(']'))return a;Need(Take(','),"NATIVE_PROTOCOL_INVALID");}while(true);}
   foreach(string literal in new[]{"true","false","null"})if(s.Substring(i).StartsWith(literal,StringComparison.Ordinal)){i+=literal.Length;return literal=="null"?null:(object)(literal=="true");}
   int start=i;if(c=='-')i++;Need(i<s.Length&&s[i]>='0'&&s[i]<='9',"NATIVE_PROTOCOL_INVALID");while(i<s.Length&&s[i]>='0'&&s[i]<='9')i++;long value;Need(long.TryParse(s.Substring(start,i-start),NumberStyles.AllowLeadingSign,CultureInfo.InvariantCulture,out value)&&value>=-SAFE&&value<=SAFE,"NATIVE_PROTOCOL_INVALID");return value;
  }
  bool Take(char c){if(i<s.Length&&s[i]==c){i++;return true;}return false;}
  string String(){Need(Take('"'),"NATIVE_PROTOCOL_INVALID");var b=new StringBuilder();while(i<s.Length){char c=s[i++];if(c=='"')return b.ToString();Need(c>=32,"NATIVE_PROTOCOL_INVALID");if(c!='\\'){b.Append(c);continue;}Need(i<s.Length,"NATIVE_PROTOCOL_INVALID");c=s[i++];switch(c){case '"':case '\\':case '/':b.Append(c);break;case 'b':b.Append('\b');break;case 'f':b.Append('\f');break;case 'n':b.Append('\n');break;case 'r':b.Append('\r');break;case 't':b.Append('\t');break;case 'u':Need(i+4<=s.Length,"NATIVE_PROTOCOL_INVALID");int u;Need(int.TryParse(s.Substring(i,4),NumberStyles.HexNumber,CultureInfo.InvariantCulture,out u),"NATIVE_PROTOCOL_INVALID");b.Append((char)u);i+=4;break;default:throw new EpochNativeFailure("NATIVE_PROTOCOL_INVALID");}}throw new EpochNativeFailure("NATIVE_PROTOCOL_INVALID");}
  public static string Write(object v){if(v==null)return "null";if(v is bool)return (bool)v?"true":"false";if(v is long||v is int||v is uint)return Convert.ToString(v,CultureInfo.InvariantCulture);if(v is string)return Quote((string)v);var d=v as Dictionary<string,object>;if(d!=null){var keys=new List<string>(d.Keys);keys.Sort(StringComparer.Ordinal);var a=new List<string>();foreach(string k in keys)a.Add(Quote(k)+":"+Write(d[k]));return "{"+string.Join(",",a.ToArray())+"}";}var list=v as List<object>;if(list!=null){var a=new List<string>();foreach(object x in list)a.Add(Write(x));return "["+string.Join(",",a.ToArray())+"]";}throw new EpochNativeFailure("NATIVE_PROTOCOL_INVALID");}
  static string Quote(string s){var b=new StringBuilder("\"");foreach(char c in s){switch(c){case '"':b.Append("\\\"");break;case '\\':b.Append("\\\\");break;case '\b':b.Append("\\b");break;case '\f':b.Append("\\f");break;case '\n':b.Append("\\n");break;case '\r':b.Append("\\r");break;case '\t':b.Append("\\t");break;default:if(c<32||char.IsSurrogate(c))b.Append("\\u"+((int)c).ToString("x4"));else b.Append(c);break;}}return b.Append('"').ToString();}
 }
 sealed class Lease {public IntPtr Handle;public string Path;public bool Readonly;public Dictionary<string,object> Identity;}
 static readonly Dictionary<string,Lease> files=new Dictionary<string,Lease>();
 static readonly List<IntPtr> directories=new List<IntPtr>();
 static IntPtr parent,mutex;static bool mutexOwned,abandoned,exiting;static string root,parentCreation,helperCreation;static uint parentPid,helperPid;static long frequency;static int delay;
 static NamedPipeServerStream pipe;static readonly ManualResetEvent stop=new ManualResetEvent(false);static Thread watcher;
 static Dictionary<string,object> rootIdentity;
 static string approvedBase,adoptedControllerToken,adoptedControllerMode;
 static string KnownApprovedBase(){Guid id=new Guid("F1B32785-6FBA-4FCF-9D55-7B8E7F157091");IntPtr value;int hr=SHGetKnownFolderPath(ref id,0,IntPtr.Zero,out value);if(hr!=0)throw new EpochNativeFailure("NATIVE_KNOWN_FOLDER_FAILED",unchecked((uint)hr));try{string local=Path.GetFullPath(Marshal.PtrToStringUni(value)).TrimEnd('\\');Need(string.Equals(Path.GetFullPath(Environment.GetEnvironmentVariable("LOCALAPPDATA")).TrimEnd('\\'),local,StringComparison.OrdinalIgnoreCase),"NATIVE_KNOWN_FOLDER_ENV_MISMATCH");return Path.Combine(local,"Temp","opencode");}finally{Marshal.FreeCoTaskMem(value);}}
 static object ServiceQuiescence(){lock(flightLock){if(qualificationJournalFault=="INJECTED_QUIESCENCE_UNKNOWN"){qualificationJournalFault=null;throw new EpochNativeFailure("NATIVE_INJECTED_QUIESCENCE_UNKNOWN");}if(flight==null)return D("treeZero",true,"basis","NO_NATIVE_FLIGHT_OR_VERIFIED_RELEASED_FLIGHT");Need(flight.Job!=IntPtr.Zero,"NATIVE_SERVICE_TREE_UNVERIFIED");CaptureMembers(flight);bool zero=Active(flight)==0&&HandlesExited(flight);return D("treeZero",zero,"basis","ACTUAL_JOB_ACCOUNTING_AND_OWNED_PROCESS_HANDLES");}}
 static void RequireServiceQuiescence(){var proof=(Dictionary<string,object>)ServiceQuiescence();Need((bool)proof["treeZero"],"NATIVE_SERVICE_TREE_NOT_QUIESCENT");}
 static string qualificationJournalFault;static bool qualificationJournalFaultUsed;
 static IntPtr ownerMutex,ownerSentinel,workspaceHandle;static bool ownerNamespaceOwned,ownerNamespaceAbandoned;static string workspace,ownerNamespaceDigest,ownerSentinelPath;
 static object OwnerNamespace(bool release){
  if(release){Need(ownerNamespaceOwned&&!ownerNamespaceAbandoned,"NATIVE_OWNER_NAMESPACE_NOT_OWNED");RequireServiceQuiescence();var info=new DISPOSITION{Delete=true};if(!SetFileInformationByHandle(ownerSentinel,4,ref info,1))throw Native("NATIVE_OWNER_NAMESPACE_DELETE_FAILED");if(!CloseHandle(ownerSentinel))throw Native("NATIVE_OWNER_NAMESPACE_CLOSE_FAILED");ownerSentinel=IntPtr.Zero;if(!ReleaseMutex(ownerMutex))throw Native("NATIVE_OWNER_NAMESPACE_RELEASE_FAILED");ownerNamespaceOwned=false;return D("released",true);}
  Need(!ownerNamespaceAbandoned,"NATIVE_OWNER_NAMESPACE_ABANDONED_HELD");if(ownerNamespaceOwned)return D("acquired",true,"scope","CURRENT_USER_SESSION_WORKSPACE_ONLY","namespaceDigest",ownerNamespaceDigest,"sentinelPath",ownerSentinelPath);
  if(ownerMutex==IntPtr.Zero){uint session;if(!ProcessIdToSessionId(helperPid,out session))throw Native("NATIVE_SESSION_ID_FAILED");workspaceHandle=CreateFileW(workspace,ATTR,3,IntPtr.Zero,3,BACKUP|REPARSE,IntPtr.Zero);if(workspaceHandle==INVALID){workspaceHandle=IntPtr.Zero;throw Native("NATIVE_WORKSPACE_IDENTITY_FAILED");}var identity=Identity(workspaceHandle);ownerNamespaceDigest=Digest(Encoding.UTF8.GetBytes(System.Security.Principal.WindowsIdentity.GetCurrent().User.Value+"|"+session+"|"+identity["dev"]+"|"+identity["ino"]));ownerSentinelPath=Path.Combine(approvedBase,"epoch-native-owner-"+ownerNamespaceDigest+".held");ownerMutex=CreateMutexW(IntPtr.Zero,false,"Local\\EvmEpochOwner-"+ownerNamespaceDigest);if(ownerMutex==IntPtr.Zero)throw Native("NATIVE_OWNER_NAMESPACE_CREATE_FAILED");}
  uint w=WaitForSingleObject(ownerMutex,0);if(w==0x102)return D("acquired",false,"scope","CURRENT_USER_SESSION_WORKSPACE_ONLY");if(w==0x80){ownerNamespaceAbandoned=true;ReleaseMutex(ownerMutex);throw new EpochNativeFailure("NATIVE_OWNER_NAMESPACE_ABANDONED_HELD");}Need(w==0,"NATIVE_OWNER_NAMESPACE_WAIT_FAILED");
  ownerSentinel=CreateFileW(ownerSentinelPath,READ|WRITE|0x10000,0,IntPtr.Zero,1,REPARSE|0x80000000U,IntPtr.Zero);if(ownerSentinel==INVALID){int error=Marshal.GetLastWin32Error();ownerSentinel=IntPtr.Zero;ownerNamespaceAbandoned=true;ReleaseMutex(ownerMutex);throw new EpochNativeFailure("NATIVE_OWNER_NAMESPACE_RECOVERY_REQUIRED",error);}
  ownerNamespaceOwned=true;byte[] b=Encoding.UTF8.GetBytes("NATIVE_OWNER_UNRESOLVED_UNTIL_ORDERED_TERMINAL_RELEASE\n");uint n;if(!WriteFile(ownerSentinel,b,(uint)b.Length,out n,IntPtr.Zero)||n!=b.Length)throw Native("NATIVE_OWNER_NAMESPACE_WRITE_FAILED");if(!FlushFileBuffers(ownerSentinel))throw Native("NATIVE_OWNER_NAMESPACE_FLUSH_FAILED");return D("acquired",true,"scope","CURRENT_USER_SESSION_WORKSPACE_ONLY","namespaceDigest",ownerNamespaceDigest,"sentinelPath",ownerSentinelPath);
 }
 sealed class ConsoleChallenge {public string Token,Nonce,Text;public IntPtr Input,Output;public long Utc,Mono;public StringBuilder Typed=new StringBuilder();}
 static ConsoleChallenge consoleChallenge;static bool consoleAttempted;
 static void DropConsole(){var c=consoleChallenge;consoleChallenge=null;if(c!=null&&c.Output!=IntPtr.Zero)CloseHandle(c.Output);}
 static IntPtr ConsoleInput(){Need(GetProcAddress(GetModuleHandleW("kernel32.dll"),"ReadConsoleInputExW")!=IntPtr.Zero,"NATIVE_CONSOLE_NONBLOCKING_API_UNAVAILABLE");IntPtr input=GetStdHandle(-10);uint mode;Need(input!=IntPtr.Zero&&input!=INVALID&&GetConsoleMode(input,out mode),"NATIVE_CONSOLE_REDIRECTED_NOT_READY");uint[] ids=new uint[64];uint count=GetConsoleProcessList(ids,64);Need(count>0&&count<=64&&Array.IndexOf(ids,parentPid)>=0&&Array.IndexOf(ids,helperPid)>=0&&Creation(parent)==parentCreation,"NATIVE_CONSOLE_MEMBERSHIP_NOT_READY");return input;}
 static object ConsoleCommand(Dictionary<string,object> p){
  string op=S(p,"operation",32);if(op=="CONSOLE_INSPECT"){Keys(p,"operation");ConsoleInput();return D("consoleInputVerified",true,"scope","NATIVE_CONSOLE_HANDLE_AND_PARENT_CREATION_MEMBERSHIP","physicalInteractionExercised",false);}
  if(op=="CONSOLE_INVALIDATE"){Keys(p,"operation","token");if(consoleChallenge!=null&&consoleChallenge.Token==S(p,"token",64))DropConsole();return D("invalidated",true);}
  if(op=="CONSOLE_BEGIN"){
   Keys(p,"operation","display","nonce","deadlineUtcMs","deadlineMonotonicMs");Need(!consoleAttempted,"NATIVE_CONSOLE_ONE_USE_REFUSED");consoleAttempted=true;IntPtr input=ConsoleInput();CheckLifetime();Need(lifetimeState=="BOUND","NATIVE_CONSOLE_OWNER_EXPIRED");var now=Sample();long u=N(p,"deadlineUtcMs",0,SAFE),m=N(p,"deadlineMonotonicMs",0,SAFE);Need(u>(long)now["nowUtcMs"]&&m>(long)now["monotonicNowMs"]&&u-(long)now["nowUtcMs"]<=300000&&m-(long)now["monotonicNowMs"]<=300000&&u<=lifetimeUtc&&m<=lifetimeMono,"NATIVE_CONSOLE_CHALLENGE_EXPIRED");uint pending;if(!GetNumberOfConsoleInputEvents(input,out pending))throw Native("NATIVE_CONSOLE_INPUT_QUERY_FAILED");Need(pending==0,"NATIVE_CONSOLE_PREEXISTING_INPUT_REFUSED");
   string nonce=S(p,"nonce",64),display=S(p,"display",24000);Need(System.Text.RegularExpressions.Regex.IsMatch(nonce,"^[a-f0-9]{32}$")&&display.IndexOf(nonce,StringComparison.Ordinal)>=0,"NATIVE_CONSOLE_BINDING_INVALID");IntPtr output=CreateFileW("CONOUT$",WRITE|READ,3,IntPtr.Zero,3,0,IntPtr.Zero);if(output==INVALID)throw Native("NATIVE_CONSOLE_DISPLAY_NOT_READY");uint mode;if(!GetConsoleMode(output,out mode)){CloseHandle(output);throw new EpochNativeFailure("NATIVE_CONSOLE_DISPLAY_NOT_READY");}var c=new ConsoleChallenge{Token=Guid.NewGuid().ToString("N"),Nonce=nonce,Text=display,Input=input,Output=output,Utc=u,Mono=m};consoleChallenge=c;uint written;if(!WriteConsoleW(output,display,(uint)display.Length,out written,IntPtr.Zero)||written!=display.Length){DropConsole();throw Native("NATIVE_CONSOLE_DISPLAY_FAILED");}return D("token",c.Token,"status","PENDING_NATIVE_INPUT");
  }
  Keys(p,"operation","token");Need(op=="CONSOLE_POLL"&&consoleChallenge!=null&&consoleChallenge.Token==S(p,"token",64),"NATIVE_CONSOLE_CHALLENGE_INVALID");var active=consoleChallenge;try{
   ConsoleInput();CheckLifetime();var s=Sample();Need(lifetimeState=="BOUND"&&(long)s["nowUtcMs"]<active.Utc&&(long)s["monotonicNowMs"]<active.Mono&&WaitForSingleObject(parent,0)==0x102,"NATIVE_CONSOLE_CHALLENGE_EXPIRED");var inputEvents=new INPUT[32];uint read;if(!ReadConsoleInputExW(active.Input,inputEvents,32,out read,2))throw Native("NATIVE_CONSOLE_READ_FAILED");for(int i=0;i<read;i++){var e=inputEvents[i];if(e.Type!=1||e.Down==0)continue;Need(e.Repeat==1,"NATIVE_CONSOLE_INPUT_REFUSED");if(e.Character=='\r'){Need(active.Typed.ToString()=="CONFIRM "+active.Nonce,"NATIVE_CONSOLE_CONFIRMATION_REFUSED");var end=Sample();Need((long)end["nowUtcMs"]<active.Utc&&(long)end["monotonicNowMs"]<active.Mono,"NATIVE_CONSOLE_CHALLENGE_EXPIRED");DropConsole();return D("status","ATTENDED_CONFIRMATION_ONLY_NOT_READY","productionActive",false);}Need(e.Character>=32&&e.Character<127&&active.Typed.Length<64,"NATIVE_CONSOLE_INPUT_REFUSED");active.Typed.Append(e.Character);}stop.WaitOne(20);return D("status","PENDING_NATIVE_INPUT");
  }catch(EntryPointNotFoundException){DropConsole();throw new EpochNativeFailure("NATIVE_CONSOLE_NONBLOCKING_API_UNAVAILABLE");}catch{DropConsole();throw;}
 }
 static string lifetimeState="UNBOUND";static long lifetimeUtc,lifetimeMono,lifetimeAnchorUtc,lifetimeAnchorMono,lifetimeLastUtc,lifetimeLastMono;
 static void CheckLifetime(){lock(flightLock){if(lifetimeState!="BOUND")return;try{var s=(Dictionary<string,object>)Clock();long u=(long)s["nowUtcMs"],m=(long)s["monotonicNowMs"];if(u<lifetimeLastUtc||m<lifetimeLastMono||Math.Abs((u-lifetimeAnchorUtc)-(m-lifetimeAnchorMono))>60000||u>=lifetimeUtc||m>=lifetimeMono){lifetimeState="EXPIRED_HELD";containmentHeld=true;if(flight!=null){flight.Uncertain=true;flight.Expired=true;if(flight.Job!=IntPtr.Zero)Kill(flight);}}lifetimeLastUtc=u;lifetimeLastMono=m;}catch{lifetimeState="CLOCK_UNCERTAIN_HELD";containmentHeld=true;if(flight!=null&&flight.Job!=IntPtr.Zero){CloseHandle(flight.Job);flight.Job=IntPtr.Zero;flight.Uncertain=true;flight.PureClosed=true;}}}}
 static object LifetimeClock(Dictionary<string,object> p){
  if(p.Count!=0){Keys(p,"operation","deadlineUtcMs","deadlineMonotonicMs");string op=S(p,"operation",32);Need(op=="BIND_LIFETIME"||op=="NARROW_LIFETIME","NATIVE_COMMAND_INVALID");lock(flightLock){var s=(Dictionary<string,object>)Clock();long u=N(p,"deadlineUtcMs",0,SAFE),m=N(p,"deadlineMonotonicMs",0,SAFE),nowU=(long)s["nowUtcMs"],nowM=(long)s["monotonicNowMs"];Need(u>nowU&&m>nowM&&u-nowU<=28800000&&m-nowM<=28800000,"NATIVE_LIFETIME_BOUND_INVALID");if(op=="BIND_LIFETIME"){Need(lifetimeState=="UNBOUND","NATIVE_LIFETIME_ALREADY_BOUND");lifetimeAnchorUtc=lifetimeLastUtc=nowU;lifetimeAnchorMono=lifetimeLastMono=nowM;}else Need(lifetimeState=="BOUND"&&u<=lifetimeUtc&&m<=lifetimeMono,"NATIVE_LIFETIME_EXTENSION_REFUSED");lifetimeUtc=u;lifetimeMono=m;lifetimeState="BOUND";}}
  CheckLifetime();var clock=(Dictionary<string,object>)Clock();clock.Add("lifetimeState",lifetimeState);clock.Add("lifetimeUtcMs",lifetimeUtc);clock.Add("lifetimeMonotonicMs",lifetimeMono);return clock;
 }
 sealed class Flight {public string Token,Marker,Mode,Fault,Creation;public IntPtr Job,Process,Thread,Script,Image,Breakaway;public uint Pid;public long Utc,Mono,AnchorUtc,AnchorMono,LastUtc,LastMono;public int Cleanup;public bool Resumed,Expired,Uncertain,PureClosed;public object BreakawayEvidence;public readonly Dictionary<uint,IntPtr> Members=new Dictionary<uint,IntPtr>();}
 static readonly object flightLock=new object();static Flight flight;static bool containmentHeld;
 const string DummyKind="DUMMY_QUALIFICATION_ONLY";
 const string DummySource="\"use strict\";const fs=require('fs'),cp=require('child_process'),p=require('path');const marker=process.argv[2],mode=process.argv[3];fs.writeFileSync(marker,JSON.stringify({scope:'DUMMY_QUALIFICATION_ONLY',pid:process.pid,mode}));if(mode==='EXIT')process.exit(0);if(mode==='TREE'||mode==='ORPHAN'){const c=cp.spawn(process.execPath,['--no-addons','--no-warnings',__filename,marker+'.leaf','LEAF'],{env:process.env,stdio:'ignore',windowsHide:true,detached:mode==='ORPHAN'});fs.writeFileSync(marker+'.child',JSON.stringify({pid:c.pid}));if(mode==='ORPHAN')c.unref(),process.exit(0);}if(mode==='BREAKAWAY'){const ps=p.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');const c=cp.spawn(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',p.join(__dirname,'n2-breakaway.ps1'),'-NodeImage',process.execPath,'-Script',__filename,'-Marker',marker+'.escaped','-Result',marker+'.breakaway'],{env:process.env,stdio:'ignore',windowsHide:true});c.on('exit',()=>process.exit(0));}setInterval(()=>{},1000);\n";
 const string BreakawaySource=@"param([string]$NodeImage,[string]$Script,[string]$Marker,[string]$Result)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
try {
$s=@""
using System;using System.Text;using System.Runtime.InteropServices;
public static class N2Breakaway {
 [StructLayout(LayoutKind.Sequential)] struct S {public uint cb;public IntPtr r,d,t;public uint x,y,xs,ys,xc,yc,f,flags;public ushort show,n;public IntPtr b,i,o,e;}
 [StructLayout(LayoutKind.Sequential)] struct P {public IntPtr p,t;public uint pid,tid;}
 [DllImport(""kernel32.dll"",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CreateProcessW(string a,StringBuilder c,IntPtr pa,IntPtr ta,bool i,uint f,IntPtr e,string wd,ref S s,out P p);
 [DllImport(""kernel32.dll"",SetLastError=true)]static extern bool TerminateProcess(IntPtr p,uint c);
 [DllImport(""kernel32.dll"")]static extern uint WaitForSingleObject(IntPtr p,uint ms);
 [DllImport(""kernel32.dll"")]static extern bool CloseHandle(IntPtr p);
 [StructLayout(LayoutKind.Sequential)] struct T {public uint low,high;public ulong Value {get{return ((ulong)high<<32)|low;}}}
 [DllImport(""kernel32.dll"",SetLastError=true)]static extern bool GetProcessTimes(IntPtr p,out T c,out T e,out T k,out T u);
 public static void Probe(string node,string script,string marker,string result){char q=(char)34;var s=new S();s.cb=(uint)Marshal.SizeOf(typeof(S));P p;string command=q+node+q+"" --no-addons --no-warnings ""+q+script+q+"" ""+q+marker+q+"" LEAF"";bool ok=CreateProcessW(node,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x01000000|0x08000000|4,IntPtr.Zero,null,ref s,out p);int error=ok?0:Marshal.GetLastWin32Error();if(ok){try{T c,e,k,u;if(!GetProcessTimes(p.p,out c,out e,out k,out u))throw new Exception();System.IO.File.WriteAllText(result,""{""+q+""creationTime100ns""+q+"":""+q+c.Value.ToString()+q+"",""+q+""nativeError""+q+"":0,""+q+""pid""+q+"":""+p.pid+""}"");System.Threading.Thread.Sleep(2000);}finally{TerminateProcess(p.p,91);WaitForSingleObject(p.p,3000);CloseHandle(p.t);CloseHandle(p.p);}}else System.IO.File.WriteAllText(result,""{""+q+""nativeError""+q+"":""+error+""}"");}
 public static int Try(string node,string script,string marker){var s=new S();s.cb=(uint)Marshal.SizeOf(typeof(S));P p;bool ok=CreateProcessW(node,new StringBuilder(""\""""+node+""\"" --no-addons --no-warnings \""""+script+""\"" \""""+marker+""\"" LEAF""),IntPtr.Zero,IntPtr.Zero,false,0x01000000|0x08000000,IntPtr.Zero,null,ref s,out p);int error=ok?0:Marshal.GetLastWin32Error();if(ok){TerminateProcess(p.p,91);WaitForSingleObject(p.p,3000);CloseHandle(p.t);CloseHandle(p.p);}return error;}
}
""@
$c=New-Object System.CodeDom.Compiler.CompilerParameters
$c.GenerateInMemory=$true;$c.TempFiles=New-Object System.CodeDom.Compiler.TempFileCollection($env:TEMP,$false)
$c.ReferencedAssemblies.Add('System.dll')|Out-Null
Add-Type -TypeDefinition $s -CompilerParameters $c -ErrorAction Stop|Out-Null
[N2Breakaway]::Probe($NodeImage,$Script,$Marker,$Result)
} catch {[IO.File]::WriteAllText($Result,'{""fixtureError"":true}');exit 3}
";
 static string Digest(byte[] b){using(var h=System.Security.Cryptography.SHA256.Create())return BitConverter.ToString(h.ComputeHash(b)).Replace("-","").ToLowerInvariant();}
 static object Fixture(){return D("scope",DummyKind,"filename","n2-dummy.js","source",DummySource,"digest",Digest(Encoding.UTF8.GetBytes(DummySource)),"companion",D("filename","n2-breakaway.ps1","source",BreakawaySource,"digest",Digest(Encoding.UTF8.GetBytes(BreakawaySource))));}
 static void InstallCode(string path,string source){IntPtr h=CreateFileW(path,READ|WRITE,0,IntPtr.Zero,1,REPARSE|0x80000000U,IntPtr.Zero);if(h==INVALID){int e=Marshal.GetLastWin32Error();if(e!=80&&e!=183)throw new EpochNativeFailure("NATIVE_DUMMY_INSTALL_FAILED",e);h=PinCode(path,source);CloseHandle(h);return;}try{var id=Identity(h);Need((long)id["nlink"]==1&&(string)id["path"]==path,"NATIVE_DUMMY_IDENTITY");byte[] b=Encoding.UTF8.GetBytes(source);uint n;if(!WriteFile(h,b,(uint)b.Length,out n,IntPtr.Zero))throw Native("NATIVE_DUMMY_INSTALL_WRITE_FAILED");Need(n==b.Length,"NATIVE_DUMMY_INSTALL_SHORT_WRITE");if(!FlushFileBuffers(h))throw Native("NATIVE_DUMMY_INSTALL_FLUSH_FAILED");if(!FlushFileBuffers(directories[directories.Count-1]))throw Native("NATIVE_DIRECTORY_FLUSH_FAILED");}finally{CloseHandle(h);}}
 static IntPtr PinCode(string path,string expected){IntPtr h=CreateFileW(path,READ,1,IntPtr.Zero,3,REPARSE,IntPtr.Zero);if(h==INVALID)throw Native("NATIVE_DUMMY_OPEN_FAILED");try{var id=Identity(h);Need((long)id["nlink"]==1&&string.Equals((string)id["path"],path,StringComparison.OrdinalIgnoreCase),"NATIVE_DUMMY_IDENTITY");byte[] bytes=Encoding.UTF8.GetBytes(expected);Need((long)id["size"]==bytes.Length,"NATIVE_DUMMY_DIGEST");byte[] actual=new byte[bytes.Length];uint got;if(!ReadFile(h,actual,(uint)actual.Length,out got,IntPtr.Zero))throw Native("NATIVE_DUMMY_READ_FAILED");Need(got==actual.Length&&Digest(actual)==Digest(bytes),"NATIVE_DUMMY_DIGEST");return h;}catch{CloseHandle(h);throw;}}
 static Dictionary<string,object> Sample(){return (Dictionary<string,object>)Clock();}
 static bool Within(Flight f){var s=Sample();long u=(long)s["nowUtcMs"],m=(long)s["monotonicNowMs"];if(u<f.LastUtc||m<f.LastMono||Math.Abs((u-f.AnchorUtc)-(m-f.AnchorMono))>60000){f.Uncertain=true;containmentHeld=true;return false;}f.LastUtc=u;f.LastMono=m;if(u>=f.Utc||m>=f.Mono){f.Expired=true;f.Uncertain=true;containmentHeld=true;return false;}return true;}
 static void Kill(Flight f){if(f.Job!=IntPtr.Zero&&!TerminateJobObject(f.Job,92))throw Native("NATIVE_JOB_TERMINATE_FAILED");}
 static uint Active(Flight f){Need(f.Job!=IntPtr.Zero,"NATIVE_JOB_ALREADY_CLOSED");IntPtr p=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ACCOUNT)));try{uint n;if(!QueryInformationJobObject(f.Job,1,p,(uint)Marshal.SizeOf(typeof(ACCOUNT)),out n))throw Native("NATIVE_JOB_QUERY_FAILED");return ((ACCOUNT)Marshal.PtrToStructure(p,typeof(ACCOUNT))).Active;}finally{Marshal.FreeHGlobal(p);}}
 static void CaptureMembers(Flight f){if(f.Job==IntPtr.Zero)return;int size=8+IntPtr.Size*16;IntPtr p=Marshal.AllocHGlobal(size);try{uint n;if(!QueryInformationJobObject(f.Job,3,p,(uint)size,out n))throw Native("NATIVE_JOB_MEMBERS_FAILED");int count=Marshal.ReadInt32(p,4);Need(count>=0&&count<=8,"NATIVE_JOB_MEMBER_BOUND");for(int i=0;i<count;i++){uint pid=(uint)(IntPtr.Size==8?Marshal.ReadInt64(p,8+i*IntPtr.Size):Marshal.ReadInt32(p,8+i*IntPtr.Size));if(f.Members.ContainsKey(pid))continue;IntPtr h=OpenProcess(0x101000,false,pid);if(h==IntPtr.Zero)continue;bool member;if(!IsProcessInJob(h,f.Job,out member)||!member){CloseHandle(h);continue;}Creation(h);f.Members.Add(pid,h);}}finally{Marshal.FreeHGlobal(p);}}
 static bool HandlesExited(Flight f){if(f.Process!=IntPtr.Zero&&WaitForSingleObject(f.Process,0)!=0)return false;foreach(var h in f.Members.Values)if(WaitForSingleObject(h,0)!=0)return false;return true;}
 static void BreakawayProof(Flight f){
  if(f.Mode!="BREAKAWAY"||f.BreakawayEvidence!=null||f.Job==IntPtr.Zero||!File.Exists(f.Marker+".breakaway"))return;
  Dictionary<string,object> proof;try{Need(new FileInfo(f.Marker+".breakaway").Length<=2048,"NATIVE_BREAKAWAY_PROOF_INVALID");proof=(Dictionary<string,object>)Json.Parse(File.ReadAllText(f.Marker+".breakaway"));}catch{return;}
  long code=N(proof,"nativeError",0,4294967295);if(code!=0){Need(code==5,"NATIVE_BREAKAWAY_PROOF_INVALID");f.BreakawayEvidence=D("classification","CREATE_PROCESS_REFUSED","nativeError",code,"escaped",false);return;}
  Keys(proof,"creationTime100ns","nativeError","pid");uint pid=(uint)N(proof,"pid",1,int.MaxValue);IntPtr h=OpenProcess(0x100401,false,pid);if(h==IntPtr.Zero)throw Native("NATIVE_BREAKAWAY_PROBE_OPEN_FAILED");
  try{Need(Creation(h)==S(proof,"creationTime100ns",32),"NATIVE_BREAKAWAY_PROBE_IDENTITY");PBI basic;int n;Need(NtQueryInformationProcess(h,0,out basic,Marshal.SizeOf(typeof(PBI)),out n)==0&&f.Members.ContainsKey((uint)basic.ParentPid.ToInt64()),"NATIVE_BREAKAWAY_PROBE_PARENT");bool member;if(!IsProcessInJob(h,f.Job,out member))throw Native("NATIVE_BREAKAWAY_PROBE_FAILED");
   // The probe is created SUSPENDED and never resumed. Clean only this exact
   // creation-checked owned descendant, including on a detected escape.
   if(!TerminateProcess(h,91))throw Native("NATIVE_BREAKAWAY_PROBE_TERMINATE_FAILED");Need(WaitForSingleObject(h,(uint)f.Cleanup)==0,"NATIVE_BREAKAWAY_PROBE_EXIT_UNCONFIRMED");if(!member){f.Uncertain=true;containmentHeld=true;throw new EpochNativeFailure("NATIVE_BREAKAWAY_ESCAPED");}
   f.BreakawayEvidence=D("classification","FLAG_ACCEPTED_OUTER_JOB_RETAINED","nativeError",0,"escaped",false,"pid",(long)pid,"creationTime100ns",Creation(h));if(!f.Members.ContainsKey(pid)){f.Members.Add(pid,h);h=IntPtr.Zero;}
  }finally{if(h!=IntPtr.Zero)CloseHandle(h);}
 }
 static object Tree(Flight f){uint active=f.Job==IntPtr.Zero?0:Active(f);CaptureMembers(f);BreakawayProof(f);var members=new List<object>();foreach(var kv in f.Members)members.Add(D("pid",(long)kv.Key,"creationTime100ns",Creation(kv.Value),"exited",WaitForSingleObject(kv.Value,0)==0));uint exit=259;if(f.Process!=IntPtr.Zero&&!GetExitCodeProcess(f.Process,out exit))throw Native("NATIVE_PROCESS_EXIT_QUERY_FAILED");bool zero=f.Job!=IntPtr.Zero&&active==0&&HandlesExited(f);return D("scope",DummyKind,"phase",f.PureClosed?"LAST_HANDLE_CLOSED_HELD":f.Expired?"EXPIRED_HELD":f.Uncertain?"UNCERTAIN_HELD":zero&&exit==0?"COMPLETED_DUMMY_ONLY":f.Resumed?"RUNNING":"SUSPENDED","treeZero",zero,"observedHandlesExited",HandlesExited(f),"activeProcesses",f.Job==IntPtr.Zero?null:(object)(long)active,"rootExited",f.Process!=IntPtr.Zero&&WaitForSingleObject(f.Process,0)==0,"rootExitCode",(long)exit,"expired",f.Expired,"uncertain",f.Uncertain,"members",members,"breakawayEvidence",f.BreakawayEvidence);}
 static Flight Token(Dictionary<string,object> p){Need(flight!=null&&S(p,"token",64)==flight.Token,"NATIVE_CONTAINMENT_TOKEN_INVALID");return flight;}
 static void Fault(string actual,string requested){if(actual==requested)throw new EpochNativeFailure("INJECTED_N2_"+actual);}
 static object Establish(Dictionary<string,object> p){
  string op=S(p,"operation",16);Need(S(p,"scope",64)==DummyKind,"NATIVE_DUMMY_SCOPE_REQUIRED");if(op=="DESCRIBE"){Keys(p,"operation","scope");return Fixture();}Need(lifetimeState=="UNBOUND"||lifetimeState=="BOUND","NATIVE_OWNER_LIFETIME_EXPIRED");if(op=="INSTALL"){Keys(p,"operation","scope");InstallCode(Path.Combine(root,"n2-dummy.js"),DummySource);InstallCode(Path.Combine(root,"n2-breakaway.ps1"),BreakawaySource);return Fixture();}
  Keys(p,"operation","scope","mode","scriptPath","scriptDigest","deadlineUtcMs","deadlineMonotonicMs","cleanupBudgetMs","fault");Need(op=="CREATE","NATIVE_COMMAND_INVALID");Need(!containmentHeld&&flight==null,"NATIVE_CONTAINMENT_HELD");
  string mode=S(p,"mode",16),fault=S(p,"fault",16);Need(Array.IndexOf(new[]{"EXIT","STUCK","TREE","ORPHAN","BREAKAWAY"},mode)>=0&&Array.IndexOf(new[]{"NONE","JOB_CREATE","LIMITS","JOB_LIST","CREATE","RESUME"},fault)>=0,"NATIVE_DUMMY_MODE_INVALID");
  string script=PathAllowed(S(p,"scriptPath",1024));Need(script==Path.Combine(root,"n2-dummy.js")&&S(p,"scriptDigest",64)==Digest(Encoding.UTF8.GetBytes(DummySource)),"NATIVE_DUMMY_DIGEST");
  var s=Sample();long u=N(p,"deadlineUtcMs",0,SAFE),m=N(p,"deadlineMonotonicMs",0,SAFE),nowU=(long)s["nowUtcMs"],nowM=(long)s["monotonicNowMs"];Need(u>nowU&&m>nowM&&u-nowU<=210000&&m-nowM<=210000,"NATIVE_DUMMY_DEADLINE_INVALID");int cleanup=(int)N(p,"cleanupBudgetMs",1,10000);
  var f=new Flight{Token=Guid.NewGuid().ToString("N"),Mode=mode,Fault=fault,Utc=u,Mono=m,AnchorUtc=nowU,AnchorMono=nowM,LastUtc=nowU,LastMono=nowM,Cleanup=cleanup,Marker=Path.Combine(root,"n2-marker-"+Guid.NewGuid().ToString("N")+".json")};IntPtr attr=IntPtr.Zero,jobList=IntPtr.Zero,environment=IntPtr.Zero;bool initialized=false;
  try{
   f.Script=PinCode(script,DummySource);if(mode=="BREAKAWAY")f.Breakaway=PinCode(Path.Combine(root,"n2-breakaway.ps1"),BreakawaySource);
   var image=new StringBuilder(32768);uint imageSize=(uint)image.Capacity;if(!QueryFullProcessImageNameW(parent,0,image,ref imageSize))throw Native("NATIVE_NODE_IMAGE_QUERY_FAILED");string executable=image.ToString();f.Image=CreateFileW(executable,READ,1,IntPtr.Zero,3,REPARSE,IntPtr.Zero);if(f.Image==INVALID){f.Image=IntPtr.Zero;throw Native("NATIVE_NODE_IMAGE_PIN_FAILED");}Need(string.Equals((string)Identity(f.Image)["path"],executable,StringComparison.OrdinalIgnoreCase),"NATIVE_NODE_IMAGE_MISMATCH");
   Fault("JOB_CREATE",fault);f.Job=CreateJobObjectW(IntPtr.Zero,null);if(f.Job==IntPtr.Zero)throw Native("NATIVE_JOB_CREATE_FAILED");if(!SetHandleInformation(f.Job,1,0))throw Native("NATIVE_JOB_NONINHERIT_FAILED");
   var limits=new EXT_LIMIT();limits.Basic.Flags=0x2000|8;limits.Basic.ActiveLimit=8;Fault("LIMITS",fault);if(!SetInformationJobObject(f.Job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXT_LIMIT))))throw Native("NATIVE_JOB_LIMIT_FAILED");
   UIntPtr bytes=UIntPtr.Zero;bool sizing=InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref bytes);int sizingError=Marshal.GetLastWin32Error();Need(!sizing&&sizingError==122&&bytes.ToUInt64()>0&&bytes.ToUInt64()<=65536,"NATIVE_ATTRIBUTE_SIZE_FAILED");attr=Marshal.AllocHGlobal((int)bytes.ToUInt64());if(!InitializeProcThreadAttributeList(attr,1,0,ref bytes))throw Native("NATIVE_ATTRIBUTE_INIT_FAILED");initialized=true;jobList=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobList,f.Job);Fault("JOB_LIST",fault);if(!UpdateProcThreadAttribute(attr,0,new IntPtr(0x2000D),jobList,new UIntPtr((uint)IntPtr.Size),IntPtr.Zero,IntPtr.Zero))throw Native("NATIVE_JOB_LIST_FAILED");
   var env=new List<string>();foreach(string key in new[]{"ComSpec","LOCALAPPDATA","SystemRoot","TEMP","TMP","WINDIR"})env.Add(key+"="+Environment.GetEnvironmentVariable(key));environment=Marshal.StringToHGlobalUni(string.Join("\0",env.ToArray())+"\0\0");var startup=new STARTUP_EX();startup.Basic.cb=(uint)Marshal.SizeOf(typeof(STARTUP_EX));startup.Attributes=attr;
   lock(flightLock){Need(flight==null&&!containmentHeld,"NATIVE_CONTAINMENT_HELD");flight=f;}
   Fault("CREATE",fault);PROC created;if(!CreateProcessW(executable,new StringBuilder("\""+executable+"\" --no-addons --no-warnings \""+script+"\" \""+f.Marker+"\" "+mode),IntPtr.Zero,IntPtr.Zero,false,0x80000|4|0x400|0x8000000,environment,root,ref startup,out created))throw Native("NATIVE_JOB_CREATE_PROCESS_FAILED");f.Process=created.Process;f.Thread=created.Thread;f.Pid=created.Pid;f.Creation=Creation(f.Process);bool member;if(!IsProcessInJob(f.Process,f.Job,out member))throw Native("NATIVE_JOB_MEMBERSHIP_QUERY_FAILED");Need(member,"NATIVE_JOB_MEMBERSHIP_FAILED");
   lock(flightLock){if(!Within(f)){Kill(f);throw new EpochNativeFailure("NATIVE_DUMMY_EXPIRED");}CaptureMembers(f);}
   return D("scope",DummyKind,"token",f.Token,"markerPath",f.Marker,"root",D("pid",(long)f.Pid,"creationTime100ns",f.Creation),"phase","SUSPENDED","creationAssociation","PROC_THREAD_ATTRIBUTE_JOB_LIST","fault",fault=="NONE"?"NONE":"INJECTED_N2_"+fault);
  }catch{lock(flightLock){if(flight==f)containmentHeld=true;if(f.Job!=IntPtr.Zero)TerminateJobObject(f.Job,93);bool resolved=true;if(f.Process!=IntPtr.Zero){TerminateProcess(f.Process,93);resolved=WaitForSingleObject(f.Process,(uint)Math.Min(3000,f.Cleanup))==0;}if(resolved){ReleaseFlight(f);if(flight==f)flight=null;}else{f.Uncertain=true;containmentHeld=true;flight=f;}}throw;}
  finally{if(initialized)DeleteProcThreadAttributeList(attr);if(attr!=IntPtr.Zero)Marshal.FreeHGlobal(attr);if(jobList!=IntPtr.Zero)Marshal.FreeHGlobal(jobList);if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);}
 }
 static void ReleaseFlight(Flight f){if(f.Job!=IntPtr.Zero){CloseHandle(f.Job);f.Job=IntPtr.Zero;}foreach(var h in f.Members.Values)CloseHandle(h);f.Members.Clear();foreach(IntPtr h in new[]{f.Thread,f.Process,f.Script,f.Image,f.Breakaway})if(h!=IntPtr.Zero)CloseHandle(h);f.Thread=f.Process=f.Script=f.Image=f.Breakaway=IntPtr.Zero;}
 static object Contain(string command,Dictionary<string,object> p){
  if(adoptedControllerMode=="ORDINARY"&&command=="ESTABLISH"&&p.ContainsKey("operation"))Need(S(p,"operation",16)=="DESCRIBE","NATIVE_ORDINARY_DUMMY_EXECUTION_REFUSED");
  CheckLifetime();if(command=="RESUME")Need(lifetimeState=="UNBOUND"||lifetimeState=="BOUND","NATIVE_OWNER_LIFETIME_EXPIRED");
  if(p.Count==0)throw new EpochNativeFailure("NATIVE_CONTAINMENT_UNIMPLEMENTED"); // legacy empty probe grants nothing
  if(command=="ESTABLISH")return Establish(p);
  if(command=="WAIT")Keys(p,"token","waitMs");else if(command=="JOB_CLOSE")Keys(p,"token","mode");else Keys(p,"token");
  Flight f;lock(flightLock){f=Token(p);if(command=="RESUME"){if(f.Resumed)throw new EpochNativeFailure("NATIVE_DUMMY_RESUME_REFUSED");if(f.Job==IntPtr.Zero||f.Uncertain||!Within(f)){if(f.Job!=IntPtr.Zero)Kill(f);throw new EpochNativeFailure("NATIVE_DUMMY_RESUME_REFUSED");}if(f.Fault=="RESUME"){f.Uncertain=true;containmentHeld=true;Kill(f);throw new EpochNativeFailure("INJECTED_N2_RESUME");}if(ResumeThread(f.Thread)==0xffffffff){var failure=Native("NATIVE_RESUME_FAILED");f.Uncertain=true;containmentHeld=true;Kill(f);throw failure;}f.Resumed=true;if(!Within(f)){Kill(f);throw new EpochNativeFailure("NATIVE_DUMMY_EXPIRED");}return Tree(f);}}
  if(command=="CANCEL"){lock(flightLock){f.Uncertain=true;containmentHeld=true;if(f.Job!=IntPtr.Zero)Kill(f);}}
  if(command=="WAIT"||command=="CANCEL"){
   long wait=command=="WAIT"?N(p,"waitMs",0,1000):f.Cleanup;var elapsed=System.Diagnostics.Stopwatch.StartNew();while(elapsed.ElapsedMilliseconds<wait){lock(flightLock){if(f.Job==IntPtr.Zero||(Active(f)==0&&HandlesExited(f)))break;if(!Within(f))Kill(f);var s=Sample();if(command=="CANCEL"&&((long)s["nowUtcMs"]>=f.Utc+f.Cleanup||(long)s["monotonicNowMs"]>=f.Mono+f.Cleanup))break;}stop.WaitOne(10);}
  }
  lock(flightLock){
   if(f.Job!=IntPtr.Zero&&!Within(f))Kill(f);
   if(command=="CANCEL"&&(f.Job==IntPtr.Zero||Active(f)!=0||!HandlesExited(f)))throw new EpochNativeFailure("NATIVE_TREE_UNCONFIRMED");
   if(command=="JOB_CLOSE"){
    string mode=S(p,"mode",32);Need(mode=="PURE_LAST_HANDLE"||mode=="AFTER_VERIFIED_ZERO","NATIVE_COMMAND_INVALID");CaptureMembers(f);
    if(mode=="AFTER_VERIFIED_ZERO"){Need(f.Job!=IntPtr.Zero&&Active(f)==0&&HandlesExited(f),"NATIVE_TREE_NOT_ZERO");var result=Tree(f);ReleaseFlight(f);flight=null;return result;}
    Need(f.Job!=IntPtr.Zero,"NATIVE_JOB_ALREADY_CLOSED");if(!CloseHandle(f.Job))throw Native("NATIVE_JOB_CLOSE_FAILED");f.Job=IntPtr.Zero;f.PureClosed=true;f.Uncertain=true;containmentHeld=true;
   }
   return Tree(f);
  }
 }
 static void WatchFlight(bool parentLost){lock(flightLock){var f=flight;if(f==null)return;try{if(parentLost){f.Uncertain=true;containmentHeld=true;if(f.Job!=IntPtr.Zero){CloseHandle(f.Job);f.Job=IntPtr.Zero;f.PureClosed=true;}}else if(f.Job!=IntPtr.Zero&&!Within(f))Kill(f);}catch{f.Uncertain=true;containmentHeld=true;if(f.Job!=IntPtr.Zero){CloseHandle(f.Job);f.Job=IntPtr.Zero;f.PureClosed=true;}}}}
 static string Creation(IntPtr h){FT c,e,k,u;if(!GetProcessTimes(h,out c,out e,out k,out u))throw Native("NATIVE_PROCESS_TIMES_FAILED");return c.Value.ToString(CultureInfo.InvariantCulture);}
 static string Final(IntPtr h){var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(h,b,(uint)b.Capacity,0);if(n==0)throw Native("NATIVE_FINAL_PATH_FAILED");Need(n<b.Capacity,"NATIVE_FINAL_PATH_FAILED");string p=b.ToString();if(p.StartsWith("\\\\?\\",StringComparison.Ordinal))p=p.Substring(4);return System.IO.Path.GetFullPath(p).TrimEnd('\\');}
 static Dictionary<string,object> Identity(IntPtr h){INFO x;if(!GetFileInformationByHandle(h,out x))throw Native("NATIVE_FILE_ID_FAILED");Need((x.Attributes&0x400)==0,"NATIVE_REPARSE_ANCESTOR");ulong size=((ulong)x.SizeHigh<<32)|x.SizeLow;Need(size<=SAFE,"NATIVE_FILE_BOUND");return D("dev",x.Volume.ToString(CultureInfo.InvariantCulture),"ino",(((ulong)x.IndexHigh<<32)|x.IndexLow).ToString(CultureInfo.InvariantCulture),"nlink",(long)x.Links,"size",(long)size,"path",Final(h));}
 static void Same(Dictionary<string,object> a,Dictionary<string,object> b){foreach(string k in new[]{"dev","ino","nlink","path"})Need(object.Equals(a[k],b[k]),"NATIVE_FILE_BINDING_CHANGED");}
 static void PinDirectories(string approved){
  string current=System.IO.Path.GetPathRoot(root);string relative=root.Substring(current.Length);foreach(string part in relative.Split('\\')){
   if(part.Length==0)continue;current=System.IO.Path.Combine(current,part);IntPtr h=CreateFileW(current,ATTR,3,IntPtr.Zero,3,BACKUP|REPARSE,IntPtr.Zero);if(h==INVALID)throw Native("NATIVE_ANCESTOR_OPEN_FAILED");directories.Add(h);Identity(h);
  }
  IntPtr writable=CreateFileW(root,READ|WRITE,3,IntPtr.Zero,3,BACKUP|REPARSE,IntPtr.Zero);if(writable==INVALID)throw Native("NATIVE_DIRECTORY_WRITE_OPEN_FAILED");directories.Add(writable);rootIdentity=Identity(writable);Need(string.Equals((string)rootIdentity["path"],root,StringComparison.OrdinalIgnoreCase),"NATIVE_ROOT_REDIRECTED");if(!FlushFileBuffers(writable))throw Native("NATIVE_DIRECTORY_FLUSH_FAILED");
 }
 static string PathAllowed(string path){try{string rawName=System.IO.Path.GetFileName(path);Need(System.Text.RegularExpressions.Regex.IsMatch(rawName,@"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")&&!rawName.EndsWith(".",StringComparison.Ordinal),"NATIVE_PATH_REFUSED");string full=System.IO.Path.GetFullPath(path),name=System.IO.Path.GetFileName(full);Need(full.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase)&&System.IO.Path.GetDirectoryName(full).Equals(root,StringComparison.OrdinalIgnoreCase)&&full.IndexOf(':',2)<0&&name==rawName,"NATIVE_PATH_REFUSED");string stem=name.Split('.')[0].ToUpperInvariant();Need(!System.Text.RegularExpressions.Regex.IsMatch(stem,@"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$"),"NATIVE_PATH_REFUSED");return full;}catch(ArgumentException){throw new EpochNativeFailure("NATIVE_PATH_REFUSED");}catch(NotSupportedException){throw new EpochNativeFailure("NATIVE_PATH_REFUSED");}catch(PathTooLongException){throw new EpochNativeFailure("NATIVE_PATH_REFUSED");}}
 static Lease Get(Dictionary<string,object> p){Lease l;Need(files.TryGetValue(S(p,"lease",64),out l),"NATIVE_LEASE_INVALID");return l;}
 static Dictionary<string,object> Checked(Lease l){var v=Identity(l.Handle);Same(l.Identity,v);Need((long)v["nlink"]==1,"NATIVE_LINK_COUNT_INVALID");IntPtr q=CreateFileW(l.Path,0,3,IntPtr.Zero,3,REPARSE,IntPtr.Zero);if(q==INVALID)throw Native("NATIVE_PATH_ID_OPEN_FAILED");try{Same(v,Identity(q));}finally{CloseHandle(q);}Same(rootIdentity,Identity(directories[directories.Count-1]));return v;}
 static object Clock(){long q;if(!QueryPerformanceCounter(out q))throw Native("NATIVE_QPC_FAILED");long mono=checked((q/frequency)*1000+(q%frequency)*1000/frequency);long utc=(DateTime.UtcNow.Ticks-621355968000000000L)/10000;Need(mono>=0&&mono<=SAFE&&utc>=0&&utc<=SAFE,"NATIVE_CLOCK_RANGE");return D("nowUtcMs",utc,"monotonicNowMs",mono);}
 static void WriteFrame(Stream s,object value){byte[] b=new UTF8Encoding(false,true).GetBytes(Json.Write(value));Need(b.Length>0&&b.Length<=MAX,"NATIVE_PROTOCOL_BOUND");byte[] frame=new byte[b.Length+4];BitConverter.GetBytes(b.Length).CopyTo(frame,0);b.CopyTo(frame,4);if(!s.WriteAsync(frame,0,frame.Length).Wait(30000))throw new EpochNativeFailure("NATIVE_FRAME_TIMEOUT");s.Flush();}
 static byte[] ReadExact(Stream stream,int count,int timeout){byte[] b=new byte[count];int n=0;var elapsed=System.Diagnostics.Stopwatch.StartNew();while(n<count){int remaining=timeout-(int)Math.Min(int.MaxValue,elapsed.ElapsedMilliseconds);if(remaining<=0)throw new EpochNativeFailure("NATIVE_FRAME_TIMEOUT");Task<int> t=stream.ReadAsync(b,n,count-n);if(!t.Wait(remaining))throw new EpochNativeFailure("NATIVE_FRAME_TIMEOUT");int got=t.Result;if(got==0)throw new EndOfStreamException();n+=got;}return b;}
 static Dictionary<string,object> ReadFrame(){byte[] head=ReadExact(pipe,4,28800000);int n=BitConverter.ToInt32(head,0);Need(n>0&&n<=MAX,"NATIVE_PROTOCOL_BOUND");var v=Json.Parse(new UTF8Encoding(false,true).GetString(ReadExact(pipe,n,30000))) as Dictionary<string,object>;Need(v!=null,"NATIVE_PROTOCOL_INVALID");return v;}
 static object Dispatch(string command,Dictionary<string,object> p){
  string lease=null;if(p.ContainsKey("__nativeOwnerLease")){lease=S(p,"__nativeOwnerLease",64);p.Remove("__nativeOwnerLease");}
  bool readOnly=command=="HELLO"||command=="JOURNAL_PATH_IDENTITY"||command=="CLOCK_SAMPLE"&&(p.Count==0||p.ContainsKey("operation")&&(S(p,"operation",32)=="CONSOLE_INSPECT"||S(p,"operation",32)=="VERIFY_SERVICE_QUIESCENCE"))||command=="ESTABLISH"&&p.ContainsKey("operation")&&S(p,"operation",32)=="DESCRIBE";
  if(adoptedControllerToken!=null&&!readOnly)Need(lease==adoptedControllerToken,"NATIVE_CONTROLLER_LEASE_REQUIRED");
  if(command=="CLOCK_SAMPLE"&&p.ContainsKey("operation")&&S(p,"operation",32)=="ADOPT_NATIVE_CONTROLLER"){Keys(p,"operation","mode");string mode=S(p,"mode",16);Need(mode=="ORDINARY"||mode=="QUALIFICATION","NATIVE_ADOPTION_MODE_INVALID");lock(flightLock){Need(adoptedControllerToken==null&&files.Count==0&&flight==null&&mutex==IntPtr.Zero&&!mutexOwned&&!abandoned&&ownerMutex==IntPtr.Zero&&!ownerNamespaceOwned&&ownerSentinel==IntPtr.Zero&&lifetimeState=="UNBOUND"&&!containmentHeld&&consoleChallenge==null&&!consoleAttempted&&!qualificationJournalFaultUsed,"NATIVE_ADOPTION_UNMANAGED_RESOURCES");adoptedControllerMode=mode;adoptedControllerToken=Guid.NewGuid().ToString("N");return D("token",adoptedControllerToken,"mode",mode);}}
  if(command=="CLOCK_SAMPLE"&&p.ContainsKey("operation")&&S(p,"operation",32)=="VERIFY_SERVICE_QUIESCENCE"){Keys(p,"operation");return ServiceQuiescence();}
  if(command=="HELLO"){Keys(p);return D("schema","trigger-fork-native-hello/v1","helper",D("pid",(long)helperPid,"creationTime100ns",helperCreation),"parent",D("pid",(long)parentPid,"creationTime100ns",parentCreation),"rootIdentity",rootIdentity,"containment","DUMMY_QUALIFICATION_ONLY","scope","NATIVE_STORAGE_N1_ONLY","qualificationFault",delay>0?"INJECTED_CLOCK_RESPONSE_DELAY_ONLY":"NONE","storageDurability","NOT_PROVEN_POWER_LOSS_DURABLE","directoryFlush","OBSERVED_FLUSH_ACCEPTED_UNDOCUMENTED_DIRECTORY_FLUSH");}
  if(command=="CLOCK_SAMPLE"){if(p.ContainsKey("operation")){string op=S(p,"operation",32);if(op.StartsWith("CONSOLE_",StringComparison.Ordinal))return ConsoleCommand(p);if(op=="QUALIFICATION_JOURNAL_FAULT"){Keys(p,"operation","fault");Need(adoptedControllerMode!="ORDINARY","NATIVE_ORDINARY_QUALIFICATION_FAULT_REFUSED");string fault=S(p,"fault",64);Need(!qualificationJournalFaultUsed&&(fault=="INJECTED_APPEND_AFTER_WRITE"||fault=="INJECTED_FLUSH_AFTER_FLUSH"||fault=="INJECTED_QUIESCENCE_UNKNOWN"),"NATIVE_QUALIFICATION_FAULT_INVALID");qualificationJournalFault=fault;qualificationJournalFaultUsed=true;return D("armed",true,"label",fault);}}if(delay>0)stop.WaitOne(delay);return LifetimeClock(p);}
  if(command=="MUTEX_ACQUIRE"){
   if(p.Count!=0){Keys(p,"operation");string op=S(p,"operation",32);if(op=="VERIFY_NATIVE_OWNER_NAMESPACE"){Need(ownerNamespaceOwned&&!ownerNamespaceAbandoned&&ownerSentinel!=IntPtr.Zero,"NATIVE_OWNER_NAMESPACE_LOST");var identity=Identity(ownerSentinel);Need((long)identity["nlink"]==1&&string.Equals((string)identity["path"],ownerSentinelPath,StringComparison.OrdinalIgnoreCase),"NATIVE_OWNER_NAMESPACE_IDENTITY_LOST");return D("owned",true);}Need(op=="NATIVE_OWNER_NAMESPACE","NATIVE_COMMAND_INVALID");return OwnerNamespace(false);}
   Keys(p);if(abandoned)throw new EpochNativeFailure("ABANDONED_OWNER_MUTEX");if(mutexOwned)return D("acquired",true,"abandonedLatch",false);
   if(mutex==IntPtr.Zero){string name;using(var sha=System.Security.Cryptography.SHA256.Create()){name="Local\\EvmEpochNative-"+BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(root.ToUpperInvariant()))).Replace("-","");}mutex=CreateMutexW(IntPtr.Zero,false,name);if(mutex==IntPtr.Zero)throw Native("NATIVE_MUTEX_CREATE_FAILED");}
   uint w=WaitForSingleObject(mutex,0);if(w==0x80){abandoned=true;if(!ReleaseMutex(mutex))throw Native("NATIVE_MUTEX_RELEASE_FAILED");throw new EpochNativeFailure("ABANDONED_OWNER_MUTEX");}if(w==0x102)return D("acquired",false,"abandonedLatch",false);if(w!=0)throw Native("NATIVE_MUTEX_WAIT_FAILED");mutexOwned=true;return D("acquired",true,"abandonedLatch",false);
  }
  if(command=="MUTEX_RELEASE"){if(p.Count!=0){Keys(p,"operation");Need(S(p,"operation",32)=="NATIVE_OWNER_NAMESPACE","NATIVE_COMMAND_INVALID");return OwnerNamespace(true);}Keys(p);if(adoptedControllerToken!=null)RequireServiceQuiescence();if(mutexOwned){if(!ReleaseMutex(mutex))throw Native("NATIVE_MUTEX_RELEASE_FAILED");mutexOwned=false;}return D("released",true,"abandonedLatch",abandoned);}
  if(command=="JOURNAL_OPEN"){
   Keys(p,"path","readonly");string full=PathAllowed(S(p,"path",1024));bool ro=B(p,"readonly");if(abandoned&&!ro)throw new EpochNativeFailure("ABANDONED_OWNER_MUTEX");IntPtr h=CreateFileW(full,ro?READ:READ|WRITE,ro?1U:0U,IntPtr.Zero,ro?3U:1U,REPARSE|(ro?0U:0x80000000U),IntPtr.Zero);if(h==INVALID)throw Native("NATIVE_FILE_OPEN_FAILED");
   var l=new Lease{Handle=h,Path=full,Readonly=ro};try{l.Identity=Identity(h);Need((long)l.Identity["nlink"]==1&&string.Equals((string)l.Identity["path"],full,StringComparison.OrdinalIgnoreCase),"NATIVE_FILE_BINDING_CHANGED");if(!ro){Need((long)l.Identity["size"]==0,"NATIVE_FRESH_FILE_NOT_EMPTY");if(!FlushFileBuffers(h))throw Native("NATIVE_FILE_FLUSH_FAILED");if(!FlushFileBuffers(directories[directories.Count-1]))throw Native("NATIVE_DIRECTORY_FLUSH_FAILED");}Checked(l);string id=Guid.NewGuid().ToString("N");files.Add(id,l);return D("lease",id,"identity",l.Identity);}catch{CloseHandle(h);throw;}
  }
  if(command=="JOURNAL_IDENTITY"){Keys(p,"lease");return Checked(Get(p));}
  if(command=="JOURNAL_PATH_IDENTITY"){Keys(p,"path");string path=PathAllowed(S(p,"path",1024));foreach(var l in files.Values)if(l.Path.Equals(path,StringComparison.OrdinalIgnoreCase))return Checked(l);throw new EpochNativeFailure("NATIVE_PATH_NOT_OWNED");}
  if(command=="JOURNAL_APPEND"){
   if(adoptedControllerToken!=null){byte[] candidate;try{candidate=Convert.FromBase64String(S(p,"bytes",22000));}catch{throw new EpochNativeFailure("NATIVE_BYTES_INVALID");}var record=Json.ParseDocument(new UTF8Encoding(false,true).GetString(candidate).TrimEnd('\n')) as Dictionary<string,object>;Need(record!=null&&record.ContainsKey("kind")&&record["kind"] is string,"NATIVE_CONTROLLER_JOURNAL_RECORD_INVALID");if((string)record["kind"]=="EPOCH_CLOSED")RequireServiceQuiescence();}
   Keys(p,"lease","bytes");if(abandoned)throw new EpochNativeFailure("ABANDONED_OWNER_MUTEX");var l=Get(p);Need(!l.Readonly,"NATIVE_READONLY_LEASE");Checked(l);string text=S(p,"bytes",22000);byte[] b;try{b=Convert.FromBase64String(text);}catch{throw new EpochNativeFailure("NATIVE_BYTES_INVALID");}Need(Convert.ToBase64String(b)==text&&b.Length<=16384,"NATIVE_BYTES_INVALID");long pos;if(!SetFilePointerEx(l.Handle,0,out pos,2))throw Native("NATIVE_SEEK_FAILED");Need(pos+b.Length<=786432,"NATIVE_FILE_BOUND");uint written;if(!WriteFile(l.Handle,b,(uint)b.Length,out written,IntPtr.Zero))throw Native("NATIVE_WRITE_FAILED");Checked(l);if(qualificationJournalFault=="INJECTED_APPEND_AFTER_WRITE"){qualificationJournalFault=null;throw new EpochNativeFailure("N3B_INJECTED_APPEND_AFTER_WRITE");}return D("written",(long)written);
  }
  if(command=="JOURNAL_FLUSH"){Keys(p,"lease");if(abandoned)throw new EpochNativeFailure("ABANDONED_OWNER_MUTEX");var l=Get(p);Need(!l.Readonly,"NATIVE_READONLY_LEASE");Checked(l);if(!FlushFileBuffers(l.Handle))throw Native("NATIVE_FILE_FLUSH_FAILED");Checked(l);if(qualificationJournalFault=="INJECTED_FLUSH_AFTER_FLUSH"){qualificationJournalFault=null;throw new EpochNativeFailure("N3B_INJECTED_FLUSH_AFTER_FLUSH");}return D("flushed",true);}
  if(command=="JOURNAL_READ"){
   Keys(p,"lease","maxBytes");var l=Get(p);long max=N(p,"maxBytes",1,786432);var id=Checked(l);long count=(long)id["size"];Need(count<=max,"NATIVE_READ_BOUND");byte[] b=new byte[(int)count];long pos;if(!SetFilePointerEx(l.Handle,0,out pos,0))throw Native("NATIVE_SEEK_FAILED");uint got;if(!ReadFile(l.Handle,b,(uint)b.Length,out got,IntPtr.Zero))throw Native("NATIVE_READ_FAILED");Need(got==count,"NATIVE_READ_SHORT");Checked(l);return D("bytes",Convert.ToBase64String(b));
  }
  if(command=="JOURNAL_CLOSE"){Keys(p,"lease");string id=S(p,"lease",64);var l=Get(p);Checked(l);if(!CloseHandle(l.Handle))throw Native("NATIVE_FILE_CLOSE_FAILED");files.Remove(id);return D("closed",true);}
  if(command=="EXIT"){Keys(p);exiting=true;return D("exitRequested",true,"epochState","NOT_IMPLEMENTED");}
  if(Array.IndexOf(new[]{"ESTABLISH","RESUME","WAIT","CANCEL","TREE_VERIFY","JOB_CLOSE"},command)>=0)return Contain(command,p);
  throw new EpochNativeFailure("NATIVE_COMMAND_INVALID");
 }
 static void Cleanup(){lock(flightLock){if(flight!=null){try{if(flight.Job!=IntPtr.Zero){CaptureMembers(flight);Kill(flight);var elapsed=System.Diagnostics.Stopwatch.StartNew();while(elapsed.ElapsedMilliseconds<flight.Cleanup&&(Active(flight)!=0||!HandlesExited(flight)))Thread.Sleep(10);if(Active(flight)!=0||!HandlesExited(flight))containmentHeld=true;}else if(flight.Process!=IntPtr.Zero&&WaitForSingleObject(flight.Process,(uint)flight.Cleanup)!=0)containmentHeld=true;}catch{containmentHeld=true;}ReleaseFlight(flight);flight=null;}}foreach(var l in files.Values)CloseHandle(l.Handle);files.Clear();if(mutexOwned){ReleaseMutex(mutex);mutexOwned=false;}if(mutex!=IntPtr.Zero){CloseHandle(mutex);mutex=IntPtr.Zero;}for(int n=directories.Count-1;n>=0;n--)CloseHandle(directories[n]);directories.Clear();}
  public static int Run(string rootPath,string pipePath,int expectedParent,int qualificationDelay,string hostPath){
  bool started=false;try{
    workspace=Path.GetDirectoryName(Path.GetDirectoryName(Path.GetFullPath(hostPath)));root=System.IO.Path.GetFullPath(rootPath).TrimEnd('\\');string approved=approvedBase=KnownApprovedBase();Need(root.StartsWith(approved+"\\",StringComparison.OrdinalIgnoreCase),"NATIVE_ROOT_REFUSED");Need(System.Text.RegularExpressions.Regex.IsMatch(pipePath,@"^\\\\\.\\pipe\\evm-epoch-native-[a-f0-9]{32}$"),"NATIVE_PIPE_REFUSED");delay=qualificationDelay;
   PBI pbi;int length;int status=NtQueryInformationProcess(GetCurrentProcess(),0,out pbi,Marshal.SizeOf(typeof(PBI)),out length);if(status!=0)throw new EpochNativeFailure("NATIVE_PARENT_QUERY_FAILED",unchecked((uint)status));Need(pbi.ParentPid.ToInt64()==expectedParent,"NATIVE_PARENT_MISMATCH");parentPid=(uint)expectedParent;helperPid=GetCurrentProcessId();parent=OpenProcess(0x101000,false,parentPid);if(parent==IntPtr.Zero)throw Native("NATIVE_PARENT_OPEN_FAILED");parentCreation=Creation(parent);helperCreation=Creation(GetCurrentProcess());Need(WaitForSingleObject(parent,0)==0x102,"NATIVE_PARENT_LOST");if(!QueryPerformanceFrequency(out frequency))throw Native("NATIVE_QPC_FREQUENCY_FAILED");Need(frequency>0,"NATIVE_QPC_FREQUENCY_INVALID");PinDirectories(approved);
   IntPtr sd;uint size;string sid=System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;if(!ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;;GA;;;"+sid+")",1,out sd,out size))throw Native("NATIVE_PIPE_ACL_FAILED");
   IntPtr raw;try{var sa=new SA{Length=Marshal.SizeOf(typeof(SA)),Descriptor=sd,Inherit=0};raw=CreateNamedPipeW(pipePath,3|0x40000000|0x80000,8,1,65536,65536,0,ref sa);if(raw==INVALID)throw Native("NATIVE_PIPE_CREATE_FAILED");}finally{LocalFree(sd);}
   pipe=new NamedPipeServerStream(PipeDirection.InOut,true,false,new SafePipeHandle(raw,true));
   // Native verification client proves this held FIRST_PIPE_INSTANCE name maps
   // to this exact helper before publishing attestation over owned stdout.
   var proof=pipe.BeginWaitForConnection(null,null);IntPtr client=CreateFileW(pipePath,READ|WRITE,0,IntPtr.Zero,3,0,IntPtr.Zero);if(client==INVALID)throw Native("NATIVE_PIPE_PROOF_OPEN_FAILED");uint serverPid;
   try{if(!GetNamedPipeServerProcessId(client,out serverPid))throw Native("NATIVE_PIPE_SERVER_PID_FAILED");Need(serverPid==helperPid,"NATIVE_PIPE_SERVER_MISMATCH");IntPtr ph=OpenProcess(0x101000,false,serverPid);if(ph==IntPtr.Zero)throw Native("NATIVE_PIPE_SERVER_OPEN_FAILED");try{Need(Creation(ph)==helperCreation,"NATIVE_PIPE_SERVER_CREATION_MISMATCH");}finally{CloseHandle(ph);}Need(proof.AsyncWaitHandle.WaitOne(5000),"NATIVE_PIPE_PROOF_TIMEOUT");pipe.EndWaitForConnection(proof);}finally{CloseHandle(client);proof.AsyncWaitHandle.Close();}pipe.Disconnect();
   watcher=new Thread(()=>{while(!stop.WaitOne(10)){bool lost=WaitForSingleObject(parent,0)!=0x102;CheckLifetime();WatchFlight(lost);if(lost){try{pipe.Dispose();}catch{}return;}}});watcher.IsBackground=true;watcher.Start();
    WriteFrame(Console.OpenStandardOutput(),D("schema","trigger-fork-native-startup/v1","pipeName",pipePath,"approvedBase",approvedBase,"helper",D("pid",(long)helperPid,"creationTime100ns",helperCreation),"parent",D("pid",(long)parentPid,"creationTime100ns",parentCreation),"pipeServerPid",(long)serverPid,"peerEvidence","NATIVE_FIRST_INSTANCE_SERVER_PID_AND_CREATION_ATTESTED"));started=true;
   var connected=pipe.BeginWaitForConnection(null,null);Need(connected.AsyncWaitHandle.WaitOne(30000),"NATIVE_PIPE_CONNECT_TIMEOUT");pipe.EndWaitForConnection(connected);connected.AsyncWaitHandle.Close();uint node;if(!GetNamedPipeClientProcessId(raw,out node))throw Native("NATIVE_PIPE_CLIENT_PID_FAILED");Need(node==parentPid&&Creation(parent)==parentCreation,"NATIVE_PIPE_CLIENT_MISMATCH");long last=0;
   while(!exiting){var request=ReadFrame();Keys(request,"schema","id","command","payload");Need(S(request,"schema",64)=="trigger-fork-native-request/v1","NATIVE_PROTOCOL_INVALID");long id=N(request,"id",1,1000000);Need(id==last+1,"NATIVE_PROTOCOL_CORRELATION");last=id;string command=S(request,"command",64);var payload=request["payload"] as Dictionary<string,object>;Need(payload!=null,"NATIVE_COMMAND_INVALID");object result=null;string code=null;long? native=null;try{result=Dispatch(command,payload);}catch(EpochNativeFailure e){code=e.Code;native=e.NativeError;}WriteFrame(pipe,D("schema","trigger-fork-native-response/v1","id",id,"status",code==null?"RESPONSE":"ERROR","result",result,"code",code,"nativeError",native.HasValue?(object)native.Value:null));}
   return 0;
  }catch(EpochNativeFailure e){if(!started)WriteFrame(Console.OpenStandardOutput(),D("schema","trigger-fork-native-startup-error/v1","code",e.Code,"nativeError",e.NativeError));return 3;}catch{if(!started)WriteFrame(Console.OpenStandardOutput(),D("schema","trigger-fork-native-startup-error/v1","code","NATIVE_HOST_START_FAILED","nativeError",0));return 4;}
   finally{stop.Set();DropConsole();if(pipe!=null)pipe.Dispose();if(watcher!=null)watcher.Join(1000);Cleanup();if(ownerSentinel!=IntPtr.Zero&&ownerSentinel!=INVALID)CloseHandle(ownerSentinel);if(ownerNamespaceOwned)ReleaseMutex(ownerMutex);if(ownerMutex!=IntPtr.Zero)CloseHandle(ownerMutex);if(workspaceHandle!=IntPtr.Zero)CloseHandle(workspaceHandle);if(parent!=IntPtr.Zero)CloseHandle(parent);}
 }
}
'@
  $parameters=New-Object System.CodeDom.Compiler.CompilerParameters
  $parameters.GenerateInMemory=$true
  $parameters.TempFiles=New-Object System.CodeDom.Compiler.TempFileCollection($resolved,$false)
  $parameters.ReferencedAssemblies.Add('System.dll')|Out-Null
  $parameters.ReferencedAssemblies.Add('System.Core.dll')|Out-Null
  Add-Type -TypeDefinition $source -CompilerParameters $parameters -ErrorAction Stop | Out-Null
  $result=[EpochNativeHost]::Run($resolved,$PipeName,$ParentPid,$QualificationDelayMs,$PSCommandPath)
  exit $result
} catch {
  Write-StartupFailure 'NATIVE_HOST_START_FAILED'
  exit 4
}
