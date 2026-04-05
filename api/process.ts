import type { IncomingMessage, ServerResponse } from 'http'
import formidable from 'formidable'
import fs from 'fs'
import OpenAI, { toFile } from 'openai'

// Tell Vercel not to parse the body — we'll handle multipart ourselves
export const config = {
  api: { bodyParser: false },
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// Word colors — cycling palette for the word buttons
const WORD_COLORS = [
  '#FF6B6B', // coral red
  '#FF9F43', // warm orange
  '#FECA57', // sunny yellow
  '#48DBFB', // sky blue
  '#54A0FF', // bright blue
  '#5F27CD', // purple
  '#00D2D3', // teal
  '#1DD1A1', // mint green
  '#FF9FF3', // pink
  '#A29BFE', // lavender
]

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const send = (status: number, body: unknown) => {
    const json = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(json)
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' })
    res.end()
    return
  }

  if (req.method !== 'POST') {
    return send(405, { error: 'Method not allowed' })
  }

  if (!process.env.OPENAI_API_KEY) {
    return send(500, { error: 'OPENAI_API_KEY not configured' })
  }

  // Parse multipart form data
  const form = formidable({
    maxFileSize: 10 * 1024 * 1024, // 10MB max
    keepExtensions: true,
  })

  let audioFilePath: string
  let audioMimeType: string
  try {
    const [, files] = await form.parse(req)
    const audioFile = files.audio?.[0]
    if (!audioFile) {
      return send(400, { error: 'No audio file provided' })
    }
    audioFilePath = audioFile.filepath
    audioMimeType = audioFile.mimetype || 'audio/webm'
  } catch {
    return send(400, { error: 'Failed to parse audio upload' })
  }

  try {
    // Step 1: Transcribe with Whisper
    const ext = audioMimeType.includes('mp4') ? 'mp4'
      : audioMimeType.includes('ogg') ? 'ogg'
      : audioMimeType.includes('wav') ? 'wav'
      : 'webm'
    const audioBuffer = fs.readFileSync(audioFilePath)
    const audioFile = await toFile(audioBuffer, `audio.${ext}`, { type: audioMimeType })
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1',
      response_format: 'text',
    })

    const transcript = (transcription as unknown as string).trim()
    if (!transcript) {
      return send(422, { error: 'Could not hear any words. Try saying it again.' })
    }

    // Step 2: Split into words (strip punctuation so TTS sounds natural)
    const words = transcript
      .split(/\s+/)
      .map((w: string) => w.replace(/[^a-zA-Z0-9''-]/g, '').trim())
      .filter(Boolean)

    if (words.length === 0) {
      return send(422, { error: 'No words found. Try again!' })
    }

    // Step 3: Generate TTS audio for each word in parallel
    const wordData = await Promise.all(
      words.map(async (word: string, i: number) => {
        const response = await openai.audio.speech.create({
          model: 'tts-1',
          voice: 'nova',
          input: word,
          speed: 0.85, // slightly slower for easier comprehension
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

    // Clean up temp file
    try { fs.unlinkSync(audioFilePath) } catch { /* ignore */ }

    return send(200, { words: wordData, transcript })
  } catch (err) {
    try { fs.unlinkSync(audioFilePath) } catch { /* ignore */ }
    console.error('Processing error:', err)
    const debug = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    return send(500, { error: 'Something went wrong. Try again!', debug })
  }
}
