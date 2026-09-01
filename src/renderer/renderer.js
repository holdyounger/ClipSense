/**
 * renderer.js - 剪贴板历史列表渲染模块（与 main.js 解耦）
 *
 * 职责：
 * - 根据条目类型（text / image / file / rich-text ...）分发渲染
 * - 处理长文本截断 / 换行 / 溢出
 * - 构建 DOM 并绑定交互（复制、删除、双击模拟输入）
 *
 * 设计目标：后续新增内容类型时，只需在 ItemBuilders 里加一个 builder，
 * 无需改 main.js。每个 builder 负责自己的预览展示与长文本/长内容处理。
 */

/**
 * 工具：把长文本按可见宽度截断（中文按 2 字符宽、英文按 1）
 * @param {string} text 原始文本
 * @param {number} maxUnits 最大显示宽度单位（≈ 单行可见字符数）
 * @param {number} maxLines 最大行数
 * @returns {string} 截断后的展示文本
 */
function formatPreview(text, maxUnits = 80, maxLines = 3) {
  if (!text) return '';
  // 统一换行符，去除首尾空行
  const normalized = String(text).replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';

  const lines = normalized.split('\n');

  // 单行 + 短文本：直接返回
  if (lines.length === 1 && displayWidth(normalized) <= maxUnits) {
    return normalized;
  }

  // 计算固定"字符宽"辅助函数
  function displayWidth(s) {
    let w = 0;
    for (const ch of s) {
      w += (ch.charCodeAt(0) > 255 ? 2 : 1); // 中文/全角算 2，半角算 1
    }
    return w;
  }

  // 截断单行到 maxUnits
  function truncateLine(line) {
    let w = 0;
    let out = '';
    for (const ch of line) {
      const cw = ch.charCodeAt(0) > 255 ? 2 : 1;
      if (w + cw > maxUnits) break;
      w += cw;
      out += ch;
    }
    return out;
  }

  // 多行：取前 maxLines 行
  const shownLines = lines.slice(0, maxLines);
  const result = shownLines.map(truncateLine).join('\n');

  // 标记是否还有更多内容
  const totalLines = lines.length;
  const hasMoreLines = totalLines > maxLines;
  const lastLineTruncated = shownLines.length > 0 &&
    displayWidth(shownLines[shownLines.length - 1]) > displayWidth(truncateLine(shownLines[shownLines.length - 1]));

  if (hasMoreLines || lastLineTruncated) {
    return result + ' …';
  }
  return result;
}

/**
 * 判断文本是否会被截断（是否需要「展开」功能）
 * @param {string} text
 * @param {number} maxUnits
 * @param {number} maxLines
 * @returns {boolean}
 */
function isTruncated(text, maxUnits = 80, maxLines = 3) {
  if (!text) return false;
  const normalized = String(text).replace(/\r\n/g, '\n').trim();
  if (!normalized) return false;
  const lines = normalized.split('\n');
  if (lines.length > maxLines) return true;
  // 单行但超宽也算截断
  for (const line of lines) {
    let w = 0;
    for (const ch of line) {
      w += (ch.charCodeAt(0) > 255 ? 2 : 1);
    }
    if (w > maxUnits) return true;
  }
  return false;
}

/**
 * 根据文件名/路径得到对应的分类图标（emoji）
 * 按扩展名映射，覆盖常见类型；未知类型回退到通用文件图标。
 */
