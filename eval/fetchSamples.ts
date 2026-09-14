// npm run eval:fetch — copy the sampler's samples.jsonl from the droplet
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'

const REMOTE = 'fhwrdh@159.223.202.42:ferrytimer/data/samples.jsonl'
const LOCAL = 'eval/data/samples.jsonl'

mkdirSync('eval/data', { recursive: true })
execFileSync('scp', ['-q', REMOTE, LOCAL], { stdio: 'inherit' })
const lines = readFileSync(LOCAL, 'utf8').trim().split('\n').filter(Boolean).length
console.log(`fetched ${lines} samples into ${LOCAL}`)
