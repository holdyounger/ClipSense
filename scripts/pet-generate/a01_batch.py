# -*- coding: utf-8 -*-
"""A-01 绿幕/透明视频批量生成（aiclipmaxx 片刻网，Python 直连 CDP，跨平台）

替代旧 a01-batch.ps1：不再依赖仓库内不存在的 scripts/cdp/eval.js，也不再硬编码
D:\\Downloads 下载目录。CDP 下载行为直接把文件落到本仓库 out/aiclipmaxx/batch。

前置条件：
  1. Chrome/Edge 以 --remote-debugging-port=9222 启动，并已登录 aiclipmaxx.com
  2. 参考图存在（由 a01-actions.json 的 reference 字段指定）

用法（仓库根目录执行）：
  python scripts/pet-generate/a01_batch.py --phase submit [--settle-sec 45] [--limit1]
  python scripts/pet-generate/a01_batch.py --phase download [--poll-sec 90]
  python scripts/pet-generate/a01_batch.py --phase status
  # 自定义 CDP 端口：--cdp-port 9222；自定义下载目录：--downloads-dir <dir>

依赖：websocket-client、requests（Python 标准库之外）；这两个库是本仓库 pipeline 既有依赖。
安全：不写入任何服务凭证/登录态；只用 CDP 通用命令（Runtime.evaluate / DOM.setFileInputFiles /
Browser.setDownloadBehavior）。
"""
import argparse
import datetime
import json
import os
import shutil
import sys
import time

try:
    import requests
    import websocket
except ImportError:
    raise SystemExit('缺少依赖：请安装 websocket-client 与 requests '
                     '（pip install websocket-client requests）')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
ACTIONS = os.path.join(HERE, 'a01-actions.json')
OUT_DIR = os.path.join(ROOT, 'out', 'aiclipmaxx', 'batch')
PROG_FILE = os.path.join(OUT_DIR, 'progress.json')


