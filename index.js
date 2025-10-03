const express = require('express');
const axios = require('axios');
const { spawn } = require('child_process');
const NodeCache = require('node-cache');
const ffmpegStatic = require('ffmpeg-static');
const path = require('path');

const app = express();
const cache = new NodeCache({ stdTTL: 18000 }); // 5-hour cache

// Middleware
app.use(express.json());

// Fetch YouTube data
async function fetchYouTubeData(url) {
  try {
    const res = await axios.get(
      'https://api.vidfly.ai/api/media/youtube/download',
      {
        params: { url },
        headers: {
          accept: '*/*',
          'content-type': 'application/json',
          'x-app-name': 'vidfly-web',
          'x-app-version': '1.0.0',
          Referer: 'https://vidfly.ai/',
        },
      }
    );

    const data = res.data?.data;
    if (!data || !data.items || !data.title) {
      throw new Error('Invalid response from API');
    }

    return {
      title: data.title,
      thumbnail: data.thumbnail,
      duration: data.duration,
      formats: data.items.map((item) => ({
        type: item.type,
        quality: item.label || 'unknown',
        extension: item.ext || item.extension || 'unknown',
        url: item.url,
      })),
    };
  } catch (err) {
    throw new Error(`API request failed: ${err.message}`);
  }
}

// Check if URL expired
function isUrlExpired(url) {
  const expireMatch = url.match(/expire=(\d+)/);
  if (!expireMatch) return true;
  const expireTime = parseInt(expireMatch[1], 10) * 1000;
  return Date.now() >= expireTime - 300000; // 5-minute buffer
}

// Get video URL with refresh
async function getVideoUrl(videoId, quality = '720p') {
  if (!videoId.match(/^[a-zA-Z0-9_-]{11}$/)) {
    throw new Error('Invalid YouTube video ID');
  }

  const cacheKey = `${videoId}_${quality}`;
  const cached = cache.get(cacheKey);

  if (cached && !isUrlExpired(cached.url)) {
    return cached;
  }

  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const data = await fetchYouTubeData(youtubeUrl);

  let format =
    data.formats.find((f) => f.quality.includes(quality) && f.type === 'video_with_audio') ||
    data.formats.find((f) => f.type === 'video_with_audio');

  if (!format) {
    throw new Error('No suitable format found');
  }

  const result = {
    url: format.url,
    title: data.title,
    duration: data.duration,
  };

  cache.set(cacheKey, result);
  return result;
}

