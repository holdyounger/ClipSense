/**
 * modifier-passthrough.ts - 修饰键按住穿透状态机（2026-10-13，原 ctrl-passthrough 中性化）
 *
 * 需求：按住指定修饰键（当前 = Alt，由 index.ts 探针决定）时鼠标进入窗口 →
 * 窗口对鼠标透传（点击/滚轮落到下层应用），用于不收起面板的前提下与面板
 * 下方的窗口交互。
 *
 * 职责拆分（与 header-hover 同构）：
 * - 本模块：纯逻辑状态机（防抖 + 边沿生成），零 electron/koffi 依赖，
 *   可被 node --test 直测；键位无关——探针注入，换键只改探针与文案
 * - EdgeDetector：100ms 轮询 tick 里推进状态机，确认边沿时执行
 *   setIgnoreMouseEvents（不带 forward：透传期渲染层完全惰性，见 edge-detector 内注释）
 * - index.ts：键态探针注入（koffi GetAsyncKeyState 惰性绑定；非 win32 恒 false）
 *
 * 键态必须 GetAsyncKeyState（物理键全局态）：面板 WS_EX_NOACTIVATE 不夺焦，
 * 用户按住修饰键时系统焦点在目标应用，渲染层 keydown/keyup 不可达；
 * GetKeyState 只反映本线程消息队列，同样恒 0（paste-bridge.ts 已踩坑实证）。
 *
 * 防抖设计（与 header-hover 离开防抖同模型）：探针 100ms 一拍，快速点按
 * 修饰键会产生 true/false 抖动，而透传切换是重操作（OS 输入路由变更），要求
 * 连续 2 拍同向才确认翻转；边沿只报告「确认后」的翻转。
 */

/** 防抖拍数：连续 2 拍同向才翻转（快速点按 <200ms 不触发透传切换） */
const MODIFIER_DEBOUNCE_TICKS = 2;

/** 键态探针（纯函数，注入以便测试/跨平台替换） */
interface HoldProbe {
  /** 当前修饰键是否按住（异常返回值按 false 处理） */
  isDown: () => boolean;
}

/** 单拍推进结果 */
interface HoldPassResult {
  /** 防抖确认后的生效状态 */
  active: boolean;
  /** 本拍是否发生确认翻转（true → 调用方执行 setIgnoreMouseEvents） */
  changed: boolean;
}

/**
 * 创建修饰键穿透状态机（纯逻辑，无 IO）。
 * tick(probe) 每拍推进一次；isActive() 查询生效态；reset() 供窗口
 * 隐藏/模块停用时清空残留确认态（下次显示按当前键态重新确认）。
 */
function createModifierPassthrough() {
  let confirmed = false; // 已确认生效的透传状态
  let pending = false;   // 待确认的目标态
  let pendingCount = 0;  // 已连续多少拍与 pending 一致

  return {
    isActive(): boolean {
      return confirmed;
    },
    tick(probe: HoldProbe): HoldPassResult {
      // 非布尔/异常返回值归一为 false：探针绑定失败时功能自动禁用
      const down = probe.isDown() === true;
      if (down === confirmed) {
        // 与生效态一致：清空待确认计数，防历史残留拍数跨越翻转
        pending = down;
        pendingCount = 0;
        return { active: confirmed, changed: false };
      }
      if (down === pending) {
        pendingCount += 1;
      } else {
        pending = down;
        pendingCount = 1;
      }
      if (pendingCount >= MODIFIER_DEBOUNCE_TICKS) {
        confirmed = pending;
        pendingCount = 0;
        return { active: confirmed, changed: true };
      }
      return { active: confirmed, changed: false };
    },
    reset(): void {
      confirmed = false;
      pending = false;
      pendingCount = 0;
    },
  };
}

// export = 单导出（与 paste-bridge/edge-detector 同构；export = 模块内
// 不得混用具名 export——接口仅模块内类型面，经 ReturnType 对外推导）
export = { createModifierPassthrough, MODIFIER_DEBOUNCE_TICKS };
