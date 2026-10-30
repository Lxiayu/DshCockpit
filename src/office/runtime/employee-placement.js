'use strict';

// src/office/runtime/employee-placement.js — pure placement helper.
//
// 2026-10-30（用户："拖拽后鲸鱼娘会弹回原位，我想拖到哪就停到哪"）：
// 把拖拽落点写回**模拟位置**的能力。原先渲染层是 "presentation only"
//（beginDrag 的注释写着 on release eases back），松手后角色缓动回快照位置，
// 用户的拖拽等于白做。
//
// 这里只做纯计算（算落点该吸附到哪个节点、返回要重置哪些字段），
// 不依赖 PIXI、不持有状态、不读时钟 —— 真正的写入由 office-module 的
// placeEmployeeAt() 完成。这样 root 模块不必为它继续膨胀
//（boundary 测试要求 office-module.js ≤ 4800 行，超限就该拆）。

/**
 * 找一个归一化坐标最近的图节点。
 * @param {Array<{id:string, position:{x:number,y:number}}>} nodes
 * @param {{x:number,y:number}} position
 * @returns {{id:string, position:{x:number,y:number}, distance:number}|null}
 */
function nearestNode(nodes, position) {
  if (!Array.isArray(nodes) || !position) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const node of nodes) {
    if (!node || !node.position) continue;
    if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) continue;
    const distance = Math.hypot(node.position.x - position.x, node.position.y - position.y);
    if (distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  }
  return best ? { id: best.id, position: { x: best.position.x, y: best.position.y }, distance: bestDistance } : null;
}

/**
 * 把一次"放置请求"解析成可直接执行的落点。
 * 返回 { ok:true, nodeId, position } 或 { ok:false, code }。
 * 不修改任何传入对象。
 */
function resolvePlacement({ nodes, employee, position, employeeIds = null, isTaskBound = false } = {}) {
  if (!employee) return { ok: false, code: 'UNKNOWN_EMPLOYEE' };
  if (employeeIds && Array.isArray(employeeIds) && !employeeIds.includes(employee.employeeId)) {
    return { ok: false, code: 'UNKNOWN_EMPLOYEE' };
  }
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    return { ok: false, code: 'BAD_POSITION' };
  }
  // 任务中的角色不动：任务带座位/绑定语义，拖走会让"在工位工作"与位置脱节。
  if (isTaskBound) return { ok: false, code: 'TASK_BOUND' };
  const node = nearestNode(nodes, position);
  if (!node) return { ok: false, code: 'NO_NODE' };
  return { ok: true, nodeId: node.id, position: node.position };
}

module.exports = { nearestNode, resolvePlacement };

/**
 * 校验 office:place 的 IPC 载荷（与其他 office:* 同样的白名单式校验）。
 * 只接受 employeeId + 归一化场景坐标 (0..1)；多余键一律拒绝。
 */
function validatePlacePayload(payload, keys, employeeIds) {
  const pos = payload && payload.position;
  const ok = Array.isArray(keys)
    && keys.length === 2
    && keys.includes('employeeId') && keys.includes('position')
    && typeof payload.employeeId === 'string'
    && (!employeeIds || employeeIds.includes(payload.employeeId))
    && pos !== null && typeof pos === 'object' && !Array.isArray(pos)
    && Object.keys(pos).length === 2
    && Number.isFinite(pos.x) && Number.isFinite(pos.y)
    && pos.x >= 0 && pos.x <= 1 && pos.y >= 0 && pos.y <= 1;
  if (!ok) return { ok: false, code: 'PAYLOAD_INVALID' };
  return { ok: true, value: { employeeId: payload.employeeId, position: { x: pos.x, y: pos.y } } };
}

module.exports = { nearestNode, resolvePlacement, validatePlacePayload };
