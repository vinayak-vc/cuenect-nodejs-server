if not exist "dist" mkdir "dist"

npx pkg . --targets node18-win-x64 --output "dist\cuenect-server.exe" && ^
if not exist "C:\Unity\Kayunet\Assets\StreamingAssets" mkdir "C:\Unity\Kayunet\Assets\StreamingAssets" && ^
copy /Y "dist\cuenect-server.exe" "C:\Unity\Kayunet\Assets\StreamingAssets\cuenect-server.exe"