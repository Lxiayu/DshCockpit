// src/companion-preload.js — Companion 小窗的 IPC 桥（P2.4 S2）。
//
// 第一性原理：这个桥必须极小
//
//   Companion 是**常驻**窗口。它暴露的每一个方法都是长期攻击面。
//   所以只给它三件事：
//     · onState(cb)   接收已派生的状态（数字，无正文）
//     · onLanguage(cb) 跟随语言切换
//     · expand()      请求展开完整办公室
//
//   它拿不到：office:dispatch / office:pending / mission:* / settings:*
//   —— 常驻小窗不需要那些能力，给了就是多余的风险。
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 主进程推来的最后一个状态（供语言切换时重绘，避免闪烁）。 */
let lastState = { kind: 'disconnected' };

contextBridge.exposeInMainWorld('companionBridge', {
  onState: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('companion:state', (_e, state) => {
      lastState = state || { kind: 'disconnected' };
      cb(lastState);
    });
  },
  lastState: () => lastState,
  onLanguage: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('companion:language', (_e, lang) => cb(lang));
  },
  // 展开完整办公室。**唯一**的写操作，且它的语义是"打开窗口"，
  // 不是"改应用状态"。
  expand: () => ipcRenderer.invoke('companion:expand'),
});
