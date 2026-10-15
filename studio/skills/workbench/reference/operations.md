# 代理可用的操作（由 `node studio/bin/agent.js capabilities --md` 生成，勿手改）

## scene

| op | 作用 | 走的服务 | 参数示例 |
|---|---|---|---|
| `move` | 把一件家具移到新位置（归一化 0..1） | `sceneEdit` | `{"itemId":"draft-27","position":{"x":0.4,"y":0.5}}` |
| `scale` | 改一件家具的缩放（0.2–3） | `sceneEdit` | `{"itemId":"draft-27","scale":1.1}` |
| `hide` | 隐藏/显示一件家具（仍留在草稿里） | `sceneEdit` | `{"itemId":"draft-27","hidden":true}` |
| `add` | 放进一件家具（素材库 id，如 flat-sofa） | `sceneEdit` | `{"asset":"flat-sofa","position":{"x":0.5,"y":0.5}}` |
| `remove` | 从布局里删掉一件家具 | `sceneEdit` | `{"itemId":"draft-72"}` |
| `sync-zones` | 按当前布局重建碰撞区（改了布局后必须） | `sceneSyncZones` | `{"write":true}` |

## action

| op | 作用 | 走的服务 | 参数示例 |
|---|---|---|---|
| `reorder` | 把某帧移到新位置（帧序＝数组顺序） | `tool.actionOp` | `{"actionId":"walk-left","from":2,"to":0}` |
| `duration` | 改某帧的时长（ms；留空＝包默认） | `tool.actionOp` | `{"actionId":"walk-left","index":3,"durationMs":120}` |
| `tag` | 加/去一个标签（如 walk / highlight） | `actionTag` | `{"actionId":"walk-left","tag":"walk","remove":false}` |
| `pingpong` | 开/关 ping-pong 循环 | `actionPingPong` | `{"actionId":"walk-left","pingPong":true}` |
| `note` | 按帧号加一条批注（绑定帧；帧序变了会标失效） | `actionNoteAdd` | `{"actionId":"walk-left","frame":2,"text":"裙摆被裁","severity":"fix"}` |

## dialogue

| op | 作用 | 走的服务 | 参数示例 |
|---|---|---|---|
| `add` | 加一条台词（层：base | character） | `dialogueEdit` | `{"topic":"pantry","text":"米缸还有半缸","weight":2}` |
| `update` | 改一条台词（按 id） | `dialogueEdit` | `{"id":"zz-01","text":"新的台词","weight":3}` |
| `remove` | 删一条台词（按 id） | `dialogueEdit` | `{"id":"zz-01"}` |

## graph

| op | 作用 | 走的服务 | 参数示例 |
|---|---|---|---|
| `move-node` | 改一个节点的版面位置（只影响画布摆放） | `graphMoveNode` | `{"file":"local-behaviour.vgraph.json","nodeId":"beat","x":0.2,"y":0.3}` |
| `save` | 写一个图文件（先过校验：闭集/端口/环） | `graphSave` | `{"file":"local-behaviour.vgraph.json","graph":{"schemaVersion":1,"nodes":[],"edges":[]}}` |

> `diff` 用同样的参数做一次**试算**（不写盘），`apply` 校验通过才写（先做字节备份）。