function fileIcon(name) {
  const n = String(name || '').toLowerCase();
  // 文件夹（路径以分隔符结尾或无扩展名的目录）
  if (n.endsWith('/') || n.endsWith('\\')) return '📁';

  // 按扩展名匹配
  const ext = n.includes('.') ? n.split('.').pop() : '';

  // 图片
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'ico', 'tiff', 'psd', 'raw'].includes(ext)) return '🖼️';
  // 视频
  if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg'].includes(ext)) return '🎬';
  // 音频
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'mid', 'midi'].includes(ext)) return '🎵';
  // 压缩包
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'lzma', 'tgz'].includes(ext)) return '📦';
  // 代码
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'sh', 'bat', 'ps1', 'html', 'css', 'scss', 'less', 'json', 'xml', 'yml', 'yaml', 'sql', 'vue', 'dart', 'lua', 'r'].includes(ext)) return '💻';
  // 文档
  if (['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'odt', 'pages'].includes(ext)) return '📄';
  // 表格
  if (['xls', 'xlsx', 'csv', 'ods', 'numbers'].includes(ext)) return '📊';
  // 演示
  if (['ppt', 'pptx', 'odp', 'key'].includes(ext)) return '📽️';
  // 可执行文件
  if (['exe', 'msi', 'apk', 'app', 'dmg', 'deb', 'rpm', 'bin', 'sh', 'bat', 'cmd', 'com'].includes(ext)) return '⚙️';
  // 字体
  if (['ttf', 'otf', 'woff', 'woff2', 'eot', 'fon'].includes(ext)) return '🔤';
  // 数据库
  if (['db', 'sqlite', 'sqlite3', 'mdb', 'accdb'].includes(ext)) return '🗄️';
  // 可执行脚本已在上方，这里处理无扩展名
  if (!ext) return '📁';

  // 默认
  return '📄';
}

/**
 * 各条目类型的 DOM 构建器。
 * 每个 builder 返回 { previewEl, metaText, extraEls }。
 * 后续新增类型只需在此注册。
 */
const ItemBuilders = {
  /**
   * 文本类型
   */
  text(item, ctx) {
    const previewEl = document.createElement('pre');
    previewEl.className = 'preview preview--text';

    const needsExpand = isTruncated(item.text, 80, 3);
    let expanded = false;

    function renderText() {
      const rawText = String(item.text || '');
      const isWhitespaceOnly = rawText.length > 0 && /^\s+$/.test(rawText);
      if (isWhitespaceOnly) {
        // 用可见转义符展示，避免连续空格/换行在界面上“消失”。
        // 使用编辑器常见的“显示空白”符号：空格␠、Tab⇥、换行↵。
        // CRLF 作为一个换行标记展示，避免出现“␍↵”两个符号。
        const visible = rawText.replace(/\r\n|\n|\r|\t| /g, (token) => {
          if (token === ' ') return '␠';
          if (token === '\t') return '⇥';
          return '↵\n';
        });
        previewEl.textContent = `[空白字符 × ${rawText.length}]\n${visible}`;
        previewEl.classList.add('preview--whitespace');
        previewEl.title = '这是有效的空白字符内容，双击仍会粘贴原始空白字符';
        return;
      }
      previewEl.classList.remove('preview--whitespace');
      previewEl.title = '';
      previewEl.textContent = expanded ? rawText : formatPreview(rawText, 80, 3);
      // 链接条目：预览区 hover 显示完整 URL（截断显示时）
      if (item.links && item.links.length === 1 && !isWhitespaceOnly) {
        previewEl.title = item.links[0];
      }
    }
    renderText();

    // Ctrl+单击 / 🌐 按钮：在默认浏览器打开链接（A+B 方案）
    // 仅对链接条目生效；多 URL 条目按钮变为「提取链接」弹清单。
    if (item.links && item.links.length > 0 && window.clipboardAPI && window.clipboardAPI.openExternal) {
      const openLink = async (e) => {
        e.stopPropagation();
        if (item.links.length === 1) {
          await window.clipboardAPI.openExternal(item.links[0]);
        } else {
          showLinkPicker(item.links);
        }
      };
      previewEl.addEventListener('click', (e) => {
        if (e.ctrlKey) openLink(e);
      });
      previewEl.classList.add('text-link');
      previewEl.title = item.links.length === 1
        ? `Ctrl+单击 或点 🌐 在浏览器打开\n${item.links[0]}`
        : 'Ctrl+单击 提取链接（含多个 URL）';
    }

    // 超长文本：加「展开/收起」切换按钮（作为 preview 的兄弟节点）
    let toggleBtn = null;
    if (needsExpand) {
      toggleBtn = document.createElement('button');
      toggleBtn.className = 'expand-btn';
      toggleBtn.innerHTML = `<span class="expand-icon">▼</span><span>${ctx.t('expand')}</span>`;
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        expanded = !expanded;
        toggleBtn.innerHTML = expanded
          ? `<span class="expand-icon">▲</span><span>${ctx.t('collapse')}</span>`
          : `<span class="expand-icon">▼</span><span>${ctx.t('expand')}</span>`;
        renderText();
      });
    }

    return {
      previewEl,
      extraEls: toggleBtn ? [toggleBtn] : [],
      metaText: `${ctx.timeStr(item.timestamp)} · ${ctx.t('chars', item.length)}`,
    };
  },

  /**
   * 图片类型（预留，暂未实现数据链路）
   */
  image(item, ctx) {
    const previewEl = document.createElement('div');
    previewEl.className = 'preview preview--image';
    const img = document.createElement('img');
    img.src = item.dataUrl || item.path || '';
    img.alt = item.name || 'image';
    img.loading = 'lazy';
    previewEl.appendChild(img);
    return {
      previewEl,
      metaText: `${ctx.timeStr(item.timestamp)} · ${ctx.t('image')} ${item.width ? item.width + '×' + item.height : ''}`,
    };
  },

  /**
   * 文件类型
   */
  file(item, ctx) {
    const previewEl = document.createElement('div');
    previewEl.className = 'preview preview--file';

    const files = item.files || [];
    if (files.length > 1) {
      // 多文件：显示文件夹图标 + 数量
      const icon = document.createElement('span');
      icon.className = 'file-icon';
      icon.textContent = '📁';
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = `${files.length} 个文件`;
      previewEl.appendChild(icon);
      previewEl.appendChild(name);

      // 多文件条目点击时定位到第一个文件。
      const firstFilePath = files[0] && files[0].path;
      if (firstFilePath) {
        previewEl.classList.add('file-link');
        previewEl.title = '在 Explorer 中打开文件位置（第一个文件）';
        previewEl.addEventListener('click', (e) => {
          e.stopPropagation();
          previewEl._openFileTimer = setTimeout(() => {
            window.clipboardAPI.openFileLocation(firstFilePath).catch(() => {});
          }, 250);
        });
      }
    } else {
      // 单文件：先显示扩展名分类 emoji，再异步加载真实系统图标替换
      const filePath = item.path || (item.files && item.files[0] ? item.files[0].path : '') || '';
      const icon = document.createElement('span');
      icon.className = 'file-icon';
      icon.textContent = fileIcon(item.name || filePath);

      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = item.name || filePath || 'file';

      previewEl.appendChild(icon);
      previewEl.appendChild(name);

      // 单击文件预览：在 Explorer 中打开并定位到对应文件。
      if (filePath) {
        previewEl.classList.add('file-link');
        previewEl.title = '在 Explorer 中打开文件位置';
        previewEl.addEventListener('click', (e) => {
          e.stopPropagation();
          // 延迟单击动作，给条目的双击粘贴留出识别时间。
          previewEl._openFileTimer = setTimeout(async () => {
            const result = await window.clipboardAPI.openFileLocation(filePath);
            if (!result || !result.ok) console.warn(result && result.error ? result.error : '打开文件失败');
          }, 250);
        });
      }

      // 异步加载真实系统图标（Windows 上能拿到 .exe 等文件的内置图标）
      if (filePath && window.clipboardAPI && window.clipboardAPI.getFileIcon) {
        window.clipboardAPI.getFileIcon(filePath).then((dataUrl) => {
          // 竞态保护：列表可能已被重新渲染，icon 已脱离 DOM，此时放弃（新一轮会重新请求）
          if (!dataUrl || !icon.isConnected) return;
          const img = document.createElement('img');
          img.className = 'file-icon-img';
          img.src = dataUrl;
          img.alt = item.name || 'file';
          icon.replaceWith(img);
        }).catch(() => { /* 加载失败保留 emoji */ });
      }
    }

    return {
      previewEl,
      metaText: `${ctx.timeStr(item.timestamp)} · ${ctx.t('file')}`,
    };
  },

  /**
   * 富文本类型（预留）
   */
  'rich-text'(item, ctx) {
    const previewEl = document.createElement('div');
    previewEl.className = 'preview preview--rich';
    previewEl.textContent = formatPreview(item.plainText || item.text, 80, 3);
    return {
      previewEl,
      metaText: `${ctx.timeStr(item.timestamp)} · ${ctx.t('richText')}`,
    };
  },
};

