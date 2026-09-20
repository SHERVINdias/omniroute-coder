@echo off
REM ============================================================================
REM AgentRouter Database Fix - Automated Runner
REM ============================================================================
REM
REM This script updates your AgentRouter configuration in chat.db to fix
REM the "unauthorized client" error and add all available models.
REM
REM ============================================================================

cd /d "C:\Users\10csh\OneDrive\Desktop\omniroute-coder-external-provider-version6.9\omniroute-coder"

echo.
echo ============================================================================
echo AgentRouter Configuration Fix
echo ============================================================================
echo.
echo This will update your chat.db to fix the AgentRouter provider:
echo   - Fix Base URL: https://agentrouter.org/ -^> https://api.agentrouter.org
echo   - Add all models: Claude, DeepSeek, GLM, GPT
echo.
echo Press Ctrl+C to cancel, or
pause

echo.
echo Running Node.js fix script...
echo.

REM Run the Node.js script (uses better-sqlite3 which is already installed)
node fix-agentrouter.js

if %ERRORLEVEL% EQU 0 (
    echo.
    echo All done!
) else (
    echo.
    echo Fix failed. Please check the error messages above.
)

echo.
pause
