@echo off
rem Wechsel in das Verzeichnis des Skripts, damit docker-compose im Projektstamm läuft
cd /d "%~dp0"
echo Starte Docker Compose...

rem Versuche zuerst den neuen Docker CLI-Befehl, sonst fallback auf docker-compose
docker compose version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    docker-compose up -d
) else (
    docker compose up -d
)

if %ERRORLEVEL% neq 0 (
    echo.
    echo Fehler: Docker Compose konnte nicht gestartet werden.
    echo Stelle sicher, dass Docker Desktop laeuft und docker-compose installiert ist.
    pause
    exit /b 1
)

echo.
echo Warte auf Container-Start...
setlocal enabledelayedexpansion
set "max_attempts=60"
set "attempt=0"
set "ANIM_INDEX=0"

:check_containers
set /a attempt=!attempt!+1
if !attempt! gtr !max_attempts! (
    cls
    echo.
    echo Warnung: Container-Startup hat zu lange gedauert.
    echo Versuche trotzdem, Browser zu oeffnen...
    goto open_browser
)

docker compose ps | find "Up" >nul
if %ERRORLEVEL% neq 0 (
    cls
    echo Container starten !attempt!/!max_attempts! !ANIM_FRAME!
    call :animate_dot
    timeout /t 1 /nobreak >nul
    goto check_containers
)

echo.
echo Alle Container sind aktiv. Pruefen auf Backend (Port 9000)...
set "backend_attempts=0"

:check_backend
set /a backend_attempts=!backend_attempts!+1
if !backend_attempts! gtr 30 (
    cls
    echo Warnung: Backend reagiert nicht auf Port 9000.
    goto check_frontend
)

curl -s http://localhost:9000 >nul 2>&1
if %ERRORLEVEL% neq 0 (
    cls
    echo Backend wird geladen !backend_attempts!/30 !ANIM_FRAME!
    call :animate_dot
    timeout /t 1 /nobreak >nul
    goto check_backend
)

echo Backend verfuegbar!

echo.
echo Pruefen auf Frontend-Verfuegbarkeit (Port 3000)...
set "web_attempts=0"

:check_frontend
set /a web_attempts=!web_attempts!+1
if !web_attempts! gtr 30 (
    cls
    echo Warnung: Frontend reagiert nicht. Oeffne trotzdem Browser...
    goto open_browser
)

curl -s http://localhost:3000 >nul 2>&1
if %ERRORLEVEL% neq 0 (
    cls
    echo Frontend wird geladen !web_attempts!/30 !ANIM_FRAME!
    call :animate_dot
    timeout /t 1 /nobreak >nul
    goto check_frontend
)

echo Frontend verfuegbar!

:open_browser
echo.
echo Offne Browser auf http://localhost:3000
start "" "http://localhost:3000"
exit /b 0

:animate_dot
set /a ANIM_INDEX=!ANIM_INDEX! + 1
if !ANIM_INDEX! gtr 3 set "ANIM_INDEX=0"
if !ANIM_INDEX! equ 0 set "ANIM_FRAME=   "
if !ANIM_INDEX! equ 1 set "ANIM_FRAME=.  "
if !ANIM_INDEX! equ 2 set "ANIM_FRAME=.. "
if !ANIM_INDEX! equ 3 set "ANIM_FRAME=..."
goto :eof
