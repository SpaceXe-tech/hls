const express = require('express');
const axios = require('axios');
const { spawn } = require('child_process');
const NodeCache = require('node-cache');
const ffmpegStatic = require('ffmpeg-static');

const app = express();
const cache = new NodeCache({ stdTTL: 18000 }); // 5-hour cache

app.use(express.json());

// -----------------------------
// Fetch YouTube data (Vidfly API)
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
  return Date.now() >= expireTime - 300000; // refresh 5 mins before expiry
}

async function getVideoFormats(videoId) {
  if (!videoId.match(/^[a-zA-Z0-9_-]{11}$/)) {
    throw new Error('Invalid YouTube video ID');
  }

  const cacheKey = `${videoId}_formats`;
  let cached = cache.get(cacheKey);

  if (!cached || cached.formats.some(f => isUrlExpired(f.url))) {
    console.log(`🔄 Refreshing formats for ${videoId}`);
    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const data = await fetchYouTubeData(youtubeUrl);
    const validFormats = data.formats.filter((f) => f.url);
    cached = { ...data, formats: validFormats };
    cache.set(cacheKey, cached);
  }

  return cached;
}

// -----------------------------
// HLS Master Manifest
// -----------------------------
app.get('/stream/:videoId/master.m3u8', async (req, res) => {
  try {
    const { videoId } = req.params;
    const data = await getVideoFormats(videoId);
    const videoQualities = ['360p', '480p', '720p', '1080p'];

    let manifest = `#EXTM3U\n#EXT-X-VERSION:3\n`;

    // Audio group
    manifest += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="/stream/${videoId}/audio.m3u8"\n`;

    // Video variants
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
    console.error('Master manifest error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// -----------------------------
// Variant manifests (per quality)
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

    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
    });
    res.send(manifest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------
// Audio-only manifest
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

    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
    });
    res.send(manifest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------
// Segment generator
// -----------------------------
function runFFmpeg(url, startTime, duration, res, isAudio = false) {
  const headers = [
    "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/118 Safari/537.36",
    "Referer: https://www.youtube.com/",
    "Origin: https://www.youtube.com/",
  ];

  const baseArgs = [
    "-ss", startTime.toString(),
    "-t", duration.toString(),
    "-headers", headers.join("\r\n"),
    "-i", url
  ];

  let args;
  if (isAudio) {
    args = [...baseArgs, "-c:a", "aac", "-vn", "-f", "adts", "pipe:1"];
  } else {
    args = [...baseArgs, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-f", "mpegts", "pipe:1"];
  }

  const ffmpeg = spawn(ffmpegStatic, args);

  ffmpeg.stdout.pipe(res);
  ffmpeg.stderr.on("data", (d) => console.error("FFmpeg:", d.toString()));

  ffmpeg.on("close", (code) => {
    if (code !== 0) console.error(`FFmpeg exited with code ${code}`);
  });

  res.on("close", () => {
    ffmpeg.kill("SIGTERM");
  });
}

// Video segment
app.get('/stream/:videoId/segment:segNum_:quality.ts', async (req, res) => {
  try {
    const { videoId, segNum, quality } = req.params;
    const segIndex = parseInt(segNum, 10);

    const data = await getVideoFormats(videoId);
    const format = data.formats.find((f) => f.quality.includes(quality) && f.type === 'video_with_audio');
    if (!format) throw new Error('Format not available');

    const segDuration = 10;
    const startTime = segIndex * segDuration;

    res.set({ 'Content-Type': 'video/mp2t', 'Access-Control-Allow-Origin': '*' });
    runFFmpeg(format.url, startTime, segDuration, res, false);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Audio segment
app.get('/stream/:videoId/asegment:segNum.aac', async (req, res) => {
  try {
    const { videoId, segNum } = req.params;
    const segIndex = parseInt(segNum, 10);

    const data = await getVideoFormats(videoId);
    const format = data.formats.find((f) => f.type === 'audio');
    if (!format) throw new Error('Audio format not available');

    const segDuration = 10;
    const startTime = segIndex * segDuration;

    res.set({ 'Content-Type': 'audio/aac', 'Access-Control-Allow-Origin': '*' });
    runFFmpeg(format.url, startTime, segDuration, res, true);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------
// HTML Player
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
  app.listen(3000, () => console.log('🚀 Server running on http://localhost:3000'));
}
