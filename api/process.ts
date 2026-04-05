import type { IncomingMessage, ServerResponse } from 'http'
import formidable from 'formidable'
import fs from 'fs'

export const config = {
  api: { bodyParser: false },
}

const WORD_COLORS = [
  '#FF6B6B', '#FF9F43', '#FECA57', '#48DBFB', '#54A0FF',
  '#5F27CD', '#00D2D3', '#1DD1A1', '#FF9FF3', '#A29BFE',
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

  if (req.method !== 'POST') return send(405, { error: 'Method not allowed' })

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return send(500, { error: 'OPENAI_API_KEY not configured' })

  // Parse multipart
  const form = formidable({ maxFileSize: 10 * 1024 * 1024, keepExtensions: true })
  let audioFilePath: string
  let audioMimeType: string
  try {
    const [, files] = await form.parse(req)
    const audioFile = files.audio?.[0]
    if (!audioFile) return send(400, { error: 'No audio file provided' })
    audioFilePath = audioFile.filepath
    audioMimeType = audioFile.mimetype || 'audio/webm'
  } catch {
    return send(400, { error: 'Failed to parse audio upload' })
  }

  try {
    const ext = audioMimeType.includes('mp4') ? 'mp4'
      : audioMimeType.includes('ogg') ? 'ogg'
      : audioMimeType.includes('wav') ? 'wav'
      : 'webm'

    // Step 1: Transcribe with Whisper via raw fetch
    const audioBuffer = fs.readFileSync(audioFilePath)
    const whisperForm = new FormData()
    whisperForm.append('model', 'whisper-1')
    whisperForm.append('response_format', 'text')
    whisperForm.append('file', new Blob([audioBuffer], { type: audioMimeType }), `audio.${ext}`)

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: whisperForm,
    })

    if (!whisperRes.ok) {
      const err = await whisperRes.text()
      throw new Error(`Whisper error ${whisperRes.status}: ${err}`)
    }

    const transcript = (await whisperRes.text()).trim()
    if (!transcript) return send(422, { error: 'Could not hear any words. Try saying it again.' })

    // Step 2: Split into words
    const words = transcript
      .split(/\s+/)
      .map((w: string) => w.replace(/[^a-zA-Z0-9''-]/g, '').trim())
      .filter(Boolean)

    if (words.length === 0) return send(422, { error: 'No words found. Try again!' })

    // Step 3: TTS for each word in parallel via raw fetch
    const wordData = await Promise.all(
      words.map(async (word: string, i: number) => {
        const ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'tts-1', voice: 'nova', input: word, speed: 0.85 }),
        })
        if (!ttsRes.ok) throw new Error(`TTS error ${ttsRes.status}`)
        const buffer = Buffer.from(await ttsRes.arrayBuffer())
        return {
          text: word,
          audioBase64: buffer.toString('base64'),
          position: i,
          color: WORD_COLORS[i % WORD_COLORS.length],
        }
      })
    )

    try { fs.unlinkSync(audioFilePath) } catch { /* ignore */ }
    return send(200, { words: wordData, transcript })

  } catch (err) {
    try { fs.unlinkSync(audioFilePath) } catch { /* ignore */ }
    console.error('Processing error:', err)
    const debug = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    return send(500, { error: 'Something went wrong. Try again!', debug })
  }
}
