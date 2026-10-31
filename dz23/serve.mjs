// Entry point of the DZ23 ingest service.
//
//   DZ23_INGEST_TOKEN=... node dz23/serve.mjs
//
// Binds 127.0.0.1 only, requires the token, stores one JSON file per experiment under dz23/data/ (gitignored).
import { createIngest } from './ingest.mjs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const authToken = process.env.DZ23_INGEST_TOKEN ?? ''
if (!authToken) {
  console.error('[dz23-ingest] refusing to start: set DZ23_INGEST_TOKEN')
  process.exit(1)
}
const { server } = createIngest({
  authToken,
  dataDir: process.env.DZ23_INGEST_DATA ?? join(here, 'data'),
})
const port = Number(process.env.DZ23_INGEST_PORT ?? 8788)
server.listen(port, '127.0.0.1', () => {
  console.log(`[dz23-ingest] listening on http://127.0.0.1:${port}`)
})