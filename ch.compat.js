const axios = require('axios');
const fs = require('fs');
const {exec} = require('child_process')
const composeYaml = `version: '2.1'
services:
  clickhouse-seed:
    image: clickhouse/clickhouse-server:__CH_VER__
    container_name: clickhouse-seed
    healthcheck:
      test: wget --no-verbose --tries=1 --spider http://localhost:8123 || exit 1
      interval: 60s
      retries: 5
      start_period: 2s
      timeout: 10s
  qryn:
    image: qxip/qryn:__QRYN_VER__
    container_name: loki
    ports:
      - "127.0.0.1:3100:3100"
    environment:
      - CLICKHOUSE_SERVER=clickhouse-seed
      - DEBUG=true
    depends_on:
      - clickhouse-seed
`

const imageVer = async (name, size, verlen) => {
  let versions = {}
  await Promise.all(new Array(10).fill(0).map(async (v, pg) => {
    let tags;
    try {
      tags = await axios.get(
        `https://registry.hub.docker.com/v2/repositories/${name}/tags/?page_size=1000&page=${pg + 1}`
      )
    } catch (e) {
      return
    }
    const verRe = new Array(verlen).fill('\\d+').join('\\.')
    tags.data.results
      .filter(t => t.name.match(new RegExp(`^${verRe}$`)))
      .forEach((v) => {
        versions[v.name.match(new RegExp(`^${verRe}`))[0]] = true
      })
  }))
  versions = Object.keys(versions)
  versions.sort((a,b) => {
    const _a = a.split('.').map(v => parseInt(v))
    const _b = b.split('.').map(v => parseInt(v))
    return _b[0] - _a[0] || _b[1] - _a[1]
  })
  versions = versions.slice(0, size)
  return versions
}

const execAsync = async (cmd, env, logfile) => {
  env = env || process.env
  let child
  await new Promise((f, r) => {
    child = exec(cmd, { env }, (error, stdout, stderr) => {
      if (logfile) {
        fs.writeFileSync(`${logfile}.stdout.log`, stdout)
        fs.writeFileSync(`${logfile}.stderr.log`, stderr)
      }
      if (child.exitCode!== 0) {
        return r(new Error(`${cmd} exited with code ${child.exitCode}`))
      }
      f();
    })
  })
}

const restoreState = (qrynVersions, chVersions) => {
  if (fs.existsSync('ch.compat.state.json')) {
    const contents = fs.readFileSync('ch.compat.state.json')
    const res = JSON.parse(new TextDecoder().decode(contents))
    while (res.length < (chVersions + 1)) {
      res.push(new Array(qrynVersions + 1).fill('0'))
    }
    for (let i = 0; i < res.length; i++) {
      while (res[i].length < (qrynVersions + 1)) {
        res[i].push('0')
      }
    }
    return res
  }
  return new Array(chVersions+1)
    .fill(0)
    .map(() => new Array(qrynVersions+1).fill('0'))
}

const saveState = (table) => {
  fs.writeFileSync('ch.compat.state.json', new TextEncoder().encode(JSON.stringify(table)))
}

(async () => {
  let qrynVersions = process.env.QRYN_VERSIONS_LEN || 5
  let chVersions = process.env.CH_VERSIONS_LEN || 15
  const {markdownTable} = await import('markdown-table')
  const chVer = await imageVer('clickhouse/clickhouse-server', chVersions, 2)
  const qrynVer = await imageVer('qxip/qryn', qrynVersions, 3)
  console.log(`CH versions: ${chVer.join(', ')}`)
  console.log(`QRYN versions: ${qrynVer.join(', ')}`)
  const table = restoreState(qrynVersions, chVersions)
  table[0][0] = 'CH \\ qryn'

  for (const [i, _chVer] of chVer.entries()) {
    table[i+1][0] = `${_chVer}`
    for (const [j, _qrynVer] of qrynVer.entries()) {
      table[0][j+1] = `${_qrynVer}`
      if (table[i+1][j+1] !== '0') {
        continue
      }
      await execAsync(`mkdir -p logs/${_chVer}/${_qrynVer}`)
      try {
        fs.writeFileSync('docker-compose.yml', composeYaml
          .replace('__CH_VER__', _chVer)
          .replace('__QRYN_VER__', _qrynVer))
        await execAsync('docker-compose up -d')
        await new Promise((f) => setTimeout(f, 10000))
        await execAsync('npm test', {
          ...process.env,
          INTEGRATION_E2E: 1,
          CLOKI_EXT_URL: '127.0.0.1:3100'
        }, `logs/${_chVer}/${_qrynVer}/jest`)
        table[i+1][j+1] = 'OK'
      } catch (e){
        console.log(`TEST FAILED: CH:${_chVer} Q:${_qrynVer}`)
        console.log(e)
        table[i+1][j+1] = 'X'
      } finally {
        let i = 0
        while (true) {
          try {
            await execAsync(`docker logs loki`, null, `logs/${_chVer}/${_qrynVer}/qryn`)
            await execAsync('docker-compose down')
            break
          } catch (e) {
            if (i < 5) {
              i++
              await new Promise((f) => setTimeout(f, 2000))
            } else {
              throw e
            }
          }
        }
        saveState(table)
      }
    }
    try { await execAsync(`docker rmi clickhouse/clickhouse-server:${_chVer}`)} catch (e) {}
  }
  console.log(markdownTable(table))
})()

