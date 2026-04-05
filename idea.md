# sentence-builder — idea

## what it is

a tablet-first web app to help my son (8yo, ASD) practice writing longer sentences. he can say a full sentence out loud but loses the next word in his head when he's actually writing. this bridges that gap.

## how it works

1. he taps "record" and says his sentence
2. the app sends the audio to openai whisper for transcription
3. each word gets its own TTS audio clip (via openai tts)
4. the app displays one big button per word, left to right
5. he taps each word button to hear it again while he writes

## design principles

- huge buttons, high contrast, zero clutter
- no navigation, no accounts, no history
- one thing on screen at a time
- predictable behavior every time

## tech

- vite + react + typescript + shadcn/ui
- vercel serverless function for ai processing (whisper + tts)
- no database, no auth — sessions are ephemeral and in-memory

## status

kicked off 2026-04-05. local dev first, custom domain later.