/**
 * 渲染历史列表
 * @param {HTMLElement} container 列表容器
 * @param {Array} history 历史条目数组
 * @param {Object} handlers 交互回调 { onCopy, onSimulateInput, onRemove }
 * @param {Object} ctx 上下文 { t, timeStr, flashItem }
 */
function renderHistory(container, history, handlers, ctx) {
  if (!history || history.length === 0) {
    container.innerHTML = `<div class="empty">${ctx.t('empty')}</div>`;
    return;
  }

  container.innerHTML = '';

  for (const item of history) {
    const type = item.type || 'text';
    const builder = ItemBuilders[type] || ItemBuilders.text;

    // 构建条目
    const { previewEl, metaText, extraEls } = builder(item, ctx);

    const div = document.createElement('div');
    div.className = 'item';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = metaText || '';

    // 操作按钮
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = ctx.t('copy');
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (handlers.onCopy) await handlers.onCopy(item, div);
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'del-btn';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (handlers.onRemove) await handlers.onRemove(item);
    });

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.appendChild(copyBtn);

    // 链接条目：操作区增加「🌐 打开」/「提取链接」按钮（方案 A）
    if (item.links && item.links.length > 0 && window.clipboardAPI && window.clipboardAPI.openExternal) {
      const openBtn = document.createElement('button');
      openBtn.className = 'open-btn';
      openBtn.textContent = '🌐';
      openBtn.title = item.links.length === 1
        ? `在默认浏览器打开\n${item.links[0]}`
        : `提取链接（${item.links.length} 个 URL）`;
      openBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (item.links.length === 1) {
          const r = await window.clipboardAPI.openExternal(item.links[0]);
          if (!r || !r.ok) console.warn(r && r.error ? r.error : '打开链接失败');
        } else {
          showLinkPicker(item.links);
        }
      });
      actions.appendChild(openBtn);
    }

    actions.appendChild(delBtn);

    div.appendChild(previewEl);
    // 额外元素（如展开按钮）插在预览和 meta 之间
    if (extraEls && extraEls.length > 0) {
      for (const el of extraEls) {
        div.appendChild(el);
      }
    }
    div.appendChild(meta);
    div.appendChild(actions);

    // 双击条目：回写原始类型后，粘贴到双击前的目标窗口
    div.addEventListener('dblclick', (e) => {
      if (e.target.closest('.file-link') && e.target.closest('.file-link')._openFileTimer) {
        clearTimeout(e.target.closest('.file-link')._openFileTimer);
        e.target.closest('.file-link')._openFileTimer = null;
      }
      if (e.target.closest('.actions')) return;
      if (e.target.closest('.expand-btn')) return;
      if (handlers.onSimulateInput) {
        // 搜索结果也是原始历史 item，始终使用其真实 id 执行写入/粘贴。
        handlers.onSimulateInput(item, div);
      }
    });

    container.appendChild(div);
  }
}

