@echo off
echo Converting videos to multiple qualities...

for %%f in (*.mp4) do (
    echo Converting %%f...
    
    REM Get filename without extension
    set "filename=%%~nf"
    
    REM Generate 720p version
    ffmpeg -i "%%f" -vf scale=1280:720 -c:v libx264 -crf 23 -c:a copy "%%~nf_720p.mp4"
    
    REM Generate 480p version  
    ffmpeg -i "%%f" -vf scale=854:480 -c:v libx264 -crf 23 -c:a copy "%%~nf_480p.mp4"
    
    REM Generate 360p version
    ffmpeg -i "%%f" -vf scale=640:360 -c:v libx264 -crf 23 -c:a copy "%%~nf_360p.mp4"
    
    echo Finished converting %%f
    echo.
)

echo All conversions complete!
pause