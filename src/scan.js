import { readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'

/** 图片扩展名 → MIME；扫描（判定是否图片）与静态服务（Content-Type）共用 */
export const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
}

/** 不进入的目录：依赖与构建产物，里面的图片几乎从来不是用户想看的 */
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', '__pycache__'])

/** 路径中是否含被忽略的段（隐藏文件/目录或 IGNORED_DIRS）；watch 事件过滤也用它 */
export function isIgnoredPath(relPath) {
  return relPath.split(/[/\\]/).some((seg) => seg.startsWith('.') || IGNORED_DIRS.has(seg))
}

const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true })

/**
 * 最多进入多少个目录。页面里可以随手粘贴任意路径，粘个 `/` 或 `~` 会把整块磁盘扫一遍、页面卡死；
 * 到上限就停，返回已扫到的部分并标 truncated，由页面提示用户换个更具体的目录。
 */
const MAX_DIRS = 5000

/**
 * 递归扫描 root 下的图片，返回 { tree, truncated }。
 * 树节点：{ name, path, images: [{ name, path }], dirs: [节点], total }，path 一律相对 root、以 / 分隔。
 * 不含任何图片的子目录直接剪掉，侧栏只展示「有图可看」的目录。
 * 不跟随符号链接（Dirent.isDirectory() 对链接为 false），避免链接成环时无限递归。
 */
export async function scanImages(root) {
  const budget = { dirsLeft: MAX_DIRS }
  const tree = await scanDir(root, '', budget)
  return { tree, truncated: budget.dirsLeft < 0 }
}

async function scanDir(root, rel, budget) {
  const node = { name: rel ? rel.slice(rel.lastIndexOf('/') + 1) : '.', path: rel, images: [], dirs: [], total: 0 }
  if (--budget.dirsLeft < 0) return node
  // 无权限 / 扫描途中被删的目录当作空目录，不让一个坏目录拖垮整棵树
  const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => [])
  entries.sort(byName)

  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    if (isIgnoredPath(entry.name)) continue
    if (entry.isDirectory()) {
      const child = await scanDir(root, childRel, budget)
      if (child.total > 0) {
        node.dirs.push(child)
        node.total += child.total
      }
    } else if (entry.isFile() && IMAGE_MIME[extname(entry.name).toLowerCase()]) {
      node.images.push({ name: entry.name, path: childRel })
      node.total += 1
    }
  }
  return node
}
