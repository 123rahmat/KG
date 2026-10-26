@echo off
rem Kindgleam desktop app launcher for Windows. No logic lives here.
setlocal
set "KG_HOME=%~dp0.."
set JAVA_TOOL_OPTIONS=
set _JAVA_OPTIONS=
set JDK_JAVA_OPTIONS=
start "" javaw --enable-preview -Xshare:off -Dkg.home="%KG_HOME%" -p "%KG_HOME%\build\mods" -m kg.app/kg.app.App %*
