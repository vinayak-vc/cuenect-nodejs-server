@echo off
echo Building standalone executable for Windows (node18-win-x64)...
npx pkg . --targets node18-win-x64 --output dist/cuenect-server.exe
echo Build complete. Output saved to dist/cuenect-server.exe