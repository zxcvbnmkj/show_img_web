#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { startDevServer } from '../src/server.js'

// 版本号从 package.json 读，避免像 mkbook 那样写死在代码里、发版忘改
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const HELP = `showimg ${pkg.version} —— 本地图片预览

用法:
  showimg dev [目录]        启动预览服务（目录默认为当前目录）

选项:
  -p, --port <端口>         指定端口（默认 4690，被占用时自动顺延）
      --host <地址>         监听地址（默认 127.0.0.1，仅本机可访问）
  -v, --version             显示版本
  -h, --help                显示帮助`

function main() {
  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (err) {
    console.error(`[showimg] ${err.message}\n\n${HELP}`)
    process.exit(1)
  }
  const { values, positionals } = parsed
  if (values.version) return console.log(pkg.version)

  const [command, dir] = positionals
  if (values.help || !command) return console.log(HELP)
  if (command !== 'dev') {
    console.error(`[showimg] 未知命令：${command}\n\n${HELP}`)
    process.exit(1)
  }

  let port
  if (values.port !== undefined) {
    port = Number(values.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      console.error(`[showimg] 端口不合法：${values.port}`)
      process.exit(1)
    }
  }

  startDevServer(resolve(dir ?? '.'), { port, host: values.host }).catch((err) => {
    console.error(`[showimg] ${err.message}`)
    process.exit(1)
  })
}

main()
