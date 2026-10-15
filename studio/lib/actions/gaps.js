'use strict';

// studio/lib/actions/gaps.js — 能力缺口检查 (brief §7C): what a character can and
// cannot do yet, and HOW to add what is missing.
//
// The matrix is data, not prose: every capability names the action ids that
// satisfy it, whether it is required for a complete character, and the concrete
// route to produce a missing one (the recipe to follow and the guardrails that
// apply). It reads the REAL inventory (content actions + pack animations), so the
// report reflects the assets, never a wish list.

const CAPABILITIES = [
  { id: 'idle', label: '待机', required: true, actions: ['idle'], how: '生成一张绿幕站姿（首尾帧＝标准站立），走 studio 的导入归一化 → 发布' },
  { id: 'walk-all-directions', label: '四方向行走', required: true, actions: ['walk-left', 'walk-right', 'walk-up', 'walk-down'], how: '按"按秒分节拍"配方逐向生成，首尾帧站立、双脚锁原点、绿幕；帧序进元数据，文件名不参与排序' },
  { id: 'walk-lateral', label: '左右行走（最少）', required: true, actions: ['walk-left', 'walk-right'], how: '同上；左右向允许镜像路线，但四方向仍是产品边界' },
  { id: 'working-back', label: '坐姿工作（背向）', required: true, actions: ['working-back'], how: '角色锁定生成坐姿背视多帧（工位背向＝产品默认朝向），帧高与 idle 同中位数' },
  { id: 'working-front', label: '正面工作', required: false, actions: ['working'], how: '正面可读性优先的场合使用；几何闸门（鞋线/可见高）与背视一致' },
  { id: 'rest', label: '休息/小憩', required: false, actions: ['sleeping', 'idle-lunch'], how: 'sleeping = 打盹（工位睡觉档）；idle-lunch = 摸鱼动作，二者都在工位状态机里有独立档位' },
  { id: 'outcome', label: '完成/错误', required: true, actions: ['finished', 'error'], how: '终局表现；正面可读，时长与 result 相位对齐（resultMs）' },
  { id: 'attention', label: '警告/离线', required: false, actions: ['warning', 'offline'], how: '异常档；缺省时回落到 idle 或 error' },
  { id: 'turn', label: '转向（专用动画）', required: false, actions: [], how: '尚未产出：东张西望 → 镜像定格，一段动画兼产朝向基准（省素材量的做法，见 docs/strategy 的方向基准路线）' },
  { id: 'talk', label: '说话', required: false, actions: [], how: '尚未产出帧素材：当前对话用气泡文本；口型留到字符级时间戳（Rhubarb/ElevenLabs 对齐）方案落地后' },
];

function capabilityReport({ actionIds = [], actionSummaries = [] } = {}) {
  const present = new Set(actionIds);
  const summaryById = new Map(actionSummaries.map((summary) => [summary.id, summary]));
  const rows = CAPABILITIES.map((capability) => {
    const found = capability.actions.filter((id) => present.has(id));
    const missing = capability.actions.filter((id) => !present.has(id));
    const status = capability.actions.length === 0
      ? 'not-produced'
      : (missing.length === 0 ? 'complete' : (found.length > 0 ? 'partial' : 'missing'));
    return {
      id: capability.id,
      label: capability.label,
      required: capability.required,
      status,
      present: found.map((id) => {
        const summary = summaryById.get(id);
        return summary ? { id, frames: summary.frames, totalMs: summary.totalMs, pingPong: summary.pingPong, tags: summary.tags } : { id };
      }),
      missing,
      how: (status === 'complete' ? null : capability.how),
    };
  });
  const requiredGaps = rows.filter((row) => row.required && row.status !== 'complete');
  return {
    ok: requiredGaps.length === 0,
    capabilities: rows,
    requiredGaps: requiredGaps.map((row) => row.id),
    optionalGaps: rows.filter((row) => !row.required && row.status !== 'complete').map((row) => row.id),
    inventory: { actions: [...present].sort(), count: present.size },
  };
}

module.exports = { CAPABILITIES, capabilityReport };
