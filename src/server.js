import { createReadStream, watch } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { basename, extname, resolve, sep } from 'node:path'
import { IMAGE_MIME, isIgnoredPath, scanImages } from './scan.js'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 4690
const PORT_ATTEMPTS = 10
const ASSETS_DIR = new URL('../assets/', import.meta.url)

/** 页面自身的静态资源：URL → [文件名, Content-Type] */
const PAGE_ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/__showimg/client.js': ['client.js', 'text/javascript; charset=utf-8'],
  '/__showimg/style.css': ['style.css', 'text/css; charset=utf-8'],
}

// ---------- 端口探测（思路同 mkbook src/server/dev.ts） ----------

/** 试连一个回环地址；连上即说明已有进程在监听 */
function probe(port, host) {
  return new Promise((done) => {
    const sock = connect({ port, host })
    const finish = (inUse) => {
      sock.destroy()
      done(inUse)
    }
    sock.setTimeout(300)
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
    sock.once('timeout', () => finish(false))
  })
}

/**
 * 端口是否已被占用。不能只靠 listen 报 EADDRINUSE：macOS 上我们的 127.0.0.1 能与别人的 ::1 共存，
 * 而浏览器访问 localhost 常先走 ::1，会打到别人的服务上。故两个回环地址都试连。
 */
async function isPortInUse(port) {
  return (await Promise.all([probe(port, '127.0.0.1'), probe(port, '::1')])).some(Boolean)
}

function listenOnce(server, port, host) {
  return new Promise((done, reject) => {
    const onError = (err) => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      done()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/** 依次试候选端口，返回成功监听的端口；全被占返回 null */
async function tryListen(server, ports, host) {
  for (const port of ports) {
    if (await isPortInUse(port)) continue
    try {
      await listenOnce(server, port, host)
      return port
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err
    }
  }
  return null
}

// ---------- 请求处理 ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** 拆出请求的路径与查询参数；畸形百分号编码返回 null（否则 URIError 会打崩整个服务） */
function parseRequestUrl(rawUrl) {
  try {
    const url = new URL(rawUrl ?? '/', 'http://localhost')
    return { path: decodeURIComponent(url.pathname), query: url.searchParams }
  } catch {
    return null
  }
}

/**
 * 只接受以本机名访问的请求（Host 为 localhost / 回环 IP / 启动时 --host 指定的地址）。
 * 页面能打开本机任意目录，若不校验 Host，恶意网页可用 DNS 重绑定把自己的域名指到 127.0.0.1 来读你的图片。
 */
function isAllowedHost(hostHeader, listenHost) {
  if (!hostHeader) return false
  const name = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return name === 'localhost' || name === '::1' || name.startsWith('127.') || name === listenHost
}

/**
 * 把页面传来的目录字符串解析成绝对路径并校验是目录；空串表示启动目录。
 * 兼容几种常见粘贴形态：~ 开头、两侧带引号、终端拖拽产生的 `\ ` 转义；相对路径相对启动目录。
 */
async function resolveRoot(raw, defaultRoot) {
  let p = (raw ?? '').trim()
  if (!p) return defaultRoot
  if (/^(['"]).*\1$/.test(p)) p = p.slice(1, -1)
  p = p.replace(/\\(.)/g, '$1')
  if (p === '~' || p.startsWith('~/')) p = homedir() + p.slice(1)
  const abs = resolve(defaultRoot, p)
  const info = await stat(abs).catch(() => null)
  if (!info) throw new HttpError(400, `路径不存在：${abs}`)
  if (!info.isDirectory()) throw new HttpError(400, `不是目录：${abs}`)
  return abs
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(text)
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

/** 输出 root 下的一张图片；越出 root 的路径（../ 穿越）与非图片一律 404 */
async function serveImage(req, res, root, relPath) {
  const filePath = resolve(root, relPath)
  const mime = IMAGE_MIME[extname(filePath).toLowerCase()]
  if (!mime || !filePath.startsWith(root === sep ? sep : root + sep)) return sendText(res, 404, '404 未找到')

  const info = await stat(filePath).catch(() => null)
  if (!info?.isFile()) return sendText(res, 404, '404 未找到')

  // no-cache + Last-Modified：图片被替换后刷新即见新图，未变化时只回 304 不重传
  const lastModified = new Date(Math.floor(info.mtimeMs / 1000) * 1000)
  const since = Date.parse(req.headers['if-modified-since'] ?? '')
  if (!Number.isNaN(since) && lastModified.getTime() <= since) {
    res.writeHead(304)
    return res.end()
  }
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': info.size,
    'Cache-Control': 'no-cache',
    'Last-Modified': lastModified.toUTCString(),
  })
  createReadStream(filePath)
    .on('error', () => res.destroy())
    .pipe(res)
}

/**
 * SSE：监听 root 的变更，防抖后通知该页面重新拉目录树。
 * 监听器跟着连接走——每个页面看自己的目录，页面关掉或换目录（连接断开）即停止监听，服务端不留状态。
 */
function serveEvents(req, res, root) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.write(': connected\n\n')

  let timer = null
  let watcher = null
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename && isIgnoredPath(filename)) return
      clearTimeout(timer)
      timer = setTimeout(() => res.write('data: change\n\n'), 200)
    })
    watcher.on('error', (err) => console.warn(`[showimg] 监听 ${root} 出错，自动刷新可能失效：${err.message}`))
  } catch (err) {
    console.warn(`[showimg] 无法监听 ${root}，自动刷新不可用：${err.message}`)
  }
  // 心跳，防止空闲连接被代理/浏览器掐断
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000)

  req.on('close', () => {
    clearTimeout(timer)
    clearInterval(heartbeat)
    watcher?.close()
  })
}

