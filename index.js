const express = require('express');
const axios = require('axios');
const { spawn } = require('child_process');
const NodeCache = require('node-cache');
const ffmpegStatic = require('ffmpeg-static');

const app = express();
const cache = new NodeCache({ stdTTL: 18000 }); // 5-hour cache

app.use(express.json());

// -----------------------------
// Fetch YouTube data
// -----------------------------
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
        type: item.type, // video_with_audio, video, audio
        quality: item.label || 'unknown',
        extension: item.ext || item.extension || 'unknown',
        url: item.url,
      })),
    };
  } catch (err) {
    throw new Error(`API request failed: ${err.message}`);
  }
}

// -----------------------------
// Helpers
// -----------------------------
function isUrlExpired(url) {
  const expireMatch = url.match(/expire=(\d+)/);
  if (!expireMatch) return true;
  const expireTime = parseInt(expireMatch[1], 10) * 1000;
  return Date.now() >= expireTime - 300000; // 5-minute buffer
}

async function getVideoFormats(videoId, forceRefresh = false) {
  if (!videoId.match(/^[a-zA-Z0-9_-]{11}$/)) {
    throw new Error('Invalid YouTube video ID');
  }

  const cacheKey = `${videoId}_formats`;
  if (!forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached) return cached;
  }

  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const data = await fetchYouTubeData(youtubeUrl);

  // Keep only formats with direct URLs
  const validFormats = data.formats.filter((f) => f.url);

  cache.set(cacheKey, { ...data, formats: validFormats });
  return { ...data, formats: validFormats };
}

// -----------------------------
// FFmpeg runner with auto-refresh
// -----------------------------
async function runFFmpeg(videoId, format, startTime, duration, res, isAudio = false) {
  // Refresh URL if expired
  if (isUrlExpired(format.url)) {
    console.log(`Refreshing expired URL for ${videoId} (${format.quality})`);
    const refreshed = await getVideoFormats(videoId, true);
    const freshFormat = refreshed.formats.find(
      (f) => f.quality === format.quality && f.type === format.type
    );
    if (freshFormat) format = freshFormat;
  }

  const baseArgs = [
    '-hide_banner',
    '-loglevel', 'error', // only show fatal errors
    '-ss', startTime.toString(),
    '-t', duration.toString(),
    '-i', format.url,
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5'
  ];

  let args;
  if (isAudio) {
    args = [...baseArgs, '-c:a', 'aac', '-vn', '-f', 'adts', 'pipe:1'];
    res.set({ 'Content-Type': 'audio/aac', 'Access-Control-Allow-Origin': '*' });
  } else {
    args = [...baseArgs, '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-f', 'mpegts', 'pipe:1'];
    res.set({ 'Content-Type': 'video/mp2t', 'Access-Control-Allow-Origin': '*' });
  }

  const ffmpeg = spawn(ffmpegStatic, args);

  ffmpeg.stdout.pipe(res);
  ffmpeg.stderr.on('data', (d) => {
    const msg = d.toString();
    if (!msg.includes('No trailing CRLF found')) {
      console.error('FFmpeg:', msg);
    }
  });

  ffmpeg.on('close', (code) => {
    if (code !== 0) {
      console.error(`FFmpeg exited with code ${code}`);
    }
  });

  res.on('close', () => {
    ffmpeg.kill('SIGTERM');
  });
}

