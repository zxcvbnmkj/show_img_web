/* showimg 浏览器端：拉目录树 → 主区一次显示一张、左右翻页，侧栏目录树定位 → 过滤 / 文件变更后自动刷新。
   原生 JS，不依赖框架。文件名一律走 textContent 写入，不拼 HTML，防止奇怪的文件名注入页面。 */
;(function () {
  var $ = function (id) { return document.getElementById(id) }
  var tree = $('tree')
  var photo = $('photo')
  var filterInput = $('filter')

  // 当前看的目录取自地址栏 ?dir=（空 = showimg dev 的启动目录）；换目录就是换地址，后退键可回上一个目录
  var dirParam = new URLSearchParams(location.search).get('dir') || ''
  var root = ''         // 服务端解析出的绝对路径，图片 URL 都带上它
  var truncated = false // 目录过大、只扫了一部分

  // 看图状态就这三项；其余（列表、按钮可用性、高亮）都从它们派生
  var all = []          // 全部图片 { name, path, row }，顺序与侧栏自上而下一致，翻页即按它走
  var currentPath = null
  var collapsed = {}    // 侧栏里被折叠的目录 path，刷新目录树后保持折叠状态

  /** 极简建元素：h('div', { class: 'x' }, [子节点或文本]) */
  function h(tag, attrs, children) {
    var el = document.createElement(tag)
    for (var k in attrs || {}) {
      if (k === 'class') el.className = attrs[k]
      else if (k === 'text') el.textContent = attrs[k]
      else el.setAttribute(k, attrs[k])
    }
    ;(children || []).forEach(function (c) {
      if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    })
    return el
  }

  /** 图片 URL：逐段编码，文件名里的 #、?、空格、中文都安全 */
  function imgUrl(path) {
    return '/img/' + path.split('/').map(encodeURIComponent).join('/') + '?root=' + encodeURIComponent(root)
  }

  /** 图片在本机上的绝对路径（root 为 / 时不重复斜杠） */
  function localPath(path) {
    return root.replace(/\/$/, '') + '/' + path
  }

  /** 改地址栏的 # 部分（当前图片），保留 ?dir= */
  function setHash(hash) {
    history.replaceState(null, '', location.pathname + location.search + hash)
  }

  /** 当前过滤条件下可翻的图片 */
  function visibleList() {
    var q = filterInput.value.trim().toLowerCase()
    if (!q) return all
    return all.filter(function (img) { return img.path.toLowerCase().indexOf(q) !== -1 })
  }

  // ---------- 侧栏目录树 ----------

  /** 目录在前、图片在后；all 同步按这个顺序收集，保证「翻页顺序 = 侧栏自上而下的顺序」 */
  function renderTreeNode(node, depth) {
    var dir = h('div', { class: 'dir' + (collapsed[node.path] ? ' collapsed' : '') })
    dir.dataset.path = node.path
    var caret = h('span', { class: 'caret', 'aria-hidden': 'true', text: '▾' })
    var label = h('span', { class: 'tree-label', text: node.path ? node.name : node.name + '/', title: node.path || './' })
    var row = h('div', { class: 'tree-row dir-row', role: 'button', tabindex: '0', 'aria-label': '展开/收起 ' + (node.path || './') }, [
      caret, label, h('span', { class: 'count', text: String(node.total) }),
    ])
    var firstIndex = all.length // 该目录下第一张图在 all 里的位置（子树还没收集，此刻的 length 正是它）
    var mine = function () { return all.slice(firstIndex, firstIndex + node.total) }

    /** 点目录整行 = 展开/收起。展开时若当前图不在该目录里，顺带跳到它下面第一张（过滤后可见的）图；收起不换图 */
    function toggle() {
      var nowCollapsed = !dir.classList.contains('collapsed')
      dir.classList.toggle('collapsed', nowCollapsed)
      collapsed[node.path] = nowCollapsed
      if (nowCollapsed) return
      var list = visibleList()
      var inside = mine().filter(function (img) { return list.indexOf(img) !== -1 })
      var hasCurrent = inside.some(function (img) { return img.path === currentPath })
      if (!hasCurrent && inside[0]) show(inside[0].path, { reveal: true })
    }
    row.addEventListener('click', toggle)
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        toggle()
      }
    })
    row.style.setProperty('--depth', depth)
    dir.appendChild(row)

    var children = h('div', { class: 'children' })
    node.dirs.forEach(function (child) { children.appendChild(renderTreeNode(child, depth + 1)) })
    node.images.forEach(function (img) {
      var a = h('a', { class: 'tree-label', href: '#', text: img.name, title: img.path })
      a.addEventListener('click', function (e) {
        e.preventDefault()
        show(img.path, { reveal: true })
      })
      var fileRow = h('div', { class: 'tree-row file' }, [a])
      fileRow.style.setProperty('--depth', depth + 1)
      children.appendChild(fileRow)
      all.push({ name: img.name, path: img.path, row: fileRow })
    })
    dir.appendChild(children)
    return dir
  }

  // ---------- 显示一张 ----------

  /**
   * 把图片缩放到恰好放进看图区：大图缩小、小图放大，保持宽高比。
   * 用 JS 算出像素尺寸而不是 width/height:100% + object-fit——后者会让 <img> 撑满整个区域，
   * 棋盘格底和阴影就铺满全屏了，看不出图片真实边界。
   */
  var stage = $('stage')
  function fitPhoto() {
    var nw = photo.naturalWidth
    var nh = photo.naturalHeight
    if (photo.hidden || !nw || !nh) {
      // 无固有尺寸的 SVG 等：交给 CSS 的 max-width/max-height 兜底
      photo.style.width = photo.style.height = ''
      return
    }
    var cs = getComputedStyle(stage)
    var availW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    var availH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
    var scale = Math.min(availW / nw, availH / nh)
    photo.style.width = Math.max(1, Math.floor(nw * scale)) + 'px'
    photo.style.height = Math.max(1, Math.floor(nh * scale)) + 'px'
  }
  new ResizeObserver(fitPhoto).observe(stage) // 窗口拉伸、窄屏切换布局时重算

  /**
   * 显示指定图片（path 为空则按当前列表显示空状态），并同步按钮、说明栏、侧栏高亮、地址栏。
   * opts.reveal：从侧栏主动点过来时为 true，会展开被收起的上级目录
   */
  function show(path, opts) {
    var list = visibleList()
    var index = -1
    for (var i = 0; i < list.length; i++) if (list[i].path === path) index = i
    var img = list[index]
    currentPath = img ? img.path : null

    $('prev').disabled = index <= 0
    $('next').disabled = index === -1 || index >= list.length - 1
    tree.querySelectorAll('.current').forEach(function (el) { el.classList.remove('current') })

    if (!img) {
      photo.hidden = true
      photo.removeAttribute('src')
      $('empty').hidden = false
      $('empty').textContent = all.length === 0 ? '该目录下没有图片' : '没有匹配的图片'
      $('caption-path').textContent = ''
      $('copy-path').hidden = true
      $('caption-meta').textContent = list.length ? '' : '0 / 0'
      setHash('')
      return
    }

    $('empty').hidden = true
    photo.hidden = false
    photo.alt = img.name
    photo.src = imgUrl(img.path)
    $('caption-path').textContent = img.path
    $('caption-path').title = '点击复制：' + localPath(img.path)
    $('copy-path').hidden = false
    var position = (index + 1) + ' / ' + list.length
    $('caption-meta').textContent = position
    // 新图加载完、按它的尺寸算好缩放再现身；否则会先按上一张的尺寸拉伸显示，闪一下变形
    // （已在缓存里的图 complete 立即为 true，load 事件照样会触发、照样重算尺寸，不必隐藏）
    if (!photo.complete) photo.style.visibility = 'hidden'
    photo.onload = function () {
      if (currentPath !== img.path) return
      $('caption-meta').textContent = photo.naturalWidth + ' × ' + photo.naturalHeight + '　·　' + position
      fitPhoto()
      photo.style.visibility = ''
    }
    photo.onerror = function () {
      if (currentPath !== img.path) return
      photo.style.visibility = ''
      $('caption-meta').textContent = '图片加载失败　·　' + position
    }

    // 侧栏：高亮图片行及其所有上级目录（目录被收起时，高亮的目录名就能看出当前图在哪）。
    // 只有从侧栏主动点过来（reveal）才展开被收起的上级；翻页不动用户的折叠状态
    img.row.classList.add('current')
    for (var el = img.row.parentElement; el && el !== tree; el = el.parentElement) {
      if (!el.classList.contains('dir')) continue
      el.classList.add('current')
      if (opts && opts.reveal && el.classList.contains('collapsed')) {
        el.classList.remove('collapsed')
        collapsed[el.dataset.path] = false
      }
    }
    if (img.row.offsetParent !== null) img.row.scrollIntoView({ block: 'nearest' }) // 行在收起的目录里时不可见，不滚

    // 地址栏记住当前图片，刷新页面后回到同一张
    setHash('#' + encodeURIComponent(img.path))

    // 预加载前后各一张，翻页时不闪白
    ;[list[index - 1], list[index + 1]].forEach(function (n) { if (n) new Image().src = imgUrl(n.path) })
  }

  // ---------- 复制本机路径 ----------

  /** 写剪贴板：优先 Clipboard API；不可用（非安全上下文 / 权限被拒）时回退 execCommand 选区复制 */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text) })
    }
    return legacyCopy(text)
  }
  function legacyCopy(text) {
    var ta = h('textarea', { readonly: '' })
    ta.value = text
    ta.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.appendChild(ta)
    ta.select()
    var ok = false
    try { ok = document.execCommand('copy') } catch (_e) {}
    document.body.removeChild(ta)
    return ok ? Promise.resolve() : Promise.reject(new Error('复制失败'))
  }

  var copyTimer = null
  function copyCurrentPath() {
    if (!currentPath) return
    var btn = $('copy-path')
    copyText(localPath(currentPath)).then(
      function () { flashCopy(btn, 'done', '已复制') },
      function () { flashCopy(btn, 'fail', '复制失败') },
    )
  }
  function flashCopy(btn, cls, text) {
    clearTimeout(copyTimer)
    btn.classList.remove('done', 'fail')
    btn.classList.add(cls)
    btn.textContent = text
    copyTimer = setTimeout(function () {
      btn.classList.remove(cls)
      btn.textContent = '复制路径'
    }, 1200)
  }
  $('copy-path').addEventListener('click', copyCurrentPath)
  $('caption-path').addEventListener('click', copyCurrentPath)

  function step(delta) {
    var list = visibleList()
    var index = list.findIndex(function (img) { return img.path === currentPath })
    var next = list[index + delta]
    if (next) show(next.path)
  }

  $('prev').addEventListener('click', function () { step(-1) })
  $('next').addEventListener('click', function () { step(1) })
  document.addEventListener('keydown', function (e) {
    if (e.target === filterInput) return // 在过滤框里打字时，方向键用来移动光标
    if (e.key === 'ArrowLeft') step(-1)
    else if (e.key === 'ArrowRight') step(1)
  })

  // ---------- 过滤 ----------

  function applyFilter() {
    var list = visibleList()
    var q = filterInput.value.trim()
    all.forEach(function (img) { img.row.hidden = list.indexOf(img) === -1 })
    // 自底向上：目录下没有可见文件也没有可见子目录则隐藏
    var dirs = Array.prototype.slice.call(tree.querySelectorAll('.dir')).reverse()
    dirs.forEach(function (dir) {
      dir.hidden = !dir.querySelector(':scope > .children > .file:not([hidden]), :scope > .children > .dir:not([hidden])')
    })
    $('stat').textContent = (q ? '匹配 ' + list.length + ' / ' + all.length + ' 张' : '共 ' + all.length + ' 张') +
      (truncated ? '（目录过大，只显示了一部分）' : '')
    $('stat').classList.toggle('warn', truncated)
    // 当前图仍匹配就留在原地，否则跳到第一张匹配的
    var keep = list.some(function (img) { return img.path === currentPath })
    show(keep ? currentPath : list[0] && list[0].path)
  }
  filterInput.addEventListener('input', applyFilter)

  // ---------- 收起 / 展开整个侧栏（记在 localStorage，读写失败就默认展开） ----------

  var SIDEBAR_KEY = 'showimg:sidebarHidden'
  function setSidebarHidden(hidden) {
    $('sidebar').classList.toggle('hidden', hidden)
    try { localStorage.setItem(SIDEBAR_KEY, hidden ? '1' : '') } catch (_e) {}
    // 看图区变宽后 ResizeObserver 会自动重算图片尺寸；展开时把当前图片行滚回可视区
    if (!hidden) {
      var row = tree.querySelector('.file.current')
      if (row && row.offsetParent !== null) row.scrollIntoView({ block: 'nearest' })
    }
  }
  $('sidebar-hide').addEventListener('click', function () { setSidebarHidden(true) })
  $('sidebar-open').addEventListener('click', function () { setSidebarHidden(false) })
  try { if (localStorage.getItem(SIDEBAR_KEY)) $('sidebar').classList.add('hidden') } catch (_e) {}

  // ---------- 折叠全部 / 展开全部 ----------

  $('expand-all').addEventListener('click', function () {
    collapsed = {}
    tree.querySelectorAll('.dir').forEach(function (d) { d.classList.remove('collapsed') })
  })
  $('collapse-all').addEventListener('click', function () {
    tree.querySelectorAll('.dir').forEach(function (d) {
      if (d.dataset.path === '') return // 根目录保持展开，否则侧栏只剩一行
      d.classList.add('collapsed')
      collapsed[d.dataset.path] = true
    })
  })

  // ---------- 切换目录 ----------

  var dirInput = $('dir-input')
  var dirForm = $('dir-form')
  var HISTORY_KEY = 'showimg:dirs'

  function readHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [] } catch (_e) { return [] }
  }
  function fillHistoryOptions(list) {
    $('dir-history').replaceChildren.apply($('dir-history'), list.map(function (d) { return h('option', { value: d }) }))
  }
  /** 最近打开的目录（最多 10 个）记进 localStorage，并作为输入框的下拉候选 */
  function rememberDir(dir) {
    var list = [dir].concat(readHistory().filter(function (d) { return d !== dir })).slice(0, 10)
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)) } catch (_e) {}
    fillHistoryOptions(list)
  }

  function showDirError(message) {
    $('dir-error').textContent = message
    dirForm.classList.toggle('invalid', !!message)
  }

  function fetchTree(dir) {
    return fetch('/__showimg/tree?root=' + encodeURIComponent(dir)).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status)
        return data
      })
    })
  }

  /** 先让服务端校验目录，有效才跳转；无效就在输入框下提示，留在当前页面 */
  dirForm.addEventListener('submit', function (e) {
    e.preventDefault()
    var value = dirInput.value.trim()
    if (!value) return showDirError('请输入目录路径')
    fetchTree(value)
      .then(function (data) {
        if (data.root === root) return showDirError('') // 就是当前目录，不必跳
        location.href = '/?dir=' + encodeURIComponent(data.root)
      })
      .catch(function (err) { showDirError(err.message) })
  })
  dirInput.addEventListener('input', function () { showDirError('') })
  dirInput.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      dirInput.value = root
      showDirError('')
      dirInput.blur()
    }
  })

  // ---------- 加载与自动刷新 ----------

  function render(data) {
    root = data.root
    truncated = data.truncated
    if (document.activeElement !== dirInput) dirInput.value = root // 用户正在输入时不覆盖
    rememberDir(root)
    document.title = data.tree.name + ' · showimg'
    $('title').textContent = data.tree.name
    $('title').title = root

    // 刷新前记下当前图的位置：若它被删了，停在原位置的下一张（即顶上来的那张）
    var oldIndex = all.findIndex(function (img) { return img.path === currentPath })

    all = []
    tree.replaceChildren(renderTreeNode(data.tree, 0))

    if (!all.some(function (img) { return img.path === currentPath })) {
      var fallback = all[Math.min(Math.max(oldIndex, 0), all.length - 1)]
      currentPath = fallback ? fallback.path : null
    }
    applyFilter()
  }

  function load() {
    return fetchTree(dirParam)
      .then(render)
      .catch(function (err) {
        // 典型情况：地址栏里的 ?dir= 指向的目录被删了 / 被手改错了。把它放回输入框，方便改一下再打开
        photo.hidden = true
        $('empty').hidden = false
        $('empty').textContent = '加载失败：' + err.message
        dirInput.value = dirParam
        showDirError(err.message)
      })
  }

  // 首次打开：地址栏 # 后带着路径就从那张开始（刷新页面不丢位置）
  try { currentPath = decodeURIComponent(location.hash.slice(1)) || null } catch (_e) {}
  fillHistoryOptions(readHistory()) // 加载失败时下拉里也有历史可选；加载成功后 render 会把当前目录提到最前
  load()
  // 服务端检测到该目录里文件增删改时推一条消息，这里重新拉目录树（不整页刷新，当前图与折叠状态都保留）
  var events = new EventSource('/__showimg/events?root=' + encodeURIComponent(dirParam))
  events.onmessage = load
  addEventListener('pagehide', function () { events.close() })
})()
