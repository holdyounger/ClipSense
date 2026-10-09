/**
 * window-dims.js - 主窗口尺寸常量（单一来源，2026-09-30）
 *
 * 黄金比例构图：height / width ≈ φ (1.618)——面板高宽比落在黄金点上，
 * 视觉构图更稳定（此前 360×560 比例 1.556，偏高胖）。
 *
 * ⚠️ 消费点耦合（改尺寸必须同步核对的清单）：
 *   - index.js createWindow（BrowserWindow 初始尺寸）
 *   - edge-detector.js _showWindow（弹出定位）与 _getNearestEdgeForPoint
 *     （半宽 170 参与左右贴边判定，改宽必须联动）
 *   - 贴边触发条高度 = HEADER_REST_HEIGHT（header-hover.js），与窗口宽无关
 */

const WINDOW_WIDTH = 340;
const WINDOW_HEIGHT = 550; // 550/340 ≈ 1.6176 ≈ φ(1.618)
const WINDOW_HALF_WIDTH = WINDOW_WIDTH / 2; // 170：贴边左右判定用（联动点）

module.exports = { WINDOW_WIDTH, WINDOW_HEIGHT, WINDOW_HALF_WIDTH };
