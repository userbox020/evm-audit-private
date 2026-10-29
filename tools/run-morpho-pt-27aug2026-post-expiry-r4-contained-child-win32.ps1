param(
  [Parameter(Mandatory = $true)][ValidateSet("WSL_PROBE", "ACL_PROBE", "SELFTEST_TIMEOUT", "SELFTEST_JOB_CREATE", "SELFTEST_JOB_SET", "SELFTEST_JOB_ASSIGN", "SELFTEST_RESUME")][string]$Mode,
  [Parameter(Mandatory = $false)][ValidatePattern("^[A-Za-z0-9+/=]*$")][string]$PayloadBase64 = ""
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0

if (-not ("R4DiagnosticNative" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class R4DiagnosticNative {
  const uint CREATE_SUSPENDED=0x4,CREATE_NO_WINDOW=0x08000000,CREATE_UNICODE_ENVIRONMENT=0x400,EXTENDED_STARTUPINFO_PRESENT=0x80000;
  const uint STARTF_USESHOWWINDOW=1,STARTF_USESTDHANDLES=0x100,HANDLE_FLAG_INHERIT=1,PROC_THREAD_ATTRIBUTE_HANDLE_LIST=0x00020002,JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x2000;
  const uint WAIT_OBJECT_0=0,WAIT_TIMEOUT=258,STILL_ACTIVE=259;
  [StructLayout(LayoutKind.Sequential)] public struct SECURITY_ATTRIBUTES{public int nLength;public IntPtr lpSecurityDescriptor;[MarshalAs(UnmanagedType.Bool)]public bool bInheritHandle;}
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct STARTUPINFO{public int cb;public string lpReserved;public string lpDesktop;public string lpTitle;public int dwX;public int dwY;public int dwXSize;public int dwYSize;public int dwXCountChars;public int dwYCountChars;public int dwFillAttribute;public uint dwFlags;public short wShowWindow;public short cbReserved2;public IntPtr lpReserved2;public IntPtr hStdInput;public IntPtr hStdOutput;public IntPtr hStdError;}
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct STARTUPINFOEX{public STARTUPINFO StartupInfo;public IntPtr lpAttributeList;}
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION{public IntPtr hProcess;public IntPtr hThread;public uint dwProcessId;public uint dwThreadId;}
  [StructLayout(LayoutKind.Sequential)] public struct BASIC_LIMIT{public long PerProcessUserTimeLimit;public long PerJobUserTimeLimit;public uint LimitFlags;public UIntPtr MinimumWorkingSetSize;public UIntPtr MaximumWorkingSetSize;public uint ActiveProcessLimit;public UIntPtr Affinity;public uint PriorityClass;public uint SchedulingClass;}
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS{public ulong ReadOperationCount;public ulong WriteOperationCount;public ulong OtherOperationCount;public ulong ReadTransferCount;public ulong WriteTransferCount;public ulong OtherTransferCount;}
  [StructLayout(LayoutKind.Sequential)] public struct EXTENDED_LIMIT{public BASIC_LIMIT BasicLimitInformation;public IO_COUNTERS IoInfo;public UIntPtr ProcessMemoryLimit;public UIntPtr JobMemoryLimit;public UIntPtr PeakProcessMemoryUsed;public UIntPtr PeakJobMemoryUsed;}
  [StructLayout(LayoutKind.Sequential)] public struct ACCOUNTING{public long TotalUserTime;public long TotalKernelTime;public long ThisPeriodTotalUserTime;public long ThisPeriodTotalKernelTime;public uint TotalPageFaultCount;public uint TotalProcesses;public uint ActiveProcesses;public uint TotalTerminatedProcesses;}
  [StructLayout(LayoutKind.Sequential)] public struct FILETIME{public uint Low;public uint High;}
  [StructLayout(LayoutKind.Sequential)] public struct FILE_INFO{public uint Attributes;public FILETIME CreationTime;public FILETIME LastAccessTime;public FILETIME LastWriteTime;public uint VolumeSerialNumber;public uint FileSizeHigh;public uint FileSizeLow;public uint NumberOfLinks;public uint FileIndexHigh;public uint FileIndexLow;}
  public sealed class Result{public string Kind="START_ERROR";public int? ExitCode=null;public byte[] Stdout=new byte[0];public byte[] Stderr=new byte[0];public bool TreeTerminated=false;public uint ChildPid=0;public string SideEffectPath="";public bool ProcessExited=false;public uint JobActiveProcesses=0;}
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SECURITY_ATTRIBUTES attributes,uint size);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")]static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CreateProcessW(string app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref STARTUPINFOEX startup,out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateJobObjectW(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetInformationJobObject(IntPtr job,int infoClass,ref EXTENDED_LIMIT info,uint length);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)]static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)]static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool QueryInformationJobObject(IntPtr job,int infoClass,ref ACCOUNTING info,uint length,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool PeekNamedPipe(IntPtr pipe,IntPtr buffer,uint size,IntPtr read,out uint available,IntPtr left);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool ReadFile(IntPtr file,byte[] buffer,uint count,out uint read,IntPtr overlapped);
  [DllImport("kernel32.dll",SetLastError=true)]public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)]public static extern bool GetFileInformationByHandle(SafeFileHandle h,out FILE_INFO info);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder p,uint n,uint flags);
  static void Close(ref IntPtr h){if(h!=IntPtr.Zero){CloseHandle(h);h=IntPtr.Zero;}}
  static string Encoded(string script){return Convert.ToBase64String(Encoding.Unicode.GetBytes(script));}
  static void Drain(IntPtr pipe,MemoryStream output){uint available;byte[] buffer=new byte[512];while(PeekNamedPipe(pipe,IntPtr.Zero,0,IntPtr.Zero,out available,IntPtr.Zero)&&available>0){uint read;if(!ReadFile(pipe,buffer,(uint)Math.Min(buffer.Length,available),out read,IntPtr.Zero)||read==0)break;output.Write(buffer,0,(int)read);if(output.Length>8192)break;}}
  static bool ActiveZero(IntPtr job,out uint active){active=0;if(job==IntPtr.Zero)return true;ACCOUNTING a=new ACCOUNTING();if(!QueryInformationJobObject(job,1,ref a,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero))return false;active=a.ActiveProcesses;return active==0;}
  public static Result Run(string mode,string payload){
    Result result=new Result();string file,args,fault="";int timeout;
    if(mode=="WSL_PROBE"){if(String.IsNullOrEmpty(payload))return result;file=@"C:\Windows\System32\wsl.exe";args="--distribution Ubuntu-22.04 --user mruserbox --exec /usr/bin/env -i LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC /home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2/runtime/bin/node -e \"eval(Buffer.from('"+payload+"','base64').toString('utf8'))\"";timeout=25000;}
    else{file=@"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";timeout=mode=="SELFTEST_TIMEOUT"?1500:5000;
      if(mode=="SELFTEST_TIMEOUT")args="-NoProfile -NonInteractive -EncodedCommand "+Encoded("`$p=Start-Process -PassThru -WindowStyle Hidden -FilePath 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -ArgumentList '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 30';[Console]::Out.WriteLine(`$p.Id);[Console]::Out.Flush();Start-Sleep -Seconds 30");
      else{fault=mode.Substring(9);result.SideEffectPath=Path.Combine(Path.GetTempPath(),"opencode","morpho-r4-contained-sideeffect-"+Guid.NewGuid().ToString("N")+".txt");args="-NoProfile -NonInteractive -EncodedCommand "+Encoded("Start-Sleep -Milliseconds 750;[IO.File]::WriteAllText('"+result.SideEffectPath.Replace("'","''")+"','BAD')");}}
    IntPtr inR=IntPtr.Zero,inW=IntPtr.Zero,outR=IntPtr.Zero,outW=IntPtr.Zero,errR=IntPtr.Zero,errW=IntPtr.Zero,attrs=IntPtr.Zero,handleList=IntPtr.Zero,env=IntPtr.Zero,job=IntPtr.Zero;PROCESS_INFORMATION pi=new PROCESS_INFORMATION();bool created=false,assigned=false,natural=false;MemoryStream stdout=new MemoryStream(),stderr=new MemoryStream();
    try{
      SECURITY_ATTRIBUTES sa=new SECURITY_ATTRIBUTES{nLength=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),bInheritHandle=true};
      if(!CreatePipe(out inR,out inW,ref sa,0)||!CreatePipe(out outR,out outW,ref sa,0)||!CreatePipe(out errR,out errW,ref sa,0)||!SetHandleInformation(inW,HANDLE_FLAG_INHERIT,0)||!SetHandleInformation(outR,HANDLE_FLAG_INHERIT,0)||!SetHandleInformation(errR,HANDLE_FLAG_INHERIT,0))throw new Exception("PIPE");
      IntPtr attrSize=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref attrSize);attrs=Marshal.AllocHGlobal(attrSize);if(!InitializeProcThreadAttributeList(attrs,1,0,ref attrSize))throw new Exception("ATTR_INIT");
      handleList=Marshal.AllocHGlobal(IntPtr.Size*3);Marshal.WriteIntPtr(handleList,0,inR);Marshal.WriteIntPtr(handleList,IntPtr.Size,outW);Marshal.WriteIntPtr(handleList,IntPtr.Size*2,errW);if(!UpdateProcThreadAttribute(attrs,0,(IntPtr)PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handleList,(IntPtr)(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero))throw new Exception("ATTR_HANDLES");
      STARTUPINFOEX sx=new STARTUPINFOEX();sx.StartupInfo.cb=Marshal.SizeOf(typeof(STARTUPINFOEX));sx.StartupInfo.dwFlags=STARTF_USESHOWWINDOW|STARTF_USESTDHANDLES;sx.StartupInfo.wShowWindow=0;sx.StartupInfo.hStdInput=inR;sx.StartupInfo.hStdOutput=outW;sx.StartupInfo.hStdError=errW;sx.lpAttributeList=attrs;
      env=Marshal.StringToHGlobalUni("SystemRoot=C:\\Windows\0WINDIR=C:\\Windows\0\0");if(!CreateProcessW(file,new StringBuilder("\""+file+"\" "+args),IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_NO_WINDOW|CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT,env,null,ref sx,out pi))throw new Exception("CREATE_PROCESS");created=true;result.ChildPid=pi.dwProcessId;Close(ref inR);Close(ref outW);Close(ref errW);
      if(fault=="JOB_CREATE"){result.Kind="JOB_CREATE_ERROR";throw new Exception("FAULT");}job=CreateJobObjectW(IntPtr.Zero,null);if(job==IntPtr.Zero){result.Kind="JOB_CREATE_ERROR";throw new Exception("JOB_CREATE");}
      EXTENDED_LIMIT limits=new EXTENDED_LIMIT();limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;if(fault=="JOB_SET"||!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT)))){result.Kind="JOB_SET_ERROR";throw new Exception("JOB_SET");}
      if(fault=="JOB_ASSIGN"||!AssignProcessToJobObject(job,pi.hProcess)){result.Kind="JOB_ASSIGN_ERROR";throw new Exception("JOB_ASSIGN");}assigned=true;
      if(fault=="RESUME"||ResumeThread(pi.hThread)==UInt32.MaxValue){result.Kind="RESUME_ERROR";throw new Exception("RESUME");}Close(ref pi.hThread);Close(ref inW);
      Stopwatch watch=Stopwatch.StartNew();while(true){Drain(outR,stdout);Drain(errR,stderr);if(stdout.Length+stderr.Length>8192){result.Kind="OUTPUT_LIMIT";break;}uint wait=WaitForSingleObject(pi.hProcess,0);if(wait==WAIT_OBJECT_0){natural=true;result.Kind="EXIT";uint code;if(GetExitCodeProcess(pi.hProcess,out code)&&code!=STILL_ACTIVE)result.ExitCode=(int)code;break;}if(watch.ElapsedMilliseconds>=timeout){result.Kind="TIMEOUT";break;}System.Threading.Thread.Sleep(2);}
    }catch{if(result.Kind=="START_ERROR"&&created)result.Kind="CHILD_ERROR";}
    finally{
      if(created&&!natural){if(assigned&&job!=IntPtr.Zero)TerminateJobObject(job,125);TerminateProcess(pi.hProcess,125);}else if(job!=IntPtr.Zero)TerminateJobObject(job,125);
      if(created)result.ProcessExited=WaitForSingleObject(pi.hProcess,5000)==WAIT_OBJECT_0;
      Stopwatch cleanup=Stopwatch.StartNew();uint active=0;bool zero=false;do{zero=ActiveZero(job,out active);if(zero)break;System.Threading.Thread.Sleep(5);}while(cleanup.ElapsedMilliseconds<5000);result.JobActiveProcesses=active;result.TreeTerminated=result.ProcessExited&&zero;
      Drain(outR,stdout);Drain(errR,stderr);result.Stdout=stdout.ToArray();result.Stderr=stderr.ToArray();
      Close(ref pi.hThread);Close(ref pi.hProcess);Close(ref inR);Close(ref inW);Close(ref outR);Close(ref outW);Close(ref errR);Close(ref errW);Close(ref job);if(attrs!=IntPtr.Zero){DeleteProcThreadAttributeList(attrs);Marshal.FreeHGlobal(attrs);}if(handleList!=IntPtr.Zero)Marshal.FreeHGlobal(handleList);if(env!=IntPtr.Zero)Marshal.FreeHGlobal(env);
    }
    return result;
  }
}
"@
}

