; ────────────────────────────────────────────────────────────────────
; Syntune NSIS installer hook — Syntune CLI (stune)
; ────────────────────────────────────────────────────────────────────
; Comportamento:
; • Instalação nova:  pergunta se quer instalar o CLI.
; • Atualização:
;   – CLI já instalado → atualiza silenciosamente (sem perguntar).
;   – CLI não instalado → pergunta se quer instalar.
; • Desinstalação: remove o CLI e limpa o PATH.
; ────────────────────────────────────────────────────────────────────

!include "MUI2.nsh"

Var CLI_DIR

; ── Macro: instalar/atualizar o CLI ──
!macro InstallCli
  ; Cria a pasta do CLI
  CreateDirectory "$CLI_DIR"

  ; Copia o wrapper .cmd que invoca o Node embutido do Electron
  ; O wrapper descobre o node.exe do Electron instalado e roda o script
  FileOpen $0 "$CLI_DIR\stune.cmd" w
  FileWrite $0 '@echo off$\r$\n'
  FileWrite $0 'setlocal$\r$\n'
  FileWrite $0 'set "ELECTRON_RUN_AS_NODE=1"$\r$\n'
  FileWrite $0 'set "STUNE_APP_DIR=$INSTDIR"$\r$\n'
  FileWrite $0 '"$INSTDIR\Syntune.exe" "$INSTDIR\resources\app\src\cli\stune.js" %*$\r$\n'
  FileWrite $0 'endlocal$\r$\n'
  FileClose $0

  ; Adiciona ao PATH do usuário (sem duplicar)
  nsExec::ExecToLog 'powershell -NoProfile -Command "$$p = [Environment]::GetEnvironmentVariable(''Path'',''User''); if ($$p -notlike ''*$CLI_DIR*'') { [Environment]::SetEnvironmentVariable(''Path'', $$p + '';$CLI_DIR'', ''User'') }"'
!macroend

; ── Macro: remover o CLI ──
!macro UninstallCli
  StrCpy $CLI_DIR "$INSTDIR\cli"

  ; Remove do PATH do usuário
  nsExec::ExecToLog 'powershell -NoProfile -Command "$$p = [Environment]::GetEnvironmentVariable(''Path'',''User''); $$n = ($$p -split '';'' | Where-Object { $$_ -ne ''$CLI_DIR'' }) -join '';''; [Environment]::SetEnvironmentVariable(''Path'', $$n, ''User'')"'

  ; Remove arquivos
  Delete "$CLI_DIR\stune.cmd"
  RMDir "$CLI_DIR"
!macroend


; ── Hook customInstall_: chamado durante a instalação ──
!macro customInstall
  StrCpy $CLI_DIR "$INSTDIR\cli"
  ; CLI já instalado → atualiza silenciosamente; senão, pergunta ao usuário.
  IfFileExists "$CLI_DIR\stune.cmd" cliInstall 0
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Deseja instalar o Syntune CLI (comando 'stune')?$\r$\n$\r$\nIsso permite que você (ou uma IA) baixe músicas do YouTube e crie playlists diretamente do terminal.$\r$\n$\r$\nExemplo: stune -y url1,url2 -pl $\"Ensaio$\"" \
      IDYES cliInstall IDNO cliSkip
  cliInstall:
    !insertmacro InstallCli
  cliSkip:
!macroend

; ── Hook customUnInstall_: chamado durante a desinstalação ──
!macro customUnInstall
  !insertmacro UninstallCli
!macroend