export async function startDevServer(defaultRoot, opts = {}) {
  const rootInfo = await stat(defaultRoot).catch(() => null)
  if (!rootInfo?.isDirectory()) throw new Error(`目录不存在：${defaultRoot}`)
  const host = opts.host ?? DEFAULT_HOST

  async function handleRequest(req, res) {
    if (!isAllowedHost(req.headers.host, host)) return sendText(res, 403, '403 只允许通过 localhost 访问')
    const parsed = parseRequestUrl(req.url)
    if (parsed === null) return sendText(res, 400, '400 请求路径编码有误')
    const { path, query } = parsed

    const asset = PAGE_ASSETS[path]
    if (asset) {
      const [file, contentType] = asset
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' })
      return res.end(await readFile(new URL(file, ASSETS_DIR)))
    }

    // 以下接口都带 ?root=<目录>，为空即启动目录。目录跟着页面地址走，服务端不记「当前目录」
    if (path === '/__showimg/tree') {
      let root
      try {
        root = await resolveRoot(query.get('root'), defaultRoot)
      } catch (err) {
        if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message })
        throw err
      }
      // 目录树每次请求现扫，不缓存：文件增删后客户端重新拉一次即是最新
      const { tree, truncated } = await scanImages(root)
      tree.name = basename(root) || root
      return sendJson(res, 200, { root, home: homedir(), tree, truncated })
    }

    if (path === '/__showimg/events') return serveEvents(req, res, await resolveRoot(query.get('root'), defaultRoot))

    if (path.startsWith('/img/')) {
      return serveImage(req, res, await resolveRoot(query.get('root'), defaultRoot), path.slice('/img/'.length))
    }

    sendText(res, 404, '404 未找到')
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      if (err instanceof HttpError) {
        if (!res.headersSent) return sendText(res, err.status, err.message)
        return res.end()
      }
      console.error(`[showimg] 请求处理出错 ${req.url}：${err.stack ?? err}`)
      if (!res.headersSent) sendText(res, 500, '500 服务内部错误')
      else res.end()
    })
  })

  const preferred = opts.port ?? DEFAULT_PORT
  const candidates = opts.port !== undefined ? [preferred] : Array.from({ length: PORT_ATTEMPTS }, (_, i) => preferred + i)
  const port = await tryListen(server, candidates, host)
  if (port === null) {
    throw new Error(
      opts.port !== undefined
        ? `端口 ${preferred} 已被占用，请换一个端口（-p）`
        : `端口 ${preferred}-${preferred + PORT_ATTEMPTS - 1} 均被占用，请用 -p 指定其他端口`,
    )
  }
  if (port !== preferred) console.log(`[showimg] 端口 ${preferred} 已被占用，改用 ${port}`)

  const { tree } = await scanImages(defaultRoot)
  console.log(`[showimg] 预览服务已启动：http://localhost:${port}`)
  console.log(`[showimg] 目录 ${defaultRoot}，共 ${tree.total} 张图片；页面顶部可切换到其他目录，Ctrl+C 退出`)

  const shutdown = () => {
    server.closeAllConnections?.()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
