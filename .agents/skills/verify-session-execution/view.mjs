export const title = '会话 Inbox 调度与失败重试';
export const state = v => {
  if (v.invalidStart) return '错误：Stop 后仍提交输入';
  if (v.bDispatch > 1) return '错误：同一输入再次提交';
  if (v.aAttempted && !v.aRetry) return '错误：丢弃 A 的待重试记录';
  if (v.bConsumed && !v.bDispatch) return '错误：未执行就消费结果';
  if (v.bDispatch === 1 && !v.bReleased && !v.bActive) return '错误：旧释放清掉 B 的执行权';
  if (v.bDispatch) return v.bReleased ? 'B 已执行一次并归还执行权' : v.bBatch === 'unknown' ? 'B 的提交结果未知，禁止重放' : v.bConsumed ? 'B 的结果已记录，等待归还执行权' : 'B 已提交给 Agent';
  if (v.paused) return 'B 已停止，结果仍保留';
  if (v.bWorker) return 'B 的启动任务已派发';
  if (v.bActive) return 'B 已取得执行权，尚未提交';
  if (v.scanner === 'failed' && v.bIntent) return 'A 重试失败，本轮扫描提前结束';
  if (v.scanner === 'retry' && v.bIntent) return '调度器先重试 A';
  if (v.scanner === 'read' && v.bIntent) return '继续读取 B 的待执行输入';
  if (v.scanner === 'prepare' && v.bIntent) return '准备 B 的固定结果批次';
  if (v.scanner === 'launch') return 'B 等待启动任务派发';
  if (v.bIntent) return 'B 已有可执行结果，等待调度';
  if (v.aReleased) return 'A 已归还执行权，失败记录仍需重试';
  return v.aAttempted ? 'A 状态写入失败，原记录保留' : 'A 的原始输入已提交';
};
const labels = {
  RecordASettlement:'A 的提交状态写入失败', ReleaseA:'A 归还执行权', BResultArrives:'B 收到可自动处理的结果',
  Wake:'收到新的调度唤醒', TakeWake:'开始一轮扫描', RetryReceipts:'重试已有状态记录',
  ReadPending:'读取待执行输入', PrepareBatch:'冻结这一批结果', LaunchWorker:'派发 B 的启动任务',
  BeginB:'B 取得独占执行权', RejectWorker:'过期或已停止的启动被拒绝', SubmitB:'通过最后检查后提交给 Agent',
  SettleB:'记录 B 已完成', UnknownB:'记录 B 的提交结果未知', ReleaseB:'B 归还执行权',
  StopB:'用户按下 Stop', ReleaseStoppedB:'取消未提交的执行并保留结果', EndWorker:'B 的启动任务结束', EndFailedScan:'报告错误，等待下一次唤醒', Idle:'等待外部事件'
};
export const step = (action, from, to) => action === 'RetryReceipts' ? to.scanner === 'failed' ? 'A 的写入仍失败，跳过本轮其余工作' : to.aRetry ? 'A 的写入仍失败，保留记录并继续扫描' : '旧状态记录重试成功' : labels[action] ?? action;