/**
 * 链接条目说明：识别逻辑在主进程（src/common/link-utils.js，入库时算 item.links），
 * 渲染层只消费 item.links 字段做 🌐 按钮 / Ctrl+单击交互。
 */

/**
 * 多 URL 清单：点选打开某一个，不静默全开
 * 简单实现：动态创建浮层，点击遮罩关闭。
 */
function showLinkPicker(links) {
  // 幂等：已存在则先移除
  let picker = document.getElementById('link-picker');
  if (picker) picker.remove();

  picker = document.createElement('div');
  picker.id = 'link-picker';
  picker.innerHTML = '<div class="link-picker-mask"></div>' +
    '<div class="link-picker-panel"><div class="link-picker-title">提取到 ' +
    links.length + ' 个链接，点击打开：</div><ul class="link-picker-list">' +
    links.map(u => `<li class="link-picker-item" title="${u.replace(/"/g, '&quot;')}">${u}</li>`).join('') +
    '</ul></div>';

  picker.querySelector('.link-picker-mask').addEventListener('click', () => picker.remove());
  picker.querySelectorAll('.link-picker-item').forEach((el, i) => {
    el.addEventListener('click', async () => {
      const r = await window.clipboardAPI.openExternal(links[i]);
      if (!r || !r.ok) console.warn(r && r.error ? r.error : '打开链接失败');
      picker.remove();
    });
  });
  document.body.appendChild(picker);
}

if (typeof module !== 'undefined') {
  module.exports = { renderHistory, formatPreview, ItemBuilders };
}
