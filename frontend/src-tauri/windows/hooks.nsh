; NSIS hooks for the Windows installer (bundle.windows.nsis.installerHooks).
;
; Trimly only adds itself to "Open with" and never becomes the default app. Tauri's own
; fileAssociations would set HKCU\Software\Classes\.mp4 to its ProgID (= default app) and
; leave an empty default behind on uninstall, which hides the Windows entries (no thumbnails).
; That's why fileAssociations is empty in tauri.windows.conf.json and this file registers
; the "Open with" entries itself. Only per-user keys (HKCU), the installer is currentUser.

!define TRIMLY_PROGID "Trimly.Video"
!define TRIMLY_CLASSES "Software\Classes"

; Old Tauri association of a version before this fix: restore the default saved in
; <class>_backup (or remove the empty one) and delete the old ProgID.
!macro TRIMLY_CLEAN_OLD EXT CLASS
  ClearErrors
  ReadRegStr $1 HKCU "${TRIMLY_CLASSES}\.${EXT}" "${CLASS}_backup"
  ${IfNot} ${Errors}
    ReadRegStr $0 HKCU "${TRIMLY_CLASSES}\.${EXT}" ""
    ${If} $0 == "${CLASS}"
    ${OrIf} $0 == ""
      ${If} $1 == ""
        DeleteRegValue HKCU "${TRIMLY_CLASSES}\.${EXT}" ""
      ${Else}
        WriteRegStr HKCU "${TRIMLY_CLASSES}\.${EXT}" "" "$1"
      ${EndIf}
    ${EndIf}
    DeleteRegValue HKCU "${TRIMLY_CLASSES}\.${EXT}" "${CLASS}_backup"
  ${EndIf}
  DeleteRegKey HKCU "${TRIMLY_CLASSES}\${CLASS}"
!macroend

!macro TRIMLY_OPEN_WITH EXT
  WriteRegStr HKCU "${TRIMLY_CLASSES}\.${EXT}\OpenWithProgids" "${TRIMLY_PROGID}" ""
  WriteRegStr HKCU "${TRIMLY_CLASSES}\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".${EXT}" ""
!macroend

!macro TRIMLY_REMOVE_OPEN_WITH EXT
  DeleteRegValue HKCU "${TRIMLY_CLASSES}\.${EXT}\OpenWithProgids" "${TRIMLY_PROGID}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro TRIMLY_CLEAN_OLD "mp4" "MP4-Video"
  !insertmacro TRIMLY_CLEAN_OLD "m4v" "MP4-Video"
  !insertmacro TRIMLY_CLEAN_OLD "mov" "QuickTime-Video"
  !insertmacro TRIMLY_CLEAN_OLD "mkv" "Matroska-Video"
  !insertmacro TRIMLY_CLEAN_OLD "webm" "WebM-Video"
  !insertmacro TRIMLY_CLEAN_OLD "avi" "AVI-Video"

  WriteRegStr HKCU "${TRIMLY_CLASSES}\${TRIMLY_PROGID}" "" "Video"
  WriteRegStr HKCU "${TRIMLY_CLASSES}\${TRIMLY_PROGID}\DefaultIcon" "" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr HKCU "${TRIMLY_CLASSES}\${TRIMLY_PROGID}\shell\open" "" "Open with ${PRODUCTNAME}"
  WriteRegStr HKCU "${TRIMLY_CLASSES}\${TRIMLY_PROGID}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  WriteRegStr HKCU "${TRIMLY_CLASSES}\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr HKCU "${TRIMLY_CLASSES}\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  !insertmacro TRIMLY_OPEN_WITH "mp4"
  !insertmacro TRIMLY_OPEN_WITH "m4v"
  !insertmacro TRIMLY_OPEN_WITH "mov"
  !insertmacro TRIMLY_OPEN_WITH "mkv"
  !insertmacro TRIMLY_OPEN_WITH "webm"
  !insertmacro TRIMLY_OPEN_WITH "avi"

  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro TRIMLY_REMOVE_OPEN_WITH "mp4"
  !insertmacro TRIMLY_REMOVE_OPEN_WITH "m4v"
  !insertmacro TRIMLY_REMOVE_OPEN_WITH "mov"
  !insertmacro TRIMLY_REMOVE_OPEN_WITH "mkv"
  !insertmacro TRIMLY_REMOVE_OPEN_WITH "webm"
  !insertmacro TRIMLY_REMOVE_OPEN_WITH "avi"
  DeleteRegKey HKCU "${TRIMLY_CLASSES}\${TRIMLY_PROGID}"
  DeleteRegKey HKCU "${TRIMLY_CLASSES}\Applications\${MAINBINARYNAME}.exe"
  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)"
!macroend