// Generate m3u8 manifest
app.get('/stream/:videoId/master.m3u8', async (req, res) => {
  try {
    const { videoId } = req.params;

    if (!videoId.match(/^[a-zA-Z0-9_-]{11}$/)) {
      throw new Error('Invalid YouTube video ID');
    }

    const videoData = await getVideoUrl(videoId);

    const duration = videoData.duration;
    const segmentDuration = 10;
    const numSegments = Math.ceil(duration / segmentDuration);

    let manifest = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:${segmentDuration}
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
`;

    for (let i = 0; i < numSegments; i++) {
      const segDur = Math.min(segmentDuration, duration - i * segmentDuration);
      manifest += `#EXTINF:${segDur.toFixed(3)},
/stream/${videoId}/segment${i}.ts
`;
    }

    manifest += '#EXT-X-ENDLIST\n';

    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    });

    res.send(manifest);
  } catch (error) {
    console.error('Manifest error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Generate TS segments on-demand
app.get('/stream/:videoId/segment:segNum.ts', async (req, res) => {
  try {
    const { videoId, segNum } = req.params;
    const segmentIndex = parseInt(segNum, 10);

    // Validate inputs
    if (isNaN(segmentIndex) || segmentIndex < 0) {
      throw new Error('Invalid segment number');
    }
    if (!videoId.match(/^[a-zA-Z0-9_-]{11}$/)) {
      throw new Error('Invalid YouTube video ID');
    }

    const segmentDuration = 10;
    const startTime = segmentIndex * segmentDuration;

    // Fetch video data
    const videoData = await getVideoUrl(videoId);

    // Log the URL for debugging
    console.log(`Fetching segment ${segmentIndex} for video ${videoId} from URL: ${videoData.url}`);

    // Set response headers
    res.set({
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'public, max-age=31536000',
      'Access-Control-Allow-Origin': '*',
    });

    // Check if ffmpeg binary exists
    if (!ffmpegStatic) {
      throw new Error('FFmpeg binary not found. Ensure ffmpeg-static is installed.');
    }

    // Simplified FFmpeg command
    const ffmpegArgs = [
      '-i', videoData.url,
      '-ss', startTime.toString(),
      '-t', segmentDuration.toString(),
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-f', 'mpegts',
      'pipe:',
    ];

    // Fallback to transcoding if copy fails (uncomment if needed)
    /*
    const ffmpegArgs = [
      '-i', videoData.url,
      '-ss', startTime.toString(),
      '-t', segmentDuration.toString(),
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-f', 'mpegts',
      'pipe:',
    ];
    */

    console.log(`FFmpeg command: ${ffmpegStatic} ${ffmpegArgs.join(' ')}`);

    const ffmpeg = spawn(ffmpegStatic, ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Pipe FFmpeg output to response
    ffmpeg.stdout.pipe(res);

    // Collect stderr data for debugging
    let stderrOutput = '';
    ffmpeg.stderr.on('data', (data) => {
      stderrOutput += data.toString();
      console.error(`FFmpeg stderr: ${data}`);
    });

    // Handle FFmpeg errors
    ffmpeg.on('error', (err) => {
      console.error('FFmpeg spawn error:', err.message, { stderr: stderrOutput });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to spawn FFmpeg process', details: err.message });
      }
    });

    // Handle FFmpeg process exit
    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        console.error(`FFmpeg exited with code ${code}`, { stderr: stderrOutput });
        if (!res.headersSent) {
          res.status(500).json({
            error: `FFmpeg process exited with code ${code}`,
            details: stderrOutput || 'No additional error details available',
          });
        }
      }
    });

    // Clean up FFmpeg process when client disconnects
    req.on('close', () => {
      ffmpeg.kill('SIGTERM');
    });

  } catch (error) {
    console.error('Segment error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Info endpoint
app.get('/api/info/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;

    if (!videoId.match(/^[a-zA-Z0-9_-]{11}$/)) {
      throw new Error('Invalid YouTube video ID');
    }

    const data = await getVideoUrl(videoId);
    res.json(data);
  } catch (error) {
    console.error('Info error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// HTML player
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HLS Streaming</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <style>
    body { font-family: Arial, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }
    video { width: 100%; max-width: 800px; }
    input { padding: 10px; width: 300px; }
    button { padding: 10px 20px; margin-left: 10px; cursor: pointer; }
    .error { color: red; margin-top: 10px; }
  </style>
</head>
<body>
  <h1>YouTube HLS Stream</h1>
  <input type="text" id="videoId" placeholder="YouTube Video ID" value="tTPk-fSx5gc">
  <button onclick="loadVideo()">Load</button>
  <div id="error" class="error"></div>
  <br><br>
  <video id="video" controls></video>
  
  <script>
    function loadVideo() {
      const videoId = document.getElementById('videoId').value.trim();
      const video = document.getElementById('video');
      const errorDiv = document.getElementById('error');
      const streamUrl = '/stream/' + videoId + '/master.m3u8';

      if (!videoId) {
        errorDiv.textContent = 'Please enter a valid YouTube video ID';
        return;
      }

      errorDiv.textContent = '';

      if (Hls.isSupported()) {
        const hls = new Hls({ debug: true }); // Enable HLS.js debug logs
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch((err) => {
            console.error('Playback error:', err);
            errorDiv.textContent = 'Error playing video: ' + err.message;
          });
        });
        hls.on(Hls.Events.ERROR, (event, data) => {
          console.error('HLS error:', data);
          errorDiv.textContent = 'Streaming error: ' + data.details;
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = streamUrl;
        video.addEventListener('loadedmetadata', () => {
          video.play().catch((err) => {
            console.error('Playback error:', err);
            errorDiv.textContent = 'Error playing video: ' + err.message;
          });
        });
      } else {
        errorDiv.textContent = 'HLS is not supported in this browser';
      }
    }
  </script>
</body>
</html>
  `);
});

module.exports = app;

// For local testing
if (require.main === module) {
  app.listen(3000, () => console.log('Server running on port 3000'));
}
