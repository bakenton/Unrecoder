@echo off
rem Starts the local server for the prototype and opens it in the default browser.
cd /d "%~dp0"
start "" http://localhost:5173/prototype/index.html
python -m http.server 5173