# ---------------- CDP 轻量客户端 ----------------
class CDP:
    def __init__(self, port):
        self.port = port
        self.ws = None
        self.msg_id = 0

    def page_id(self):
        try:
            data = requests.get('http://127.0.0.1:%d/json/list' % self.port, timeout=5).json()
        except Exception as e:
            raise SystemExit('CDP %d 不可用：%s（确认浏览器带 --remote-debugging-port=%d 启动）'
                             % (self.port, e, self.port))
        for t in data:
            url = t.get('url', '')
            if 'aiclipmaxx.com' in url:
                return t.get('id'), url
        raise SystemExit('未找到 aiclipmaxx 页面：请在浏览器打开并登录 aiclipmaxx.com')

    def connect(self, page_id):
        url = 'ws://127.0.0.1:%d/devtools/page/%s' % (self.port, page_id)
        try:
            self.ws = websocket.create_connection(url, timeout=12)
        except Exception as e:
            raise SystemExit('连接 CDP websocket 失败: %s' % e)

    def send(self, method, params=None):
        self.msg_id += 1
        mid = self.msg_id
        self.ws.send(json.dumps({'id': mid, 'method': method, 'params': params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get('id') == mid:
                if 'error' in msg:
                    raise RuntimeError('%s: %s' % (method, msg['error']))
                return msg.get('result', {})

    def evaluate(self, expr):
        r = self.send('Runtime.evaluate', {
            'expression': expr, 'returnByValue': True, 'awaitPromise': True})
        return r.get('result', {}).get('value')

    def upload(self, selector, file_path):
        doc = self.send('DOM.getDocument')
        node = self.send('DOM.querySelector', {'nodeId': doc['root']['nodeId'], 'selector': selector})
        if not node.get('nodeId'):
            raise RuntimeError('未找到文件输入框: ' + selector)
        self.send('DOM.setFileInputFiles', {'files': [file_path], 'nodeId': node['nodeId']})

    def set_download_dir(self, path):
        # 让产物直接落到仓库 out 目录（跨平台，不依赖固定下载目录）。
        # Browser 域是浏览器级命令，经页面 websocket 发送在部分 Chrome 版本不生效；
        # 失败时回退到页面级的 Page.setDownloadBehavior（旧命令但兼容性更广）。
        params = {'behavior': 'allow', 'downloadPath': os.path.abspath(path)}
        try:
            self.send('Browser.setDownloadBehavior', dict(params, eventsEnabled=True))
        except Exception:
            self.send('Page.setDownloadBehavior', params)

    def close(self):
        if self.ws:
            try:
                self.ws.close()
            except Exception:
                pass


# ---------------- 页面 JS 片段（DOM 依赖，服务改版时优先改这里） ----------------
JS_CLICK = ("(function(){var els=document.querySelectorAll('button,div,span');"
            "for(var i=0;i<els.length;i++){var t=(els[i].innerText||'').trim();"
            "if(t==='%s'&&els[i].offsetWidth>0){els[i].click();return 'ok'}}return 'nf'})()")
JS_HAS_FILE_INPUT = "(function(){return document.querySelector('input[type=file]')?'1':'0'})()"
JS_FILE_COUNT = ("(function(){var el=document.querySelector('input[type=file]');"
                 "return el&&el.files?el.files.length:0})()")
JS_FILL_PROMPT_HEAD = ("(function(){var ta=document.querySelector('textarea');if(!ta)return 'no-ta';"
                       "var proto=Object.getPrototypeOf(ta);"
                       "var setter=Object.getOwnPropertyDescriptor(proto,'value').set;"
                       "setter.call(ta,")
JS_FILL_PROMPT_TAIL = (");ta.dispatchEvent(new Event('input',{bubbles:true}));"
                       "ta.dispatchEvent(new Event('change',{bubbles:true}));return 'ok'})()")
JS_SCAN_JOBS = r"""(function(){var cards=[];var els=document.querySelectorAll('*');
for(var i=0;i<els.length;i++){var e=els[i];if(e.children.length>25)continue;var t=(e.innerText||'');
if(t.indexOf('图生视频')>=0&&t.indexOf('秒')>=0&&t.length<900&&t.length>25){
var dl=e.querySelector('a[download]');
cards.push({dl:dl?(dl.href.split('/').slice(-2).join('/')):null,txt:t.replace(/\s+/g,' ').slice(0,120)});
}}
return JSON.stringify(cards)})()"""


def js_click(text):
    return JS_CLICK % text.replace('\\', '\\\\').replace("'", "\\'")


def js_fill(prompt):
    # JSON 字符串字面量保证提示词里的引号/换行安全嵌入 JS
    return JS_FILL_PROMPT_HEAD + json.dumps(prompt, ensure_ascii=False) + JS_FILL_PROMPT_TAIL


def is_done(txt):
    return '用时' in txt and '预计' not in txt and '取消' not in txt


def scan_jobs(cdp):
    raw = cdp.evaluate(JS_SCAN_JOBS)
    if not raw or '[' not in str(raw):
        return []
    try:
        return json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return []


def progress_load():
    if os.path.exists(PROG_FILE):
        with open(PROG_FILE, encoding='utf-8') as f:
            return json.load(f)
    return {'submitted': {}}


def progress_save(prog):
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(PROG_FILE, 'w', encoding='utf-8') as f:
        json.dump(prog, f, ensure_ascii=False, indent=2)


def load_actions():
    with open(ACTIONS, encoding='utf-8') as f:
        return json.load(f)


def resolve_ref(data, cli_ref):
    ref = cli_ref or data.get('reference', '')
    path = ref if os.path.isabs(ref) else os.path.join(ROOT, *ref.split('/'))
    if not os.path.exists(path):
        raise SystemExit('参考图不存在: ' + path)
    return path


def fingerprint(prompt):
    parts = prompt.split('做', 1)
    body = parts[1] if len(parts) > 1 else prompt
    return body[:14]


def cmd_status(cdp):
    jobs = scan_jobs(cdp)
    done = [j for j in jobs if is_done(j.get('txt', ''))]
    print('最近作品卡片: %d  已完成(可下载): %d' % (len(jobs), len(done)))
    for j in jobs:
        tag = 'DONE ' if is_done(j.get('txt', '')) else 'queue'
        print('  [%s] %s %s' % (tag, j.get('dl') or '-', j.get('txt', '')[:70]))


def cmd_submit(cdp, data, ref, settle, limit1):
    prog = progress_load()
    if cdp.evaluate(js_click('图生视频')) != 'ok':
        print('[warn] 未点中「图生视频」，若页面已在该模式可忽略')
    time.sleep(2)
    actions = data['actions'][:1] if limit1 else data['actions']
    for a in actions:
        aid = a['id']
        if aid in prog['submitted']:
            print('[skip] %s 已提交 (%s)' % (aid, prog['submitted'][aid].get('submittedAt')))
            continue
        print('\n==== %s %s ====' % (aid, a.get('label', '')))
        if cdp.evaluate(JS_FILE_COUNT):
            cdp.evaluate(js_click('移除'))
            time.sleep(1.5)
        cdp.upload('input[type=file]', ref)
        ok = False
        for _ in range(20):
            time.sleep(2)
            if cdp.evaluate(js_click('移除')) == 'ok':
                ok = True
                break
        if not ok:
            print('[fail] %s 上传未确认，重跑本阶段可续传' % aid)
            continue
        time.sleep(1)
        if cdp.evaluate(js_fill(a['prompt'])) != 'ok':
            print('[fail] %s 填提示词失败' % aid)
            continue
        time.sleep(1)
        cdp.evaluate(js_click('480p'))
        time.sleep(0.5)
        cdp.evaluate(js_click('5 秒'))
        time.sleep(1)
        if cdp.evaluate(js_click('生成视频')) != 'ok':
            print('[fail] %s 未点中「生成视频」，请人工检查页面' % aid)
            continue
        fp = fingerprint(a['prompt'])
        prog['submitted'][aid] = {
            'label': a.get('label', ''), 'fp': fp,
            'submittedAt': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'status': 'submitted',
        }
        progress_save(prog)
        print('[ok] %s 已提交 (fp=%s)' % (aid, fp))
        print('[settle] 等 %ds 让页面/队列稳定…' % settle)
        time.sleep(settle)
    done = sum(1 for a in data['actions'] if a['id'] in prog['submitted'])
    print('\n==== 提交阶段结束：%d/%d 已提交。出片后运行 --phase download ===='
          % (done, len(data['actions'])))


def cmd_download(cdp, data, poll):
    os.makedirs(OUT_DIR, exist_ok=True)
    cdp.set_download_dir(OUT_DIR)
    prog = progress_load()
    while True:
        jobs = scan_jobs(cdp)
        missing = []
        for a in data['actions']:
            aid = a['id']
            info = prog['submitted'].get(aid)
            if not info:
                missing.append(aid)
                continue
            if info.get('status') in ('downloaded', 'missing'):
                continue
            fp = info.get('fp', '')
            card = next((j for j in jobs
                         if fp and fp in j.get('txt', '') and is_done(j.get('txt', '')) and j.get('dl')), None)
            if not card:
                missing.append(aid)
                continue
            dl = card['dl']
            job_id = dl.split('/')[0]
            dest = os.path.join(OUT_DIR, 'aiclipmaxx-%s.%s.mp4' % (job_id, aid))
            print('\n[dl] %s %s <- %s' % (aid, a.get('label', ''), dl))
            if not os.path.exists(dest):
                js = ("(function(){var a=document.querySelector('a[download*=\"%s\"]');"
                      "if(a){a.click();return 'ok'}return 'nf'})()") % job_id
                if cdp.evaluate(js) != 'ok':
                    print('[warn] 未找到 %s 下载链接' % job_id)
                    missing.append(aid)
                    continue
                got = False
                for _ in range(30):
                    time.sleep(2)
                    # 下载落到 OUT_DIR：找含 jobId 且已写完（>100KB）的文件
                    cands = [os.path.join(OUT_DIR, f) for f in os.listdir(OUT_DIR)
                             if job_id in f and os.path.isfile(os.path.join(OUT_DIR, f))]
                    if cands:
                        newest = max(cands, key=os.path.getmtime)
                        if os.path.getsize(newest) > 100000:
                            shutil.move(newest, dest)
                            got = True
                            break
                if not got:
                    print('[warn] 下载未在 60s 内落盘，下轮重试')
                    missing.append(aid)
                    continue
            info.update(status='downloaded', file=dest, jobId=job_id)
            progress_save(prog)
            print('[ok] saved: %s (%d bytes)' % (dest, os.path.getsize(dest)))
            time.sleep(3)
        done = sum(1 for a in data['actions']
                   if prog['submitted'].get(a['id'], {}).get('status') == 'downloaded')
        if done >= len(data['actions']):
            print('\n==== 全部 %d/%d 下载完成 -> %s ====' % (done, len(data['actions']), OUT_DIR))
            return
        print('[poll] 已完成 %d/%d，等待中: %s （%ds 后重试，Ctrl+C 退出可重跑续传）'
              % (done, len(data['actions']), ', '.join(missing), poll))
        time.sleep(poll)


def main():
    p = argparse.ArgumentParser(description='aiclipmaxx 批量生成（Python 直连 CDP，跨平台）')
    p.add_argument('--phase', choices=['submit', 'download', 'status'], default='status')
    p.add_argument('--cdp-port', type=int, default=9222)
    p.add_argument('--settle-sec', type=int, default=45)
    p.add_argument('--poll-sec', type=int, default=90)
    p.add_argument('--limit1', action='store_true', help='只处理第一个动作（调试用）')
    p.add_argument('--ref', default='', help='参考图路径；默认取 a01-actions.json 的 reference')
    a = p.parse_args()

    data = load_actions()
    ref = resolve_ref(data, a.ref)
    cdp = CDP(a.cdp_port)
    page_id, url = cdp.page_id()
    print('[cdp] aiclipmaxx page: %s' % url)
    cdp.connect(page_id)
    try:
        if a.phase == 'status':
            cmd_status(cdp)
        elif a.phase == 'submit':
            cmd_submit(cdp, data, ref, a.settle_sec, a.limit1)
        else:
            cmd_download(cdp, data, a.poll_sec)
    finally:
        cdp.close()


if __name__ == '__main__':
    main()
