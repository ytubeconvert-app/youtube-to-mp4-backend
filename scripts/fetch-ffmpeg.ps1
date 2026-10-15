$url = "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
$zip = "bin\ffmpeg.zip"
$temp = "bin\ffmpeg-temp"

if (-not (Test-Path "bin\ffmpeg.exe")) {
    Write-Host "Downloading FFmpeg for Windows from official yt-dlp release..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $zip
    Write-Host "Extracting ffmpeg.exe..."
    Expand-Archive -Path $zip -DestinationPath $temp -Force
    $exe = Get-ChildItem -Path $temp -Filter "ffmpeg.exe" -Recurse | Select-Object -First 1
    if ($exe) {
        Move-Item -Path $exe.FullName -Destination "bin\ffmpeg.exe" -Force
        Write-Host "ffmpeg.exe successfully installed into bin/ffmpeg.exe!"
    }
    Remove-Item -Path $zip -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue
} else {
    Write-Host "ffmpeg.exe already exists in bin/!"
}
