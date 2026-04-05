import { useState, useRef, useCallback } from 'react'
import { Mic, MicOff, RotateCcw, Loader2, Volume2, Eye } from 'lucide-react'
import { cn } from '@/lib/utils'

// ─── Types ──────────────────────────────────────────────────────────────────

type AppState = 'idle' | 'recording' | 'processing' | 'playback' | 'error'
type Mode = 'full' | 'hidden' | 'first-letter'

interface WordData {
  text: string
  audioBase64: string
  position: number
  color: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_RECORDING_MS = 10_000
const MIME_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav']

const MODE_CONFIG: { id: Mode; label: string; hint: string }[] = [
  { id: 'full',         label: 'ABC',  hint: 'Full words'    },
  { id: 'first-letter', label: 'A__',  hint: 'First letter'  },
  { id: 'hidden',       label: '???',  hint: 'Hidden'        },
]

function getSupportedMimeType(): string {
  for (const type of MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return ''
}

// ─── WordCard ─────────────────────────────────────────────────────────────────

interface WordCardProps {
  word: WordData
  mode: Mode
  isFlipped: boolean
  isLastPlayed: boolean
  onPlay: () => void
  onFlip: () => void
}

function WordCard({ word, mode, isFlipped, isLastPlayed, onPlay, onFlip }: WordCardProps) {
  if (mode === 'full') {
    // Simple tap-to-play, no flip
    return (
      <button
        onClick={onPlay}
        className={cn(
          'word-btn min-w-[120px] min-h-[120px] px-8 py-6 rounded-[1.25rem]',
          'text-white font-extrabold text-3xl shadow-lg',
          'transition-all duration-75',
          isLastPlayed && 'ring-4 ring-offset-2 ring-white/80 scale-105'
        )}
        style={{ backgroundColor: word.color }}
        aria-label={`Play word: ${word.text}`}
      >
        {word.text}
      </button>
    )
  }

  // Hidden / first-letter mode: flippable card
  const frontLabel = mode === 'first-letter'
    ? word.text.charAt(0).toUpperCase()
    : '?'

  return (
    <div
      className={cn('card-scene min-w-[120px] min-h-[120px]', isFlipped && 'is-flipped')}
      style={{ width: 'fit-content', minWidth: 120, minHeight: 120 }}
    >
      <div className="card-inner" style={{ minWidth: 120, minHeight: 120 }}>

        {/* Front face */}
        <div
          className={cn(
            'card-face min-w-[120px] min-h-[120px] px-6 py-4 shadow-lg',
            'flex flex-col gap-2',
            isLastPlayed && 'ring-4 ring-offset-2 ring-white/60'
          )}
          style={{ backgroundColor: word.color + 'cc' }} // slightly translucent
        >
          {/* Hint label */}
          <span className="text-white font-extrabold text-5xl leading-none select-none">
            {frontLabel}
          </span>

          {/* Row of action buttons */}
          <div className="flex gap-2 mt-1">
            {/* Play audio */}
            <button
              onClick={(e) => { e.stopPropagation(); onPlay() }}
              className="flex items-center gap-1 bg-white/25 hover:bg-white/40 active:scale-95 text-white rounded-xl px-3 py-2 text-sm font-bold transition-all"
              aria-label={`Play word audio`}
            >
              <Volume2 className="w-4 h-4" />
            </button>
            {/* Flip to reveal */}
            <button
              onClick={(e) => { e.stopPropagation(); onFlip() }}
              className="flex items-center gap-1 bg-white/25 hover:bg-white/40 active:scale-95 text-white rounded-xl px-3 py-2 text-sm font-bold transition-all"
              aria-label="Reveal word"
            >
              <Eye className="w-4 h-4" strokeWidth={2} />
            </button>
          </div>
        </div>

        {/* Back face — full word */}
        <div
          className={cn(
            'card-face card-face--back min-w-[120px] min-h-[120px] px-8 py-6 shadow-lg cursor-pointer',
          )}
          style={{ backgroundColor: word.color }}
          onClick={onFlip}
        >
          <span className="text-white font-extrabold text-3xl select-none">
            {word.text}
          </span>
          <span className="text-white/60 text-xs mt-1 font-semibold">tap to flip back</span>
        </div>

      </div>
    </div>
  )
}

// ─── ModeSelector ─────────────────────────────────────────────────────────────

interface ModeSelectorProps {
  mode: Mode
  onChange: (m: Mode) => void
}

function ModeSelector({ mode, onChange }: ModeSelectorProps) {
  return (
    <div className="flex gap-3 items-center">
      {MODE_CONFIG.map(m => (
        <button
          key={m.id}
          onClick={() => onChange(m.id)}
          className={cn(
            'flex flex-col items-center gap-1 px-5 py-3 rounded-2xl font-bold text-sm transition-all',
            mode === m.id
              ? 'bg-primary text-white shadow-md scale-105'
              : 'bg-muted text-muted-foreground hover:bg-muted/70'
          )}
          aria-pressed={mode === m.id}
        >
          <span className="text-xl font-mono">{m.label}</span>
          <span className="text-xs">{m.hint}</span>
        </button>
      ))}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function SentenceBuilder() {
  const [appState, setAppState]     = useState<AppState>('idle')
  const [words, setWords]           = useState<WordData[]>([])
  const [errorMsg, setErrorMsg]     = useState('')
  const [lastPlayedIdx, setLastPlayedIdx] = useState<number | null>(null)
  const [micDenied, setMicDenied]   = useState(false)
  const [mode, setMode]             = useState<Mode>('full')
  const [flippedCards, setFlippedCards] = useState<Set<number>>(new Set())

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef        = useRef<Blob[]>([])
  const stopTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null)
  const audioRef         = useRef<HTMLAudioElement | null>(null)

  // ── Recording ──────────────────────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    setErrorMsg('')
    setWords([])
    setLastPlayedIdx(null)
    setFlippedCards(new Set())

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setMicDenied(true)
      setAppState('error')
      setErrorMsg('We need the microphone to hear your sentence.')
      return
    }

    const mimeType = getSupportedMimeType()
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    mediaRecorderRef.current = recorder
    chunksRef.current = []

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }

    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop())
      const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' })
      await processAudio(blob)
    }

    recorder.start()
    setAppState('recording')

    stopTimerRef.current = setTimeout(() => {
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
    }, MAX_RECORDING_MS)
  }, [])

  const stopRecording = useCallback(() => {
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
    setAppState('processing')
  }, [])

  // ── AI Processing ──────────────────────────────────────────────────────────

  const processAudio = async (blob: Blob) => {
    setAppState('processing')

    const formData = new FormData()
    const ext = blob.type.includes('mp4') ? 'mp4'
      : blob.type.includes('ogg') ? 'ogg'
      : blob.type.includes('wav') ? 'wav'
      : 'webm'
    formData.append('audio', blob, `recording.${ext}`)

    try {
      const res = await fetch('/api/process', { method: 'POST', body: formData })
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Oops! Let's try saying it again." }))
        throw new Error(error)
      }
      const data = await res.json()
      setWords(data.words)
      setAppState('playback')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Oops! Let's try saying it again.")
      setAppState('error')
    }
  }

  // ── Playback ───────────────────────────────────────────────────────────────

  const playWord = useCallback((word: WordData) => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
    setLastPlayedIdx(word.position)
    const audio = new Audio(`data:audio/mp3;base64,${word.audioBase64}`)
    audioRef.current = audio
    audio.play().catch(console.error)
  }, [])

  const toggleFlip = useCallback((position: number) => {
    setFlippedCards(prev => {
      const next = new Set(prev)
      next.has(position) ? next.delete(position) : next.add(position)
      return next
    })
  }, [])

  // ── Reset ──────────────────────────────────────────────────────────────────

  const reset = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
    setAppState('idle')
    setWords([])
    setErrorMsg('')
    setLastPlayedIdx(null)
    setMicDenied(false)
    setFlippedCards(new Set())
  }, [])

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 select-none">

      {/* ── IDLE STATE ─────────────────────────────────────── */}
      {appState === 'idle' && (
        <div className="flex flex-col items-center gap-8">
          {/* Tappy mascot + app name */}
          <div className="flex flex-col items-center gap-2">
            <img
              src="/tappy.png"
              alt="Tappy"
              className="w-28 h-28 object-contain drop-shadow-lg"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
            <h1 className="text-4xl font-extrabold text-primary tracking-tight">TappyBuddy</h1>
          </div>

          <p className="text-2xl font-bold text-center text-foreground/70">
            Say your sentence
          </p>

          {/* Mode picker */}
          <ModeSelector mode={mode} onChange={setMode} />

          <button
            onClick={startRecording}
            className="w-48 h-48 rounded-full bg-primary shadow-xl flex items-center justify-center text-white hover:bg-primary/90 active:scale-95 transition-transform"
            aria-label="Start recording"
          >
            <Mic className="w-20 h-20" strokeWidth={1.5} />
          </button>
          <p className="text-lg text-muted-foreground font-medium">Tap to start</p>
        </div>
      )}

      {/* ── RECORDING STATE ────────────────────────────────── */}
      {appState === 'recording' && (
        <div className="flex flex-col items-center gap-10">
          <p className="text-3xl font-bold text-center text-foreground/80">I'm listening…</p>
          <button
            onClick={stopRecording}
            className="w-48 h-48 rounded-full bg-red-500 shadow-xl flex items-center justify-center text-white recording-pulse hover:bg-red-600 active:scale-95 transition-transform"
            aria-label="Stop recording"
          >
            <MicOff className="w-20 h-20" strokeWidth={1.5} />
          </button>
          <p className="text-lg text-muted-foreground font-medium">Tap to stop</p>
        </div>
      )}

      {/* ── PROCESSING STATE ───────────────────────────────── */}
      {appState === 'processing' && (
        <div className="flex flex-col items-center gap-8">
          <Loader2 className="w-24 h-24 text-primary spin" strokeWidth={1.5} />
          <p className="text-2xl font-bold text-foreground/70">Getting your words ready…</p>
        </div>
      )}

      {/* ── PLAYBACK STATE ─────────────────────────────────── */}
      {appState === 'playback' && (
        <div className="flex flex-col items-center gap-10 w-full max-w-4xl">

          {/* Mode switcher — stays visible so they can change mid-session */}
          <ModeSelector mode={mode} onChange={(m) => { setMode(m); setFlippedCards(new Set()) }} />

          {/* Word cards */}
          <div className="flex flex-wrap justify-center gap-5 w-full">
            {words.map((word) => (
              <WordCard
                key={word.position}
                word={word}
                mode={mode}
                isFlipped={flippedCards.has(word.position)}
                isLastPlayed={lastPlayedIdx === word.position}
                onPlay={() => playWord(word)}
                onFlip={() => toggleFlip(word.position)}
              />
            ))}
          </div>

          {/* New sentence */}
          <button
            onClick={reset}
            className="flex items-center gap-2 border-2 border-input bg-background text-foreground hover:bg-muted active:scale-95 transition-all h-16 px-8 py-4 text-xl rounded-xl font-semibold mt-2"
          >
            <RotateCcw className="w-5 h-5" />
            New sentence
          </button>
        </div>
      )}

      {/* ── ERROR STATE ────────────────────────────────────── */}
      {appState === 'error' && (
        <div className="flex flex-col items-center gap-8 text-center max-w-sm">
          <p className="text-6xl">😬</p>
          <p className="text-2xl font-bold text-foreground/80 leading-snug">{errorMsg}</p>
          {!micDenied && (
            <button
              onClick={reset}
              className="flex items-center gap-3 bg-primary text-white h-24 px-10 py-6 text-2xl rounded-2xl font-semibold shadow-md hover:bg-primary/90 active:scale-95 transition-all"
            >
              <RotateCcw className="w-6 h-6" />
              Try again
            </button>
          )}
          {micDenied && (
            <p className="text-base text-muted-foreground">
              Check your browser settings to allow microphone access, then refresh the page.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
