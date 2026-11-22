export const title='共享数据库写锁与限次退避';
export const state=v=>{if(v.busyWaits>1)return '同轮再次阻塞事件循环';if(v.phase==='closed')return '作用域结束，取消重试';if(v.pending.length===0)return '原记录已处理完';if(v.phase==='backoff')return v.direct?'退避期间新输入仍可提交':'保留原记录，异步退避';if(v.phase==='scanning')return v.locked?'尝试共享数据库写入':'写锁已解除，继续处理';return '等待扫描唤醒';};
export const step=a=>({Begin:'收到扫描唤醒',DoWrite:'写入成功或收到 BUSY',Retry:'退避到期，重新尝试',Unlock:'其他进程释放写锁',DirectInput:'接纳新的显式输入',Close:'关闭原作用域',Done:'完成'})[a]??a;
