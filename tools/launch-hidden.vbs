Option Explicit
' Transport only: base64 is not encryption or an authorization boundary.
Dim shell, fso, payload, bridge, powershell, command, i, ch, result
If WScript.Arguments.Count <> 1 Then WScript.Quit 1
payload = WScript.Arguments(0)
If Len(payload) = 0 Or Len(payload) > 28000 Then WScript.Quit 1
For i = 1 To Len(payload)
  ch = Mid(payload, i, 1)
  If InStr(1, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=", ch, 0) = 0 Then WScript.Quit 1
Next
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
bridge = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "hidden-console-runner.ps1")
powershell = fso.BuildPath(fso.GetSpecialFolder(0), "System32\WindowsPowerShell\v1.0\powershell.exe")
' WshShell.Run expands environment references: raw target arguments NEVER enter it.
If InStr(bridge, "%") > 0 Or InStr(bridge, Chr(34)) > 0 Then WScript.Quit 1
command = Chr(34) & powershell & Chr(34) & " -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & Chr(34) & bridge & Chr(34) & " -Payload " & payload
On Error Resume Next
result = shell.Run(command, 0, True)
If Err.Number <> 0 Then WScript.Quit 1
WScript.Quit result