// -----------------------------
// HLS Master Manifest
// -----------------------------
app.get('/stream/:videoId/master.m3u8', async (req, res) => {
  try {
    const { videoId } = req.params;
    const data = await getVideoFormats(videoId);

    const videoQualities = ['360p', '480p', '720p', '1080p'];
    const duration = data.duration;

    let manifest = `#EXTM3U\n#EXT-X-VERSION:3\n`;
    manifest += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="/stream/${videoId}/audio.m3u8"\n`;

    for (const q of videoQualities) {
      const f = data.formats.find((f) => f.quality.includes(q) && f.type === 'video_with_audio');
      if (!f) continue;

      let bandwidth;
      switch (q) {
        case '360p': bandwidth = 800000; break;
        case '480p': bandwidth = 1400000; break;
        case '720p': bandwidth = 2800000; break;
        case '1080p': bandwidth = 5000000; break;
        default: bandwidth = 1000000;
      }

      manifest += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${q.replace('p','')}x${parseInt(q)},CODECS="avc1.42e01e,mp4a.40.2",AUDIO="audio"\n`;
      manifest += `/stream/${videoId}/${q}.m3u8\n`;
    }

    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
    });
    res.send(manifest);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -----------------------------
// Variant playlists
// -----------------------------
app.get('/stream/:videoId/:quality.m3u8', async (req, res) => {
  try {
    const { videoId, quality } = req.params;
    const data = await getVideoFormats(videoId);

    const format = data.formats.find((f) => f.quality.includes(quality) && f.type === 'video_with_audio');
    if (!format) throw new Error('Format not available');

    const duration = data.duration;
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
/stream/${videoId}/segment${i}_${quality}.ts
`;
    }

    manifest += '#EXT-X-ENDLIST\n';

    res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' });
    res.send(manifest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------
// Audio playlist
// -----------------------------
app.get('/stream/:videoId/audio.m3u8', async (req, res) => {
  try {
    const { videoId } = req.params;
    const data = await getVideoFormats(videoId);

    const format = data.formats.find((f) => f.type === 'audio');
    if (!format) throw new Error('Audio format not available');

    const duration = data.duration;
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
/stream/${videoId}/asegment${i}.aac
`;
    }

    manifest += '#EXT-X-ENDLIST\n';

    res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' });
    res.send(manifest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------
// Segment endpoints
// -----------------------------
app.get('/stream/:videoId/segment:segNum_:quality.ts', async (req, res) => {
  try {
    const { videoId, segNum, quality } = req.params;
    const segIndex = parseInt(segNum, 10);

    const data = await getVideoFormats(videoId);
    let format = data.formats.find((f) => f.quality.includes(quality) && f.type === 'video_with_audio');
    if (!format) throw new Error('Format not available');

    const segDuration = 10;
    const startTime = segIndex * segDuration;

    await runFFmpeg(videoId, format, startTime, segDuration, res, false);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/stream/:videoId/asegment:segNum.aac', async (req, res) => {
  try {
    const { videoId, segNum } = req.params;
    const segIndex = parseInt(segNum, 10);

    const data = await getVideoFormats(videoId);
    let format = data.formats.find((f) => f.type === 'audio');
    if (!format) throw new Error('Audio format not available');

    const segDuration = 10;
    const startTime = segIndex * segDuration;

    await runFFmpeg(videoId, format, startTime, segDuration, res, true);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------
// Demo HTML
// -----------------------------
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>YouTube Adaptive HLS</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
</head>
<body>
  <h1>YouTube HLS (Multi-quality + Audio)</h1>
  <input id="videoId" placeholder="Video ID" value="tTPk-fSx5gc"/>
  <button onclick="loadVideo()">Load</button>
  <br><br>
  <video id="video" controls width="640"></video>
  <div id="error" style="color:red"></div>

  <script>
    function loadVideo() {
      const id = document.getElementById('videoId').value.trim();
      const video = document.getElementById('video');
      const errorDiv = document.getElementById('error');
      const url = '/stream/' + id + '/master.m3u8';

      if (Hls.isSupported()) {
        const hls = new Hls();
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (e,d)=>{errorDiv.textContent = d.details});
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
      } else {
        errorDiv.textContent = 'HLS not supported';
      }
    }
  </script>
</body>
</html>
  `);
});

// -----------------------------
module.exports = app;

if (require.main === module) {
  app.listen(3000, () => console.log('Server running on port 3000'));
}
