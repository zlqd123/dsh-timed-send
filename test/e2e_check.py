"""
在临时 28099 实例上做端到端验证：
1. 页面能正常加载（插件不炸 UI），控制台无 error。
2. 输入框上方、框外出现「定时发送」按钮。
3. 输入草稿 → 点按钮 → 选 5 分钟后 → 确认。
4. 立即：会话列表多一个、当前会话切换、**没有**任何消息被发出。
5. 输入框下方（dock）出现待发定时条目。
"""

import json
import re
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:28099"
TOKEN = sys.argv[1]
OUT = "D:/tool/deepseek/3/dsh-scheduled-send"


def api(action, payload=None):
    body = json.dumps({"action": action, **(payload or {})}).encode()
    req = urllib.request.Request(
        BASE + "/dsh-scheduled-send/api",
        data=body,
        headers={"content-type": "application/json", "origin": BASE},
    )
    with urllib.request.urlopen(req) as response:
        return json.loads(response.read().decode())


def main():
    problems = []
    errors = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        failed_urls = []
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda exc: errors.append(f"pageerror: {exc}"))
        page.on("response", lambda r: failed_urls.append(f"{r.status} {r.url}") if r.status >= 400 else None)

        page.goto(f"{BASE}/?token={TOKEN}", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)

        # 关掉可能挡住输入的引导弹窗（cost-meter 的「高峰时段」介绍等）
        for _ in range(4):
            dialog = page.locator("dialog[open]")
            if dialog.count() == 0:
                break
            try:
                page.keyboard.press("Escape")
                page.wait_for_timeout(400)
            except Exception:
                pass
            if page.locator("dialog[open]").count() > 0:
                for label in ("知道了", "知道了 ", "关闭", "确定", "知道了，开始使用"):
                    btn = page.get_by_role("button", name=label)
                    if btn.count() > 0:
                        btn.first.click()
                        page.wait_for_timeout(400)
                        break
            else:
                break

        # 1. 页面正常
        if page.locator("[data-scheduled-send]").count() == 0:
            problems.append("定时发送按钮未渲染")

        # 记录基线：会话数量 & 当前任务数
        before_tasks = api("list", {"includeFinished": True})["value"]["tasks"]
        before_count = len(before_tasks)

        # 2. 截图（按钮位置）
        page.screenshot(path=f"{OUT}/shot-1-button.png")

        # 3. 写草稿
        editor = page.locator("[data-input-scroll] [contenteditable='true']").first
        editor.click()
        page.keyboard.type("定时发送 E2E 测试消息")
        page.wait_for_timeout(500)

        # 4. 点按钮开面板
        page.locator("[data-scheduled-send] button").first.click()
        page.wait_for_timeout(600)
        if page.locator("[data-scheduled-send-panel]").count() == 0:
            problems.append("时间面板未打开")
            page.screenshot(path=f"{OUT}/shot-fail.png")
            browser.close()
            print(json.dumps({"problems": problems, "errors": errors}, ensure_ascii=False))
            return

        page.screenshot(path=f"{OUT}/shot-2-panel.png")

        # 面板里的正文应带出草稿
        panel_text = page.locator("[data-scheduled-send-panel] textarea").input_value()
        if "E2E" not in panel_text:
            problems.append(f"面板未带出草稿，实际={panel_text!r}")

        # 5. 选 5 分钟后并确认
        page.get_by_role("button", name="5 分钟后", exact=True).click()
        page.wait_for_timeout(300)
        page.get_by_role("button", name="创建定时会话").click()
        page.wait_for_timeout(4000)

        page.screenshot(path=f"{OUT}/shot-3-after.png")

        # 6. Host 侧应多出一条 active 任务
        after_tasks = api("list", {"includeFinished": True})["value"]["tasks"]
        active = [t for t in after_tasks if t["status"] in ("active", "sending")]
        if len(after_tasks) != before_count + 1:
            problems.append(f"任务数量未增加：{before_count} → {len(after_tasks)}")
        if not active:
            problems.append("没有 active 任务")
        else:
            created = active[-1]
            if "E2E" not in created["text"]:
                problems.append(f"任务正文不对：{created['text']!r}")
            print("created task:", json.dumps(created, ensure_ascii=False))

        # 7. 关键：新会话此刻必须是「空」的 —— 没有任何 user/message
        page.wait_for_timeout(1500)

        # 只看「会话记录区」，排除仍在输入框里的草稿（composer 也在 content 里）。
        transcript = page.evaluate("""() => {
          const root = document.querySelector('[data-conversation-content]')
          if (!root) return ''
          const clone = root.cloneNode(true)
          clone.querySelectorAll('[data-composer-seat], [data-scheduled-send]').forEach(n => n.remove())
          return clone.innerText
        }""")
        if "E2E" in transcript:
            problems.append("定时消息被立刻发出去了（违反「只建会话、不发送」）")

        # 草稿应已被搬进定时任务并从输入框清空。
        draft_left = page.evaluate("""() => {
          const n = document.querySelector('[data-input-scroll] [contenteditable="true"]')
          return n ? n.innerText : ''
        }""")
        if "E2E" in draft_left:
            problems.append("草稿未清空，用户可能误发第二遍")

        # 8. dock 里应出现待发条目
        if page.locator("[data-scheduled-send-list]").count() == 0:
            problems.append("待发列表未渲染")

        real_errors = [e for e in errors if "favicon" not in e.lower()]
        browser.close()

    print(json.dumps({"problems": problems, "errors": real_errors, "failed_urls": sorted(set(failed_urls))}, ensure_ascii=False, indent=2))


main()
