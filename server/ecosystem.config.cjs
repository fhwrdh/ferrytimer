// PM2 config for the self-hosted Ferry Timer api proxy.
//
// Reads secrets from ferrytimer.env (sibling file, chmod 600, never committed)
// so the keys live in exactly one place on the droplet. `pm2 start` / `pm2
// reload` picks up changes; run `pm2 save` after the first start so it survives
// reboots.

const fs = require('node:fs')
const path = require('node:path')

const env = { NODE_ENV: 'production', PORT: '3458' }
const envFile = path.join(__dirname, 'ferrytimer.env')
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) env[m[1]] = m[2].trim()
  }
}

module.exports = {
  apps: [
    {
      name: 'ferrytimer',
      script: 'server.mjs',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '150M',
      env,
    },
  ],
}
