// Keep every model value visible for full-state liveness-loop diagnostics.
// The concise view.mjs is reserved for the restricted user-facing chart profiles.
import { step } from './view.mjs';
export { step };
export const title = '会话 Inbox 完整模型状态诊断';
const names = {
  aAttempted:'A已尝试写入',aRetry:'A保留重试',aReleased:'A已归还执行权',aFailureObserved:'已观察到A重试失败',
  bArrived:'B结果已到达',bIntent:'B待执行意图',bBatch:'B批次阶段',bWorker:'B启动任务待接纳',bRunning:'B启动任务存活',
  bActive:'B持有执行权',bDispatch:'B提交次数',bConsumed:'B结果已消费',bReleased:'B已归还执行权',
  paused:'B已暂停',stopUsed:'已收到Stop',scanner:'调度器阶段',wake:'排队唤醒',readFoundB:'本轮已读到B',invalidStart:'发生停止后提交'
};
const labels = {true:'是',false:'否',none:'无',prepared:'已准备',submitting:'已开始提交',settled:'已完成记录',unknown:'提交结果未知',superseded:'已被替代',waiting:'等待唤醒',retry:'重试旧记录',read:'读取待执行输入',prepare:'准备批次',launch:'派发启动任务',failed:'本轮重试失败'};
export const state = vars => Object.entries(vars).map(([key,value]) => `${names[key]} ${labels[value] ?? value}`).join(' / ');
