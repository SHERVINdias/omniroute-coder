@echo off
setlocal
cd /d "C:\Users\10csh\OneDrive\Desktop\omniroute-coder-external-provider-version6.9\omniroute-coder"

REM ---------------------------------------------------------------------------
REM Custom localhost port for the Next.js frontend.
REM
REM This is deliberately NOT called PORT.
REM
REM "start ... cmd /k" hands the child process a copy of this window's
REM environment. A bare "set PORT=4001" here therefore reached the OmniRoute
REM gateway as well, and the gateway reads PORT to choose its listen port - so
REM it stopped binding 20128 and its dashboard lost its own backend
REM ("Server is unreachable. Reconnecting..." / "No Providers Connected").
REM It also collided with the port we then handed Next.js.
REM
REM The previous launcher worked precisely because it never set PORT.
REM Keep this variable named NEXT_PORT and pass it to Next explicitly with -p.
REM ---------------------------------------------------------------------------
set "NEXT_PORT=4001"

REM ---------------------------------------------------------------------------
REM Dependency check
REM
REM Guarded by "if not exist" so this costs a directory lookup on a normal start
REM and only ever runs npm on a fresh clone or after a wiped node_modules.
REM Do NOT change these to an unconditional "npm install" - that would add
REM several seconds and a network round trip to every single launch.
REM ---------------------------------------------------------------------------

echo Checking dependencies...

if not exist "node_modules\" (
  echo   node_modules missing - running full install...
  call npm install
)

if not exist "node_modules\docx\" (
  echo   docx missing - installing ^(needed for Word export^)...
  call npm install docx
)

REM Production Agent Mode dependencies
if not exist "node_modules\@webcontainer\" (
  echo   WebContainers missing - installing ^(needed for Production Agent Mode^)...
  call npm install @webcontainer/api
)

if not exist "node_modules\xterm\" (
  echo   Terminal emulation missing - installing ^(needed for WebContainer terminal^)...
  call npm install xterm xterm-addon-fit xterm-addon-web-links
)

if not exist "node_modules\framer-motion\" (
  echo   Animation library missing - installing ^(needed for Production UI^)...
  call npm install framer-motion
)

if not exist "node_modules\lucide-react\" (
  echo   Icons missing - installing ^(needed for Production UI^)...
  call npm install lucide-react
)

if not exist "node_modules\minimatch\" (
  echo   File pattern matching missing - installing ^(needed for .aiignore support^)...
  call npm install minimatch
)

REM Puppeteer downloads its own Chromium on install. If that download was ever
REM skipped, PDF export fails at runtime with "Could not find Chrome" rather
REM than at install time, which is a confusing place to discover it.
if not exist "%USERPROFILE%\.cache\puppeteer\" (
  if not exist ".cache\puppeteer\" (
    echo   Puppeteer browser missing - downloading Chromium...
    call npx puppeteer browsers install chrome
  )
)

echo   Dependencies OK.
echo.

echo Compiling VS Code Extension...
cd vscode-extension
call npm run compile
cd ..

echo Starting Omniroute Backend...
REM Started with a clean PORT so the gateway binds its own default (20128).
start /min "Omniroute Backend" cmd /k "omniroute"

echo Starting Next.js Frontend on port %NEXT_PORT%...
start /min "Next.js App" cmd /k "npm run dev -- -p %NEXT_PORT%"

echo Waiting 6 seconds for servers to initialize...
timeout /t 6 /nobreak > nul

echo Opening Chrome...
start chrome http://localhost:%NEXT_PORT% http://localhost:20128/dashboard/quota

echo.
echo ===============================================================================
echo OMNIROUTE-CODER - LOCAL DEVELOPMENT
echo ===============================================================================
echo.
echo  Frontend:     http://localhost:%NEXT_PORT%
echo  Gateway:      http://localhost:20128
echo  Dashboard:    http://localhost:20128/dashboard/quota
echo.
echo  If the gateway dashboard says "Server is unreachable", check that nothing
echo  else holds its port and that this window never sets a PORT variable:
echo     netstat -ano ^| findstr :20128
echo     netstat -ano ^| findstr :%NEXT_PORT%
echo  Then hard-reload the dashboard with Ctrl+Shift+R - the page is a cached
echo  single-page app and will keep rendering after its backend has gone away.
echo.
echo ===============================================================================
endlocal