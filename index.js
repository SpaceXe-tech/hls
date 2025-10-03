const express = require('express');
const axios = require('axios');
const { spawn } = require('child_process');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 18000 }); // 5 hour cache

// Middleware
app.use(express.json()); // Added to parse JSON bodies, if needed

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
  const expireMatch = url.match(/expire=(\d+)/); // Fixed regex syntax
  if (!expireMatch) return true;
  const expireTime = parseInt(expireMatch[1]) * 1000;
  return Date.now() >= expireTime - 1800000; // Simplified expression
}

// Get video URL with refresh
async function getVideoUrl(videoId, quality = '720p') {
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
    console.error('Manifest error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate TS segments on-demand
app.get('/stream/:videoId/segment:segNum.ts', async (req, res) => {
  try {
    const { videoId, segNum } = req.params;
    const segmentIndex = parseInt(segNum, 10); // Added radix for parseInt
    const segmentDuration = 10;
    const startTime = segmentIndex * segmentDuration;

    const videoData = await getVideoUrl(videoId);

    // Set response headers
    res.set({
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'public, max-age=31536000',
      'Access-Control-Allow-Origin': '*',
    });

    // Use ffmpeg to extract segment
    const ffmpeg = spawn('ffmpeg', [
      '-ss', startTime.toString(),
      '-i', videoData.url,
      '-t', segmentDuration.toString(),
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-f', 'mpegts',
      '-avoid_negative_ts', 'make_zero',
      'pipe:1',
    ]);

    ffmpeg.stdout.pipe(res);

    ffmpeg.stderr.on('data', (data) => {
      console.error(`FFmpeg stderr: ${data}`);
    });

    ffmpeg.on('error', (err) => {
      console.error('FFmpeg spawn error:', err);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0 && !res.headersSent) {
        console.error(`FFmpeg exited with code ${code}`);
        res.status(500).end();
      }
    });

    req.on('close', () => {
      ffmpeg.kill('SIGKILL');
    });
  } catch (error) {
    console.error('Segment error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Info endpoint
app.get('/api/info/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    const data = await getVideoUrl(videoId);
    res.json(data);
  } catch (error) {
    console.error('Info error:', error);
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
  </style>
</head>
<body>
  <h1>YouTube HLS Stream</h1>
  <input type="text" id="videoId" placeholder="YouTube Video ID" value="tTPk-fSx5gc">
  <button onclick="loadVideo()">Load</button>
  <br><br>
  <video id="video" controls></video>
  
  <script>
    function loadVideo() {
      const videoId = document.getElementById('videoId').value.trim();
      const video = document.getElementById('video');
      const streamUrl = '/stream/' + videoId + '/master.m3u8';

      if (!videoId) {
        alert('Please enter a valid YouTube video ID');
        return;
      }

      if (Hls.isSupported()) {
        const hls = new Hls();
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch((err) => console.error('Playback error:', err)));
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = streamUrl;
        video.addEventListener('loadedmetadata', () => video.play().catch((err) => console.error('Playback error:', err)));
      } else {
        alert('HLS is not supported in this browser');
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
