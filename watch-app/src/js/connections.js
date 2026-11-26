import { sGet, sSet } from './store'

export async function readConnection(mode) {
  const phone = mode === 'hub'
  const [host, token, owner] = await Promise.all([
    sGet(phone ? 'hubHost' : 'host', ''),
    sGet(phone ? 'hubToken' : 'token', ''),
    sGet(phone ? 'hubOwner' : 'directOwner', '')
  ])
  if (!host) return null
  return { host, token, owner: owner || connectionOwner({ host, token }) }
}

export function connectionOwner(connection) {
  return connection && (connection.owner || JSON.stringify([connection.host, connection.token || '']))
}

export async function readDevice() {
  const [direct, hub, selected] = await Promise.all([
    readConnection('direct'), readConnection('hub'), sGet('pairMode', '')
  ])
  const mode = selected || (hub && hub.token ? 'hub' : 'direct')
  const connection = mode === 'hub' ? hub : mode === 'direct' ? direct : null
  return { mode, connection: connection && connection.token ? connection : null }
}

export async function savePairing(values) {
  const written = []
  for (const key of Object.keys(values)) {
    const old = await sGet(key, '')
    if (!await sSet(key, values[key])) {
      for (const item of written.reverse()) await sSet(item.key, item.old)
      throw new Error('配对设置未能写入手表')
    }
    written.push({ key, old })
  }
}
