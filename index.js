const express = require('express');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs-extra');
const path = require('path');
const NodeCache = require('node-cache');
const { v4: uuidv4 } = require('uuid'); // Added for unique request IDs
const morgan = require('morgan'); // Added for request logging

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const cache = new NodeCache({ stdTTL: 86400 }); // 24 hour cache
const HLS_DIR = path.join(__dirname, 'hls-content');

// Middleware
app.use(morgan('dev')); // Request logging
app.use(express.json());
app.use(express.static('public')); // Serve static files

// Ensure HLS directory exists
fs.ensureDirSync(HLS_DIR);

// Error handling middleware
const errorHandler = (error, req, res, next) => {
  console.error(`[${uuidv4()}] Error:`, error);
  res.status(500).json({ error: 'Internal server error' });
};

// Fetch YouTube data with retry mechanism
async function fetchYouTubeData(url, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
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
          timeout: 10000, // Added timeout
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
      if (i === retries - 1) throw new Error(`API request failed: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// Convert video to HLS format with optimized settings
async function convertToHLS(videoUrl, videoId, quality = '720p') {
  const videoDir = path.join(HLS_DIR, videoId);
  const outputPath = path.join(videoDir, 'master.m3u8');

  if (await fs.pathExists(outputPath)) {
    console.log(`Video ${videoId} already converted`);
    return outputPath;
  }

  await fs.ensureDir(videoDir);

  return new Promise((resolve, reject) => {
    console.log(`Starting HLS conversion for ${videoId}`);

    ffmpeg(videoUrl)
      .outputOptions([
        '-c:v copy',
        '-c:a aac',
        '-b:a 128k',
        '-ac 2',
        '-ar 48000',
        '-start_number 0',
        '-hls_time 6', // Reduced segment duration for better seeking
        '-hls_list_size 0',
        '-hls_segment_type fmp4',
        '-hls_segment_filename', path.join(videoDir, 'segment_%04d.ts'),
        '-master_pl_name master.m3u8',
        '-f hls',
      ])
      .output(outputPath)
      .on('start', (cmd) => console.log(`[${videoId}] FFmpeg command:`, cmd))
      .on('progress', (progress) => {
        if (progress.percent) {
          console.log(`[${videoId}] Processing: ${Math.floor(progress.percent)}%`);
        }
      })
      .on('end', () => {
        console.log(`[${videoId}] HLS conversion completed`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error(`[${videoId}] FFmpeg error:`, err.message);
        fs.remove(videoDir).catch(() => {});
        reject(new Error(`HLS conversion failed: ${err.message}`));
      })
      .run();
  });
}

// Process video endpoint
app.post('/api/process', async (req, res, next) => {
  const requestId = uuidv4();
  console.log(`[${requestId}] Processing request`);

  try {
    const { youtubeUrl, quality = '720p' } = req.body;

    if (!youtubeUrl) {
      return res.status(400).json({ error: 'YouTube URL is required' });
    }

    const videoIdMatch = youtubeUrl.match(/[?&]v=([^&]+)/);
    if (!videoIdMatch) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const videoId = videoIdMatch[1];

    // Check cache
    const cachedData = cache.get(videoId);
    if (cachedData) {
      return res.json({
        videoId,
        streamUrl: `/stream/${videoId}/master.m3u8`,
        cached: true,
        ...cachedData,
      });
    }

    // Fetch video data
    const videoData = await fetchYouTubeData(youtubeUrl);

    // Find best format
    let format = videoData.formats.find(
      (f) => f.quality.includes(quality) && f.type === 'video_with_audio'
    ) || videoData.formats.find((f) => f.type === 'video_with_audio');

    if (!format) {
      return res.status(404).json({ error: 'No suitable video format found' });
    }

    // Convert to HLS
    await convertToHLS(format.url, videoId, quality);

    // Cache the result
    cache.set(videoId, {
      title: videoData.title,
      thumbnail: videoData.thumbnail,
      duration: videoData.duration,
    });

    res.json({
      videoId,
      streamUrl: `/stream/${videoId}/master.m3u8`,
      title: videoData.title,
      thumbnail: videoData.thumbnail,
      duration: videoData.duration,
    });
  } catch (error) {
    next(error);
  }
});

// Serve HLS manifest
app.get('/stream/:videoId/master.m3u8', async (req, res, next) => {
  try {
    const { videoId } = req.params;
    const manifestPath = path.join(HLS_DIR, videoId, 'master.m3u8');

    if (!await fs.pathExists(manifestPath)) {
      return res.status(404).json({ error: 'Video not found' });
    }

    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });

    const content = await fs.readFile(manifestPath, 'utf8');
    res.send(content);
  } catch (error) {
    next(error);
  }
});

// Serve TS segments
app.get('/stream/:videoId/:segment', async (req, res, next) => {
  try {
    const { videoId, segment } = req.params;
    const segmentPath = path.join(HLS_DIR, videoId, segment);

    if (!await fs.pathExists(segmentPath)) {
      return res.status(404).json({ error: 'Segment not found' });
    }

    res.set({
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'public, max-age=31536000',
      'Access-Control-Allow-Origin': '*',
    });

    fs.createReadStream(segmentPath).pipe(res);
  } catch (error) {
    next(error);
  }
});

// Get video info
app.get('/api/info/:videoId', async (req, res, next) => {
  try {
    const { videoId } = req.params;
    const cachedData = cache.get(videoId);

    if (cachedData) {
      return res.json(cachedData);
    }
    res.status(404).json({ error: 'Video info not found' });
  } catch (error) {
    next(error);
  }
});

// Error handling middleware
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HLS Streaming Server running on http://localhost:${PORT}`);
  console.log(`HLS files stored in: ${HLS_DIR}`);
});
