@echo off
rem Change to the script's folder so docker compose runs in the project root
cd /d "%~dp0"
echo Starte Docker Compose...

rem With an NVIDIA card, enable GPU encoding (see docker-compose.gpu.yml)
set "COMPOSE_FILES=-f docker-compose.yml"
where nvidia-smi >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo NVIDIA GPU found, enabling GPU encoding.
    set "COMPOSE_FILES=-f docker-compose.yml -f docker-compose.gpu.yml"
)

rem Try the newer docker compose command first, otherwise fall back to docker-compose
docker compose version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    docker-compose %COMPOSE_FILES% up -d
) else (
    docker compose %COMPOSE_FILES% up -d
)

if %ERRORLEVEL% neq 0 (
    echo.
    echo Error: Docker Compose could not be started.
    echo Make sure Docker Desktop is running and docker-compose is installed.
    pause
    exit /b 1
)

echo.
echo Waiting for the containers to start...
setlocal enabledelayedexpansion
set "max_attempts=60"
set "attempt=0"
set "ANIM_INDEX=0"

:check_containers
set /a attempt=!attempt!+1
if !attempt! gtr !max_attempts! (
    cls
    echo.
    echo Warning: the containers took too long to start.
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
echo All containers are running. Checking the backend (port 9000)...
set "backend_attempts=0"

:check_backend
set /a backend_attempts=!backend_attempts!+1
if !backend_attempts! gtr 30 (
    cls
    echo Warning: the backend does not respond on port 9000.
    goto check_frontend
)

curl -s http://localhost:9000 >nul 2>&1
if %ERRORLEVEL% neq 0 (
    cls
    echo Loading backend !backend_attempts!/30 !ANIM_FRAME!
    call :animate_dot
    timeout /t 1 /nobreak >nul
    goto check_backend
)

echo Backend verfuegbar!

echo.
echo Checking the frontend (port 3000)...
set "web_attempts=0"

:check_frontend
set /a web_attempts=!web_attempts!+1
if !web_attempts! gtr 30 (
    cls
    echo Warning: the frontend does not respond. Opening the browser anyway...
    goto open_browser
)

curl -s http://localhost:3000 >nul 2>&1
if %ERRORLEVEL% neq 0 (
    cls
    echo Loading frontend !web_attempts!/30 !ANIM_FRAME!
    call :animate_dot
    timeout /t 1 /nobreak >nul
    goto check_frontend
)

echo Frontend verfuegbar!

:open_browser
echo.
echo Opening the browser at http://localhost:3000
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
