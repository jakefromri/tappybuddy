import type { IncomingMessage, ServerResponse } from 'http'

export default async function handler(_req: IncomingMessage, res: ServerResponse) {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return send(500, { error: 'no api key' })

  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    })
    const data = await response.json() as { data?: unknown[], error?: unknown }
    return send(200, { status: response.status, models: data.data?.length ?? data.error })
  } catch (err) {
    return send(500, { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) })
  }
}