function Write-Result($Result) {
  $value = [ordered]@{ kind = $Result.Kind; exitCode = $Result.ExitCode; stdoutBase64 = [Convert]::ToBase64String($Result.Stdout); stderrBase64 = [Convert]::ToBase64String($Result.Stderr); treeTerminated = [bool]$Result.TreeTerminated; childPid = [uint32]$Result.ChildPid; sideEffectPathBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Result.SideEffectPath)); processExited = [bool]$Result.ProcessExited; jobActiveProcesses = [uint32]$Result.JobActiveProcesses }
  [Console]::Out.Write(($value | ConvertTo-Json -Compress))
}
function Test-ExactAcl([string]$Path, [bool]$Directory) {
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $expected = @($user, "S-1-5-18", "S-1-5-32-544"); $acl = Get-Acl -LiteralPath $Path; $owner = ([Security.Principal.NTAccount]::new($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value; $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])); if ($owner -ne $user -or -not $acl.AreAccessRulesProtected -or $rules.Count -ne 3) { return $false }; $wanted = if ($Directory) { [Security.AccessControl.InheritanceFlags]::ObjectInherit -bor [Security.AccessControl.InheritanceFlags]::ContainerInherit } else { [Security.AccessControl.InheritanceFlags]::None }; foreach ($sid in $expected) { $match = @($rules | Where-Object { $_.IdentityReference.Value -eq $sid }); if ($match.Count -ne 1 -or $match[0].IsInherited -or $match[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $match[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $match[0].InheritanceFlags -ne $wanted -or $match[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { return $false } }; return $true
}
function Test-ExactFile([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force; if (($item.Attributes -band [IO.FileAttributes]::Directory) -ne 0 -or ($item.Attributes -band [IO.FileAttributes]::Device) -ne 0 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not (Test-ExactAcl $Path $false)) { return $false }; $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); try { $info = New-Object R4DiagnosticNative+FILE_INFO; if (-not [R4DiagnosticNative]::GetFileInformationByHandle($stream.SafeFileHandle, [ref]$info) -or $info.NumberOfLinks -ne 1) { return $false }; $builder = [Text.StringBuilder]::new(32768); $count = [R4DiagnosticNative]::GetFinalPathNameByHandle($stream.SafeFileHandle, $builder, $builder.Capacity, 0); if ($count -eq 0 -or $count -ge $builder.Capacity) { return $false }; $final = $builder.ToString(); if ($final.StartsWith("\\?\")) { $final = $final.Substring(4) }; return [String]::Equals([IO.Path]::GetFullPath($final), [IO.Path]::GetFullPath($Path), [StringComparison]::OrdinalIgnoreCase) } finally { $stream.Dispose() }
}
if ($Mode -eq "ACL_PROBE") {
  $ok = $false; try { if ($PayloadBase64.Length -ne 0) { throw "PAYLOAD" }; $root = "C:\_Work\__EVM_AUDIT\.runtime\morpho-pt-post-expiry-r3-production"; $names = @("issue-morpho-pt-27aug2026-post-expiry-r3-production-permit-once.ps1", "morpho-pt-post-expiry-r3-capture-conductor-win32.exe", "morpho-pt-post-expiry-r3-native-build-manifest.json"); $item = Get-Item -LiteralPath $root -Force; $actual = @([IO.Directory]::EnumerateFiles($root) | ForEach-Object { [IO.Path]::GetFileName($_) } | Sort-Object); $ok = (($item.Attributes -band [IO.FileAttributes]::Directory) -ne 0) -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -and (Test-ExactAcl $root $true) -and (($actual -join "|") -eq (($names | Sort-Object) -join "|")); if ($ok) { foreach ($name in $names) { if (-not (Test-ExactFile ([IO.Path]::Combine($root, $name)))) { $ok = $false; break } } } } catch { $ok = $false }
  $result = [R4DiagnosticNative+Result]::new(); $result.Kind = "EXIT"; $result.ExitCode = $(if ($ok) { 0 } else { 2 }); $result.Stdout = [Text.Encoding]::UTF8.GetBytes($(if ($ok) { '{"ok":true}' } else { '{"ok":false}' })); $result.TreeTerminated = $true; $result.ProcessExited = $true; Write-Result $result; exit 0
}
if ($Mode -ne "WSL_PROBE" -and $PayloadBase64.Length -ne 0) { throw "PAYLOAD" }
Write-Result ([R4DiagnosticNative]::Run($Mode, $PayloadBase64))
