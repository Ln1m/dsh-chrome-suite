' dsh-restart-instance.vbs - hidden launcher for one dsh restart.
'
' Starts a detached PowerShell worker (window style 0, no wait) so the server
' process can die immediately after answering the browser the restart request.
' The worker sits next to this file; the caller passes the port to restart.
' Keep this file ASCII-only and argument-order stable: it is spawned as
'   wscript.exe dsh-restart-instance.vbs <port>
Dim port, fso, here, ps1
If WScript.Arguments.Count > 0 Then
  port = WScript.Arguments(0)
Else
  port = "3080"
End If
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(here, "dsh-restart-instance.ps1")
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """ -Port " & port, 0, False
