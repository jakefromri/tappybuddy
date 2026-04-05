/**
 * Local dev server for the /api/process endpoint.
 * Run with: node dev-server.mjs
 * Vite proxies /api/* here (see vite.config.ts).
 */

import http from 'http'
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env manually (no dotenv dep needed)
try {
  const envPath = resolve(__dirname, '.env')
  const envContent = readFileSync(envPath, 'utf-8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    if (key && !process.env[key]) process.env[key] = val
  }
  console.log('✅ Loaded .env')
} catch {
  console.warn('⚠️  No .env file found — make sure OPENAI_API_KEY is set in your environment')
}

// Dynamically import the handler (compiled via tsx/ts-node or via register)
// We use a small shim to run the TypeScript handler via tsx if available,
// otherwise fall back to a require-based approach.

const PORT = 3001

// Since we can't easily import TS from mjs without tsx, we inline the handler logic here.
// This mirrors api/process.ts exactly but as plain JS so it runs without a build step.

const require = createRequire(import.meta.url)

let formidable, OpenAI, toFile, fs, path

try {
  formidable = require('formidable')
  const openaiModule = require('openai')
  OpenAI = openaiModule.default || openaiModule.OpenAI
  toFile = openaiModule.toFile
  fs = require('fs')
  path = require('path')
} catch (e) {
  console.error('Missing deps. Run: npm install')
  process.exit(1)
}

const WORD_COLORS = [
  '#FF6B6B', '#FF9F43', '#FECA57', '#48DBFB', '#54A0FF',
  '#5F27CD', '#00D2D3', '#1DD1A1', '#FF9FF3', '#A29BFE',
]

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    const json = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    })
    res.end(json)
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return
  }

  if (req.url !== '/api/process') {
    return send(404, { error: 'Not found' })
  }

  if (req.method !== 'POST') {
    return send(405, { error: 'Method not allowed' })
  }

  if (!process.env.OPENAI_API_KEY) {
    return send(500, { error: 'OPENAI_API_KEY not set in .env' })
  }

  // Parse multipart
  const form = new formidable.IncomingForm
    ? new formidable.IncomingForm({ maxFileSize: 10 * 1024 * 1024, keepExtensions: true })
    : formidable({ maxFileSize: 10 * 1024 * 1024, keepExtensions: true })

  let audioFilePath
  try {
    const result = await new Promise((resolve, reject) => {
      // formidable v3 supports promises; v2 uses callbacks
      if (form.parse.length === 1) {
        form.parse(req).then(([, files]) => resolve(files)).catch(reject)
      } else {
        form.parse(req, (err, _fields, files) => err ? reject(err) : resolve(files))
      }
    })
    const audioFile = result.audio?.[0] || result.audio
    if (!audioFile) return send(400, { error: 'No audio file provided' })
    audioFilePath = audioFile.filepath || audioFile.path
  } catch (e) {
    console.error('Form parse error:', e)
    return send(400, { error: 'Failed to parse audio upload' })
  }

  try {
    // Transcribe — use native fetch + FormData instead of the OpenAI SDK,
    // which uses node-fetch internally and causes ECONNRESET on multipart uploads
    console.log('🎤 Transcribing...')
    const ext = path.extname(audioFilePath).replace('.', '') || 'webm'
    const mimeType = ext === 'mp4' ? 'audio/mp4'
      : ext === 'ogg' ? 'audio/ogg'
      : ext === 'wav' ? 'audio/wav'
      : 'audio/webm'

    const audioBuffer = fs.readFileSync(audioFilePath)
    const audioBlob = new Blob([audioBuffer], { type: mimeType })
    const formData = new FormData()
    formData.append('file', audioBlob, `recording.${ext}`)
    formData.append('model', 'whisper-1')
    formData.append('response_format', 'text')

    console.log(`   Audio: ${audioBuffer.length} bytes, type: ${mimeType}`)

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: formData,
    })

    if (!whisperRes.ok) {
      const errText = await whisperRes.text()
      console.error('Whisper API error:', whisperRes.status, errText)
      return send(500, { error: 'Transcription failed. Try again!' })
    }

    const transcript = (await whisperRes.text()).trim()
    console.log('📝 Transcript:', transcript)

    if (!transcript) return send(422, { error: 'Could not hear any words. Try saying it again.' })

    const words = transcript
      .split(/\s+/)
      .map(w => w.replace(/[^a-zA-Z0-9''\-]/g, '').trim())
      .filter(Boolean)

    if (words.length === 0) return send(422, { error: 'No words found. Try again!' })

    // TTS per word
    console.log(`🔊 Generating audio for ${words.length} word(s):`, words)
    const wordData = await Promise.all(
      words.map(async (word, i) => {
        const response = await openai.audio.speech.create({
          model: 'tts-1',
          voice: 'nova',
          input: word,
          speed: 0.85,
        })
        const buffer = Buffer.from(await response.arrayBuffer())
        return {
          text: word,
          audioBase64: buffer.toString('base64'),
          position: i,
          color: WORD_COLORS[i % WORD_COLORS.length],
        }
      })
    )

    try { fs.unlinkSync(audioFilePath) } catch {}
    console.log('✅ Done. Sending', wordData.length, 'words.')
    return send(200, { words: wordData, transcript })

  } catch (err) {
    try { fs.unlinkSync(audioFilePath) } catch {}
    console.error('Processing error:', err)
    return send(500, { error: 'Something went wrong. Try again!' })
  }
})

server.listen(PORT, () => {
  console.log(`\n🚀 API dev server running at http://localhost:${PORT}`)
  console.log('   Handles: POST /api/process\n')
})
