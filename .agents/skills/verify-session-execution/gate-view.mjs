export const title='回复写入等待与限时放行';
export const state=v=>{
 if(v.phase==='waiting')return '等待用户正文，原始期限仍在计时';
 if(v.phase==='opening')return '正文已到，回复条目写入仍在等待';
 if(v.disposed)return '旧输入已结束，等待已解除';
 if(v.output)return '回复写入可以继续';
 if(v.hook==='waiting')return '到达期限，放行回复并取消旧回调';
 return '回复条目已准备，后续写入已放行';
};
const labels={ObserveHistory:'用户正文同步到达',Deadline:'原始期限到达',HookCompletes:'旧回调返回，取消后的写入不再继续',Dispose:'结束旧输入',WriteOutput:'继续回复写入',Done:'完成'};
export const step=action=>labels[action]??action;
