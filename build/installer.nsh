!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE

  session_host_retry:
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Claude Workspace 正在运行。请先回到客户端并选择退出方式：可以仅退出客户端让会话继续运行，也可以退出并结束所有会话。客户端退出后，点击“重试”继续安装。" /SD IDCANCEL IDRETRY session_host_retry
      Quit
    ${endIf}
!macroend
